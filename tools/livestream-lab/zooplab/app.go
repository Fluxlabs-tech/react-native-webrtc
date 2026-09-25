package main

// Telemetry and remote control for the React Native example app in test
// mode: GET /lab/app?device=<name> (WebSocket), POST /lab/open, GET /lab/devices.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type appConn struct {
	device  string
	remote  string
	since   time.Time
	ws      *websocket.Conn
	wmu     sync.Mutex
	msgs    atomic.Uint64
	lastMsg atomic.Int64
}

func (c *appConn) writeJSON(v any) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return c.ws.WriteJSON(v)
}

type appHub struct {
	logsDir  string
	upgrader websocket.Upgrader

	mu    sync.Mutex
	conns map[*appConn]struct{}
	fmu   sync.Mutex // serialises appends to the jsonl files
}

func newAppHub(logsDir string) *appHub {
	return &appHub{
		logsDir:  logsDir,
		upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
		conns:    map[*appConn]struct{}{},
	}
}

var unsafeFileChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func safeDeviceName(s string) string {
	s = strings.Trim(unsafeFileChars.ReplaceAllString(s, "_"), "._")
	if s == "" {
		return "unknown"
	}
	return s
}

func (h *appHub) appendLog(device string, rec []byte) {
	h.fmu.Lock()
	defer h.fmu.Unlock()
	f, err := os.OpenFile(filepath.Join(h.logsDir, "app-"+safeDeviceName(device)+".jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		log.Printf("[app %s] log file: %v", device, err)
		return
	}
	defer f.Close()
	_, _ = f.Write(append(rec, '\n'))
}

// handleWS serves GET /lab/app?device=<name>.
func (h *appHub) handleWS(w http.ResponseWriter, r *http.Request) {
	device := r.URL.Query().Get("device")
	if device == "" {
		device = r.RemoteAddr
	}
	ws, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[app] upgrade from %s failed: %v", r.RemoteAddr, err)
		return
	}
	c := &appConn{device: device, remote: r.RemoteAddr, since: time.Now(), ws: ws}
	h.mu.Lock()
	h.conns[c] = struct{}{}
	h.mu.Unlock()
	log.Printf("[app %s] connected from %s", device, r.RemoteAddr)
	defer func() {
		h.mu.Lock()
		delete(h.conns, c)
		h.mu.Unlock()
		_ = ws.Close()
		log.Printf("[app %s] disconnected after %.0fs, %d messages", device, time.Since(c.since).Seconds(), c.msgs.Load())
	}()
	ws.SetReadLimit(4 << 20)
	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		now := time.Now()
		c.msgs.Add(1)
		c.lastMsg.Store(now.UnixNano())
		rec := map[string]any{"recvTs": now.Format(time.RFC3339Nano), "device": device}
		var msg map[string]any
		if json.Valid(data) {
			rec["msg"] = json.RawMessage(data)
			_ = json.Unmarshal(data, &msg)
		} else {
			rec["raw"] = string(data)
		}
		if b, err := json.Marshal(rec); err == nil {
			h.appendLog(device, b)
		}
		if msg != nil && msg["type"] == "stats" {
			log.Printf("[app %s] %s", device, statsLine(msg))
		}
	}
}

// ---- defensive accessors for the stats line ----

func dig(m any, path ...string) any {
	for _, k := range path {
		mm, ok := m.(map[string]any)
		if !ok {
			return nil
		}
		m = mm[k]
	}
	return m
}

func numAt(m any, path ...string) (float64, bool) {
	switch v := dig(m, path...).(type) {
	case float64:
		return v, true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	}
	return 0, false
}

func fmtNum(m any, format string, path ...string) string {
	if v, ok := numAt(m, path...); ok {
		return fmt.Sprintf(format, v)
	}
	return "-"
}

func strAt(m any, path ...string) string {
	switch v := dig(m, path...).(type) {
	case string:
		return v
	case nil:
		return "-"
	default:
		return fmt.Sprint(v)
	}
}

// statsLine renders one compact line; every field may be missing or null.
func statsLine(msg map[string]any) string {
	st := dig(msg, "stats")
	v := dig(st, "inbound", "video")
	a := dig(st, "inbound", "audio")
	size := "-"
	if w, ok := numAt(v, "width"); ok {
		if hgt, ok := numAt(v, "height"); ok {
			size = fmt.Sprintf("%.0fx%.0f", w, hgt)
		}
	}
	return fmt.Sprintf("stats state=%s quality=%s rtt=%sms availIn=%skbps | video %s %sfps %skbps loss=%s%% jb=%sms freeze=%s/%ss | audio %skbps loss=%s%% concealed=%s%% jb=%sms",
		strAt(msg, "state"), strAt(msg, "quality"),
		fmtNum(st, "%.0f", "rttMs"), fmtNum(st, "%.0f", "availableIncomingKbps"),
		size, fmtNum(v, "%.1f", "fps"), fmtNum(v, "%.0f", "kbps"), fmtNum(v, "%.1f", "lossPercent"),
		fmtNum(v, "%.0f", "jitterBufferMs"), fmtNum(v, "%.0f", "freezeCount"), fmtNum(v, "%.1f", "freezeSeconds"),
		fmtNum(a, "%.0f", "kbps"), fmtNum(a, "%.1f", "lossPercent"), fmtNum(a, "%.1f", "concealedPercent"),
		fmtNum(a, "%.0f", "jitterBufferMs"))
}

// handleOpen serves POST /lab/open?device=<name>&url=<url>.
func (h *appHub) handleOpen(w http.ResponseWriter, r *http.Request) {
	u := r.URL.Query().Get("url")
	if u == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "url is required"})
		return
	}
	device := r.URL.Query().Get("device")
	h.mu.Lock()
	var targets []*appConn
	for c := range h.conns {
		if device == "" || c.device == device {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()
	if len(targets) == 0 {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "no matching device connected", "device": device})
		return
	}
	var sent []string
	for _, c := range targets {
		if err := c.writeJSON(map[string]string{"type": "open", "url": u}); err != nil {
			log.Printf("[app %s] open failed: %v", c.device, err)
			continue
		}
		sent = append(sent, c.device)
	}
	log.Printf("[app] open %s -> %v", u, sent)
	writeJSON(w, http.StatusOK, map[string]any{"sentTo": sent, "url": u})
}

type deviceView struct {
	Device        string    `json:"device"`
	Remote        string    `json:"remote"`
	ConnectedAt   time.Time `json:"connectedAt"`
	Messages      uint64    `json:"messages"`
	LastMsgAgoSec *float64  `json:"lastMessageAgoSec"`
}

// handleDevices serves GET /lab/devices.
func (h *appHub) handleDevices(w http.ResponseWriter, _ *http.Request) {
	h.mu.Lock()
	out := make([]deviceView, 0, len(h.conns))
	for c := range h.conns {
		dv := deviceView{Device: c.device, Remote: c.remote, ConnectedAt: c.since, Messages: c.msgs.Load()}
		if t := c.lastMsg.Load(); t != 0 {
			ago := round1(time.Since(time.Unix(0, t)).Seconds())
			dv.LastMsgAgoSec = &ago
		}
		out = append(out, dv)
	}
	h.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Device < out[j].Device })
	writeJSON(w, http.StatusOK, out)
}
