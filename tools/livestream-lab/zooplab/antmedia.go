package main

// Ant Media Server WebSocket play emulator: GET /{app}/websocket.
// The server makes the offer; see session.go for the media side.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

// ---- messages ----

type amsIn struct {
	Command   string          `json:"command"`
	StreamID  flexString      `json:"streamId"`
	Type      string          `json:"type"`
	SDP       string          `json:"sdp"`
	Label     json.RawMessage `json:"label"`
	ID        flexString      `json:"id"`
	Candidate string          `json:"candidate"`
	TrackID   json.RawMessage `json:"trackId"`
	Enabled   json.RawMessage `json:"enabled"`
}

type msgCommand struct {
	Command string `json:"command"`
}

type msgNotify struct {
	Command    string `json:"command"`
	Definition string `json:"definition"`
	StreamID   string `json:"streamId"`
}

type msgTakeConfiguration struct {
	Command  string `json:"command"`
	StreamID string `json:"streamId"`
	Type     string `json:"type"`
	SDP      string `json:"sdp"`
}

type msgTakeCandidate struct {
	Command   string `json:"command"`
	StreamID  string `json:"streamId"`
	Label     int    `json:"label"`
	ID        string `json:"id"`
	Candidate string `json:"candidate"`
}

type msgBitrate struct {
	Command       string `json:"command"`
	Definition    string `json:"definition"`
	StreamID      string `json:"streamId"`
	TargetBitrate int    `json:"targetBitrate"`
	VideoBitrate  int    `json:"videoBitrate"`
	AudioBitrate  int    `json:"audioBitrate"`
}

type streamInfoEntry struct {
	StreamWidth  int    `json:"streamWidth"`
	StreamHeight int    `json:"streamHeight"`
	VideoBitrate int    `json:"videoBitrate"`
	AudioBitrate int    `json:"audioBitrate"`
	VideoCodec   string `json:"videoCodec"`
}

type msgStreamInfo struct {
	Command    string            `json:"command"`
	StreamID   string            `json:"streamId"`
	StreamInfo []streamInfoEntry `json:"streamInfo"`
}

// ---- server ----

type amsServer struct {
	cfg      *Config
	link     *Link
	mux      ice.UDPMux
	pionLF   logging.LoggerFactory
	upgrader websocket.Upgrader
	connSeq  atomic.Uint64

	// upstreamCandidate replaces mediamtx's answer candidates so the upstream
	// stays on loopback (-mediamtx-ice).
	upstreamCandidate string

	mu       sync.Mutex
	conns    map[*amsConn]struct{}
	sessions map[*playSession]struct{}
	failures []string
}

func newAMSServer(cfg *Config, link *Link, mux ice.UDPMux, lf logging.LoggerFactory) *amsServer {
	return &amsServer{
		cfg:    cfg,
		link:   link,
		mux:    mux,
		pionLF: lf,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  32 << 10,
			WriteBufferSize: 32 << 10,
			CheckOrigin:     func(*http.Request) bool { return true },
		},
		conns:    map[*amsConn]struct{}{},
		sessions: map[*playSession]struct{}{},
	}
}

// injectFailures queues n error replies for the next plays.
func (a *amsServer) injectFailures(def string, n int) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := 0; i < n; i++ {
		a.failures = append(a.failures, def)
	}
	return len(a.failures)
}

func (a *amsServer) clearFailures() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := len(a.failures)
	a.failures = nil
	return n
}

func (a *amsServer) takeFailure() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.failures) == 0 {
		return ""
	}
	def := a.failures[0]
	a.failures = a.failures[1:]
	return def
}

