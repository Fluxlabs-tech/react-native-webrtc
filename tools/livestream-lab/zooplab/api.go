package main

// Lab control API (/lab/link, /lab/ams) and the HTTP-side signalling hold.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type labAPI struct {
	link *Link
	ams  *amsServer
}

// clientParam returns the canonical client IP from ?client=, or "" for the default.
func (a *labAPI) clientParam(r *http.Request) (string, error) {
	c := strings.TrimSpace(r.URL.Query().Get("client"))
	if c == "" {
		return "", nil
	}
	return a.link.CanonIPString(c)
}

// handleLink serves GET/POST/DELETE /lab/link.
func (a *labAPI) handleLink(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, a.link.View())
	case http.MethodPost:
		client, err := a.clientParam(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		if name := r.URL.Query().Get("preset"); name != "" {
			if err := a.link.SetPreset(client, name); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error(), "presets": sortedKeys(presets), "schedules": sortedKeys(schedules)})
				return
			}
			writeJSON(w, http.StatusOK, a.link.View())
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || len(bytes.TrimSpace(body)) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "need ?preset=<name> or a JSON body {\"down\":{...},\"up\":{...}}"})
			return
		}
		var p Profile
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&p); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad JSON: " + err.Error()})
			return
		}
		if err := p.normalize(); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		a.link.SetProfile(client, linkTarget{Name: "custom", Profile: p})
		writeJSON(w, http.StatusOK, a.link.View())
	case http.MethodDelete:
		client, err := a.clientParam(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		if client == "" {
			a.link.Reset()
		} else if !a.link.DeleteOverride(client) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "no override for " + client})
			return
		}
		writeJSON(w, http.StatusOK, a.link.View())
	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleAMS serves GET/POST/DELETE /lab/ams.
func (a *labAPI) handleAMS(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		def := strings.TrimSpace(r.URL.Query().Get("fail"))
		if def == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "fail=<definition> is required"})
			return
		}
		n := 1
		if s := r.URL.Query().Get("count"); s != "" {
			v, err := strconv.Atoi(s)
			if err != nil || v < 1 || v > 1000 {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "count must be 1..1000"})
				return
			}
			n = v
		}
		pending := a.ams.injectFailures(def, n)
		log.Printf("[lab] next %d play(s) will fail with %q (%d pending)", n, def, pending)
		writeJSON(w, http.StatusOK, map[string]any{"queued": n, "definition": def, "pending": pending})
	case http.MethodDelete:
		n := a.ams.clearFailures()
		log.Printf("[lab] cleared %d pending injected failure(s)", n)
		writeJSON(w, http.StatusOK, map[string]any{"cleared": n})
	case http.MethodGet:
		a.ams.mu.Lock()
		pending := append([]string(nil), a.ams.failures...)
		a.ams.mu.Unlock()
		sessions := []sessionView{}
		for _, s := range a.ams.sessionList() {
			sessions = append(sessions, s.view())
		}
		writeJSON(w, http.StatusOK, map[string]any{"pendingFailures": pending, "sessions": sessions})
	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// holdDuringOutage holds new HTTP requests (including WebSocket upgrades)
// from a client IP that is in outage, for up to 30 s, like TCP would. After
// 30 s the connection is dropped. /lab/ is never held.
func holdDuringOutage(link *Link, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/lab/") {
			next.ServeHTTP(w, r)
			return
		}
		ip, err := link.CanonIPString(r.RemoteAddr)
		if err == nil && link.InOutage(ip) {
			start := time.Now()
			log.Printf("[hold] %s %s from %s held: client in outage", r.Method, r.URL.Path, r.RemoteAddr)
			if !link.WaitNoOutage(ip, r.Context().Done(), 30*time.Second) {
				log.Printf("[hold] %s %s from %s dropped after %.1fs", r.Method, r.URL.Path, r.RemoteAddr, time.Since(start).Seconds())
				if hj, ok := w.(http.Hijacker); ok {
					if conn, _, err := hj.Hijack(); err == nil {
						_ = conn.Close()
						return
					}
				}
				http.Error(w, "outage", http.StatusGatewayTimeout)
				return
			}
			log.Printf("[hold] %s %s from %s released after %.1fs", r.Method, r.URL.Path, r.RemoteAddr, time.Since(start).Seconds())
		}
		next.ServeHTTP(w, r)
	})
}

const indexText = `zooplab: Ant Media playback stand-in + network impairment emulator

Ant Media play     GET  /{app}/websocket          (e.g. ws://%[1]s:%[2]s/live/websocket)
WHEP via relay     POST /whep/{path...}           POST /live/whep/{id} (= /whep/ams/{id})
                   DELETE /whep-session/...       PATCH /whep-session/... (204, not forwarded)
Link control       GET  /lab/link
                   POST /lab/link?preset=<name>[&client=<ip>]
                   POST /lab/link[?client=<ip>]   body {"down":{...},"up":{...}}
                   DELETE /lab/link?client=<ip>   (no client: reset everything to clean)
Error injection    POST /lab/ams?fail=<definition>[&count=N]   GET /lab/ams   DELETE /lab/ams
App telemetry      GET  /lab/app?device=<name>    (WebSocket)
                   POST /lab/open?device=<name>&url=<url>      GET /lab/devices

Presets:   %[3]s
Schedules: %[4]s
`

func indexHandler(cfg *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		_, port, _ := strings.Cut(cfg.HTTP, ":")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, indexText, cfg.MediaIP, port, strings.Join(sortedKeys(presets), ", "), strings.Join(sortedKeys(schedules), ", "))
	}
}
