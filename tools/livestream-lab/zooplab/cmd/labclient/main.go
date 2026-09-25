// labclient is a pion-based test viewer for zooplab. It plays a stream
// through the Ant Media WebSocket emulator (default) or through the WHEP
// relay (-whep URL), and prints per-second receive statistics.
package main

import (
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

type options struct {
	ws             string
	stream         string
	seconds        float64
	toggleVideoAt  float64
	toggleVideoFor float64
	stopAt         float64
	infoAt         float64
	whep           string
	lab            string
	at             string
	ping           time.Duration
	localIP        string
	verbose        bool
}

var (
	startTime = time.Now()
	logMu     sync.Mutex
)

func logf(format string, args ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	fmt.Printf("[+%6.2fs] %s\n", time.Since(startTime).Seconds(), fmt.Sprintf(format, args...))
}

func main() {
	o := &options{}
	flag.StringVar(&o.ws, "ws", "ws://127.0.0.1:5080/live/websocket", "Ant Media WebSocket URL")
	flag.StringVar(&o.stream, "stream", "90001", "stream id to play")
	flag.Float64Var(&o.seconds, "seconds", 15, "run time in seconds")
	flag.Float64Var(&o.toggleVideoAt, "toggle-video-at", 0, "send toggleVideo enabled=false at this second (0 = never)")
	flag.Float64Var(&o.toggleVideoFor, "toggle-video-for", 5, "seconds until toggleVideo enabled=true is sent")
	flag.Float64Var(&o.stopAt, "stop-at", 0, "send stop at this second (0 = never)")
	flag.Float64Var(&o.infoAt, "info-at", 0, "send getStreamInfo at this second (0 = never)")
	flag.StringVar(&o.whep, "whep", "", "WHEP mode: endpoint URL, e.g. http://127.0.0.1:5080/whep/ams/90001")
	flag.StringVar(&o.lab, "lab", "http://127.0.0.1:5080", "zooplab base URL for -at preset actions")
	flag.StringVar(&o.at, "at", "", `timed actions, ';'-separated: "8=preset:outage;16=preset:clean;20=cmd:kill 123" (preset:<name>[@client])`)
	flag.DurationVar(&o.ping, "ping", 3*time.Second, "Ant Media ping interval (0 = off)")
	flag.StringVar(&o.localIP, "local-ip", "", "only gather host candidates on this local IP (default: all interfaces)")
	flag.BoolVar(&o.verbose, "v", false, "print full SDPs")
	flag.StringVar(&dumpPath, "dump", "", "write the received H.264, assembled from packets and resends, to this Annex B file")
	flag.Parse()
	startTime = time.Now()

	events, err := parseEvents(o)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if o.whep != "" {
		os.Exit(runWHEP(o, events))
	}
	os.Exit(runAMS(o, events))
}

// ---- timed actions ----

type event struct {
	at   time.Duration
	name string
	fn   func()
}

func parseEvents(o *options) ([]*event, error) {
	var evs []*event
	for _, part := range strings.Split(o.at, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		secStr, action, ok := strings.Cut(part, "=")
		if !ok {
			return nil, fmt.Errorf("bad -at entry %q", part)
		}
		sec, err := strconv.ParseFloat(strings.TrimSpace(secStr), 64)
		if err != nil {
			return nil, fmt.Errorf("bad -at time %q", secStr)
		}
		kind, arg, _ := strings.Cut(action, ":")
		switch kind {
		case "preset":
			name, client, _ := strings.Cut(arg, "@")
			evs = append(evs, &event{at: dur(sec), name: action, fn: func() { setPreset(o.lab, name, client) }})
		case "cmd":
			evs = append(evs, &event{at: dur(sec), name: action, fn: func() { runCmd(arg) }})
		default:
			return nil, fmt.Errorf("bad -at action %q (want preset:<name> or cmd:<shell>)", action)
		}
	}
	sort.Slice(evs, func(i, j int) bool { return evs[i].at < evs[j].at })
	return evs, nil
}

func dur(sec float64) time.Duration { return time.Duration(sec * float64(time.Second)) }

func setPreset(lab, name, client string) {
	q := url.Values{"preset": {name}}
	if client != "" {
		q.Set("client", client)
	}
	resp, err := http.Post(strings.TrimRight(lab, "/")+"/lab/link?"+q.Encode(), "application/json", nil)
	if err != nil {
		logf("ACTION preset %s: %v", name, err)
		return
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	logf("ACTION preset %s%s -> HTTP %d", name, map[bool]string{true: "@" + client, false: ""}[client != ""], resp.StatusCode)
}

func runCmd(cmd string) {
	out, err := exec.Command("sh", "-c", cmd).CombinedOutput()
	logf("ACTION cmd %q -> err=%v %s", cmd, err, strings.TrimSpace(string(out)))
}

// runDue runs the events whose time has come.
func runDue(evs []*event, elapsed time.Duration) []*event {
	for len(evs) > 0 && evs[0].at <= elapsed {
		go evs[0].fn()
		evs = evs[1:]
	}
	return evs
}

// newAPI builds a pion API like a typical client: default codecs and
// interceptors (NACK generator, RTCP reports, TWCC feedback). With localIP
// set, host candidates are limited to that address.
func newAPI(localIP string) (*webrtc.API, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return nil, err
	}
	se := webrtc.SettingEngine{}
	if localIP != "" {
		want := net.ParseIP(localIP)
		if want == nil {
			return nil, fmt.Errorf("bad -local-ip %q", localIP)
		}
		se.SetIPFilter(func(ip net.IP) bool { return ip.Equal(want) })
		se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se)), nil
}
