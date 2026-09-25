// zooplab: a local stand-in for Ant Media Server playback (WebSocket
// signalling, server offers) fed by mediamtx over WHEP, plus a network
// impairment emulator, a WHEP relay for comparison, and app telemetry.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

type Config struct {
	HTTP        string
	MediaIP     string
	AMSUDP      int
	RelayUDP    int
	MediaMTX    string
	MediaMTXAPI string
	MediaMTXICE string
	Logs        string
}

func main() {
	cfg := &Config{}
	flag.StringVar(&cfg.HTTP, "http", ":5080", "HTTP/WebSocket listen address")
	flag.StringVar(&cfg.MediaIP, "media-ip", "127.0.0.1", "IP advertised in ICE candidates: this computer's LAN address, for phones")
	flag.IntVar(&cfg.AMSUDP, "ams-udp", 50000, "UDP port of the Ant Media emulator's impaired ICE mux")
	flag.IntVar(&cfg.RelayUDP, "relay-udp", 9189, "UDP port of the impaired WHEP relay")
	flag.StringVar(&cfg.MediaMTX, "mediamtx", "http://127.0.0.1:8889", "mediamtx WebRTC (WHEP) base URL")
	flag.StringVar(&cfg.MediaMTXAPI, "mediamtx-api", "http://127.0.0.1:9997", "mediamtx API base URL")
	flag.StringVar(&cfg.MediaMTXICE, "mediamtx-ice", "127.0.0.1:8189", "mediamtx ICE UDP address (relay target and upstream candidate)")
	flag.StringVar(&cfg.Logs, "logs", "./logs", "directory for app-<device>.jsonl files")
	flag.Parse()

	log.SetOutput(os.Stdout)
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if err := os.MkdirAll(cfg.Logs, 0o755); err != nil {
		log.Fatalf("logs dir: %v", err)
	}
	if net.ParseIP(cfg.MediaIP).To4() == nil {
		log.Fatalf("-media-ip must be an IPv4 address")
	}
	iceHost, icePortStr, err := net.SplitHostPort(cfg.MediaMTXICE)
	if err != nil {
		log.Fatalf("-mediamtx-ice: %v", err)
	}
	icePort, err := strconv.Atoi(icePortStr)
	if err != nil {
		log.Fatalf("-mediamtx-ice port: %v", err)
	}

	lf := logging.NewDefaultLoggerFactory()
	lf.DefaultLogLevel = logging.LogLevelWarn
	lf.Writer = os.Stdout

	link := NewLink(cfg.MediaIP)

	// Ant Media emulator: one impaired UDP socket shared by all viewers.
	amsSock, err := net.ListenUDP("udp4", &net.UDPAddr{Port: cfg.AMSUDP})
	if err != nil {
		log.Fatalf("ams udp :%d: %v", cfg.AMSUDP, err)
	}
	amsConn := newImpairedConn(amsSock, link, "ams")
	mux := webrtc.NewICEUDPMux(lf.NewLogger("ice-mux"), amsConn)
	ams := newAMSServer(cfg, link, mux, lf)
	ams.upstreamCandidate = hostCandidate(iceHost, icePort)

	rel, err := newRelay(link, cfg.RelayUDP, cfg.MediaMTXICE)
	if err != nil {
		log.Fatalf("relay udp :%d: %v", cfg.RelayUDP, err)
	}
	whep := newWHEPProxy(cfg)
	apps := newAppHub(cfg.Logs)
	lab := &labAPI{link: link, ams: ams}

	mx := http.NewServeMux()
	mx.HandleFunc("GET /{app}/websocket", ams.handleWS)
	mx.HandleFunc("POST /whep/{path...}", whep.handlePost)
	mx.HandleFunc("POST /live/whep/{id}", whep.handleLive)
	mx.HandleFunc("DELETE /whep-session/{rest...}", whep.handleSessionDelete)
	mx.HandleFunc("PATCH /whep-session/{rest...}", whep.handleSessionPatch)
	mx.HandleFunc("/lab/link", lab.handleLink)
	mx.HandleFunc("/lab/ams", lab.handleAMS)
	mx.HandleFunc("GET /lab/app", apps.handleWS)
	mx.HandleFunc("POST /lab/open", apps.handleOpen)
	mx.HandleFunc("GET /lab/devices", apps.handleDevices)
	mx.HandleFunc("GET /{$}", indexHandler(cfg))

	srv := &http.Server{
		Addr:              cfg.HTTP,
		Handler:           holdDuringOutage(link, mx),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ln, err := net.Listen("tcp", cfg.HTTP)
	if err != nil {
		log.Fatalf("http %s: %v", cfg.HTTP, err)
	}

	log.Printf("zooplab started (pid %d)", os.Getpid())
	log.Printf("  HTTP/WS        %s  (Ant Media: ws://%s%s/live/websocket)", cfg.HTTP, cfg.MediaIP, portSuffix(cfg.HTTP))
	log.Printf("  AMS ICE mux    udp 0.0.0.0:%d, advertised %s:%d (impaired)", cfg.AMSUDP, cfg.MediaIP, cfg.AMSUDP)
	log.Printf("  WHEP relay     udp 0.0.0.0:%d -> %s (impaired)", cfg.RelayUDP, cfg.MediaMTXICE)
	log.Printf("  mediamtx       WHEP %s, API %s", cfg.MediaMTX, cfg.MediaMTXAPI)
	log.Printf("  link           default profile clean")

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	s := <-sig
	log.Printf("received %s: shutting down", s)
	ams.closeAll("shutdown")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	rel.Close()
	_ = mux.Close()
	log.Printf("bye")
}

func portSuffix(addr string) string {
	_, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		return ""
	}
	return fmt.Sprintf(":%s", port)
}