// pathInfo is the part of mediamtx's /v3/paths/get response we use.
type pathInfo struct {
	Ready   bool     `json:"ready"`
	Tracks  []string `json:"tracks"`
	Tracks2 []struct {
		Codec      string `json:"codec"`
		CodecProps struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"codecProps"`
	} `json:"tracks2"`
}

func (p *pathInfo) videoSize() (int, int) {
	for _, t := range p.Tracks2 {
		if t.CodecProps.Width > 0 && t.CodecProps.Height > 0 {
			return t.CodecProps.Width, t.CodecProps.Height
		}
	}
	return 720, 1280
}

// getPath returns (nil, nil) when the path does not exist.
func (a *amsServer) getPath(ctx context.Context, name string) (*pathInfo, error) {
	u := strings.TrimRight(a.cfg.MediaMTXAPI, "/") + "/v3/paths/get/" + name
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("mediamtx API %s: %s", u, resp.Status)
	}
	var pi pathInfo
	if err := json.NewDecoder(resp.Body).Decode(&pi); err != nil {
		return nil, err
	}
	return &pi, nil
}

func amsPath(streamID string) string { return "ams/" + url.PathEscape(streamID) }

func (a *amsServer) register(s *playSession) {
	a.mu.Lock()
	a.sessions[s] = struct{}{}
	a.mu.Unlock()
}

func (a *amsServer) unregister(s *playSession) {
	a.mu.Lock()
	delete(a.sessions, s)
	a.mu.Unlock()
}

func (a *amsServer) sessionList() []*playSession {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]*playSession, 0, len(a.sessions))
	for s := range a.sessions {
		out = append(out, s)
	}
	return out
}

// closeAll ends every session and socket (used at shutdown).
func (a *amsServer) closeAll(reason string) {
	for _, s := range a.sessionList() {
		s.finish(reason, false)
	}
	a.mu.Lock()
	conns := make([]*amsConn, 0, len(a.conns))
	for c := range a.conns {
		conns = append(conns, c)
	}
	a.mu.Unlock()
	for _, c := range conns {
		c.close(reason)
	}
}

// handleWS serves GET /{app}/websocket. Query parameters are ignored.
func (a *amsServer) handleWS(w http.ResponseWriter, r *http.Request) {
	ws, err := a.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] upgrade from %s failed: %v", r.RemoteAddr, err)
		return
	}
	ip, _ := a.link.CanonIPString(r.RemoteAddr)
	c := &amsConn{
		srv:      a,
		ws:       ws,
		id:       a.connSeq.Add(1),
		ip:       ip,
		remote:   r.RemoteAddr,
		app:      r.PathValue("app"),
		out:      newMsgQueue(),
		done:     make(chan struct{}),
		sessions: map[string]*playSession{},
	}
	c.tag = fmt.Sprintf("[ws c%d %s]", c.id, c.remote)
	a.mu.Lock()
	a.conns[c] = struct{}{}
	a.mu.Unlock()
	log.Printf("%s connected app=%s path=%s (profile ip %s)", c.tag, c.app, r.URL.RequestURI(), ip)
	go c.writeLoop()
	c.readLoop()
}

// ---- per-socket state ----

type amsConn struct {
	srv    *amsServer
	ws     *websocket.Conn
	id     uint64
	ip     string // canonical client IP (for the outage hold)
	remote string
	app    string
	tag    string
	out    *msgQueue
	done   chan struct{}

	closeOnce sync.Once
	mu        sync.Mutex
	sessions  map[string]*playSession
}

// msgQueue is an unbounded FIFO so senders never block on a held socket.
type msgQueue struct {
	mu     sync.Mutex
	items  [][]byte
	signal chan struct{}
}

func newMsgQueue() *msgQueue { return &msgQueue{signal: make(chan struct{}, 1)} }

func (q *msgQueue) push(b []byte) {
	q.mu.Lock()
	q.items = append(q.items, b)
	q.mu.Unlock()
	select {
	case q.signal <- struct{}{}:
	default:
	}
}

func (q *msgQueue) popAll() [][]byte {
	q.mu.Lock()
	defer q.mu.Unlock()
	items := q.items
	q.items = nil
	return items
}

func (q *msgQueue) len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

// send queues a JSON message. Writes are serialised by writeLoop.
func (c *amsConn) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("%s marshal: %v", c.tag, err)
		return
	}
	select {
	case <-c.done:
		return
	default:
	}
	c.out.push(b)
}

func (c *amsConn) sendNotify(def, streamID string) {
	log.Printf("%s -> notification %s streamId=%s", c.tag, def, streamID)
	c.send(msgNotify{Command: "notification", Definition: def, StreamID: streamID})
}

func (c *amsConn) sendError(def, streamID string) {
	log.Printf("%s -> error %s streamId=%s", c.tag, def, streamID)
	c.send(msgNotify{Command: "error", Definition: def, StreamID: streamID})
}

// writeLoop delivers queued frames; while the client is in outage they are
// held (as TCP would) and flushed in order when it ends.
func (c *amsConn) writeLoop() {
	for {
		select {
		case <-c.out.signal:
		case <-c.done:
			return
		}
		for _, m := range c.out.popAll() {
			if c.srv.link.InOutage(c.ip) {
				held := time.Now()
				log.Printf("%s outage: holding outbound frames (%d queued)", c.tag, 1+c.out.len())
				if !c.srv.link.WaitNoOutage(c.ip, c.done, 0) {
					return
				}
				log.Printf("%s outage over after %.1fs: flushing outbound frames", c.tag, time.Since(held).Seconds())
			}
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.ws.WriteMessage(websocket.TextMessage, m); err != nil {
				go c.close("write error: " + err.Error())
				return
			}
		}
	}
}

func (c *amsConn) readLoop() {
	c.ws.SetReadLimit(1 << 20)
	reason := "closed by client"
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			reason = err.Error()
			break
		}
		if c.srv.link.InOutage(c.ip) {
			held := time.Now()
			log.Printf("%s outage: holding inbound frame", c.tag)
			if !c.srv.link.WaitNoOutage(c.ip, c.done, 0) {
				reason = "closed during outage"
				break
			}
			log.Printf("%s outage over after %.1fs: delivering inbound frames", c.tag, time.Since(held).Seconds())
		}
		c.handle(data)
	}
	c.close(reason)
}

// close ends every play session on the socket, as Ant Media does.
func (c *amsConn) close(reason string) {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.ws.Close()
		c.mu.Lock()
		sessions := make([]*playSession, 0, len(c.sessions))
		for _, s := range c.sessions {
			sessions = append(sessions, s)
		}
		c.mu.Unlock()
		for _, s := range sessions {
			s.finish("websocket closed", false)
		}
		c.srv.mu.Lock()
		delete(c.srv.conns, c)
		c.srv.mu.Unlock()
		log.Printf("%s disconnected (%s), %d session(s) closed", c.tag, reason, len(sessions))
	})
}

func (c *amsConn) session(streamID string) *playSession {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sessions[streamID]
}

func (c *amsConn) dropSession(s *playSession) {
	c.mu.Lock()
	if c.sessions[s.id] == s {
		delete(c.sessions, s.id)
	}
	c.mu.Unlock()
}

func (c *amsConn) handle(data []byte) {
	var m amsIn
	if err := json.Unmarshal(data, &m); err != nil {
		log.Printf("%s ignored malformed frame (%v): %.200s", c.tag, err, data)
		return
	}
	id := string(m.StreamID)
	switch m.Command {
	case "ping":
		c.send(msgCommand{Command: "pong"})
	case "play":
		log.Printf("%s <- play streamId=%s", c.tag, id)
		c.play(id)
	case "takeConfiguration":
		log.Printf("%s <- takeConfiguration streamId=%s type=%s (%d bytes sdp)", c.tag, id, m.Type, len(m.SDP))
		s := c.session(id)
		if s == nil {
			log.Printf("%s   no play session for %s; ignored", c.tag, id)
			return
		}
		if m.Type != "answer" {
			log.Printf("%s   only answers are expected in play mode; ignored", c.tag)
			return
		}
		s.setAnswer(m.SDP)
	case "takeCandidate":
		log.Printf("%s <- takeCandidate streamId=%s label=%s id=%s %s", c.tag, id, string(m.Label), m.ID, m.Candidate)
		s := c.session(id)
		if s == nil {
			log.Printf("%s   no play session for %s; ignored", c.tag, id)
			return
		}
		s.addRemoteCandidate(m.Candidate, string(m.ID), m.Label)
	case "toggleVideo":
		on, ok := rawBool(m.Enabled)
		log.Printf("%s <- toggleVideo streamId=%s trackId=%s enabled=%s", c.tag, id, string(m.TrackID), string(m.Enabled))
		s := c.session(id)
		if s == nil || !ok {
			log.Printf("%s   no play session for %s or bad 'enabled'; ignored", c.tag, id)
			return
		}
		s.setVideo(on)
	case "getStreamInfo":
		log.Printf("%s <- getStreamInfo streamId=%s", c.tag, id)
		c.streamInfo(id)
	case "stop":
		log.Printf("%s <- stop streamId=%s", c.tag, id)
		s := c.session(id)
		if s == nil {
			log.Printf("%s   no play session for %s; ignored", c.tag, id)
			return
		}
		s.finish("stop command", true)
	default:
		log.Printf("%s ignored command %q: %.200s", c.tag, m.Command, data)
	}
}

func (c *amsConn) play(id string) {
	if def := c.srv.takeFailure(); def != "" {
		log.Printf("%s   injected failure", c.tag)
		c.sendError(def, id)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pi, err := c.srv.getPath(ctx, amsPath(id))
	if err != nil {
		log.Printf("%s   mediamtx API error: %v", c.tag, err)
	}
	if pi == nil || !pi.Ready {
		c.sendError("no_stream_exist", id)
		return
	}
	c.mu.Lock()
	if _, ok := c.sessions[id]; ok {
		c.mu.Unlock()
		c.sendError("already_playing", id)
		return
	}
	s := newPlaySession(c, id, pi)
	c.sessions[id] = s
	c.mu.Unlock()
	c.srv.register(s)
	if err := s.start(ctx); err != nil {
		log.Printf("%s play setup failed: %v", s.tag, err)
		s.finish("setup failed", false)
		def := "server_error"
		if isNoStream(err) {
			def = "no_stream_exist"
		}
		c.sendError(def, id)
	}
}

func (c *amsConn) streamInfo(id string) {
	var src *playSession
	if s := c.session(id); s != nil {
		src = s
	} else {
		for _, s := range c.srv.sessionList() {
			if s.id == id {
				src = s
				break
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pi, _ := c.srv.getPath(ctx, amsPath(id))
	if pi == nil || !pi.Ready {
		c.sendError("no_stream_exist", id)
		return
	}
	w, h := pi.videoSize()
	entry := streamInfoEntry{StreamWidth: w, StreamHeight: h, VideoCodec: "h264"}
	if src != nil {
		entry.VideoBitrate, entry.AudioBitrate = src.inputBitrates()
	}
	log.Printf("%s -> streamInformation streamId=%s %dx%d video=%d audio=%d", c.tag, id, w, h, entry.VideoBitrate, entry.AudioBitrate)
	c.send(msgStreamInfo{Command: "streamInformation", StreamID: id, StreamInfo: []streamInfoEntry{entry}})
}

// sendOffer sends the downstream offer.
func (c *amsConn) sendOffer(id string, sd webrtc.SessionDescription) {
	log.Printf("%s -> takeConfiguration streamId=%s type=offer (%d bytes sdp)", c.tag, id, len(sd.SDP))
	c.send(msgTakeConfiguration{Command: "takeConfiguration", StreamID: id, Type: "offer", SDP: sd.SDP})
}

func (c *amsConn) sendCandidate(id string, ci webrtc.ICECandidateInit) {
	label, mid := 0, "0"
	if ci.SDPMLineIndex != nil {
		label = int(*ci.SDPMLineIndex)
	}
	if ci.SDPMid != nil && *ci.SDPMid != "" {
		mid = *ci.SDPMid
	}
	log.Printf("%s -> takeCandidate streamId=%s label=%d id=%s %s", c.tag, id, label, mid, ci.Candidate)
	c.send(msgTakeCandidate{Command: "takeCandidate", StreamID: id, Label: label, ID: mid, Candidate: ci.Candidate})
}
