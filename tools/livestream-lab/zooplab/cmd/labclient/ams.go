package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

type amsClient struct {
	o   *options
	ws  *websocket.Conn
	wmu sync.Mutex
	rc  *receiver

	mu           sync.Mutex
	pc           *webrtc.PeerConnection
	remoteSet    bool
	pendingCands []webrtc.ICECandidateInit
	answerSent   bool
	pendingLocal []webrtc.ICECandidateInit
	pings        []time.Time
	targets      []int
	counts       map[string]int

	finished chan string
	closed   chan struct{}
}

func (c *amsClient) send(v map[string]any) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if err := c.ws.WriteJSON(v); err != nil {
		logf("websocket write: %v", err)
	}
}

func runAMS(o *options, events []*event) int {
	ws, _, err := websocket.DefaultDialer.Dial(o.ws, nil)
	if err != nil {
		logf("dial %s: %v", o.ws, err)
		return 1
	}
	defer ws.Close()
	c := &amsClient{
		o: o, ws: ws, rc: newReceiver(startTime),
		counts: map[string]int{}, finished: make(chan string, 4), closed: make(chan struct{}),
	}
	logf("connected to %s; sending play streamId=%s", o.ws, o.stream)
	c.send(map[string]any{"command": "play", "streamId": o.stream, "token": "", "room": "", "trackList": []string{}, "subscriberId": "", "viewerInfo": ""})
	go c.readLoop()

	if o.toggleVideoAt > 0 {
		events = append(events,
			&event{at: dur(o.toggleVideoAt), name: "toggleVideo false", fn: func() {
				logf("-> toggleVideo enabled=false")
				c.send(map[string]any{"command": "toggleVideo", "streamId": o.stream, "trackId": "ARDAMSv" + o.stream, "enabled": false})
			}},
			&event{at: dur(o.toggleVideoAt + o.toggleVideoFor), name: "toggleVideo true", fn: func() {
				logf("-> toggleVideo enabled=true")
				c.send(map[string]any{"command": "toggleVideo", "streamId": o.stream, "trackId": "ARDAMSv" + o.stream, "enabled": true})
			}})
	}
	if o.infoAt > 0 {
		events = append(events, &event{at: dur(o.infoAt), name: "getStreamInfo", fn: func() {
			logf("-> getStreamInfo")
			c.send(map[string]any{"command": "getStreamInfo", "streamId": o.stream})
		}})
	}
	if o.stopAt > 0 {
		events = append(events, &event{at: dur(o.stopAt), name: "stop", fn: func() {
			logf("-> stop")
			c.send(map[string]any{"command": "stop", "streamId": o.stream})
		}})
	}
	events = sortEvents(events)

	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	var pingC <-chan time.Time
	if o.ping > 0 {
		pt := time.NewTicker(o.ping)
		defer pt.Stop()
		pingC = pt.C
	}
	last := time.Now()
	code := 0
	reason := "time up"
loop:
	for {
		select {
		case now := <-tick.C:
			c.rc.printTick(now.Sub(last).Seconds())
			last = now
			events = runDue(events, time.Since(startTime))
			if time.Since(startTime) >= dur(o.seconds) {
				break loop
			}
		case <-pingC:
			c.mu.Lock()
			c.pings = append(c.pings, time.Now())
			c.mu.Unlock()
			c.send(map[string]any{"command": "ping"})
		case why := <-c.finished:
			reason = why
			if strings.HasPrefix(why, "error") {
				code = 2
			}
			break loop
		case <-c.closed:
			reason = "websocket closed by server"
			code = 1
			break loop
		}
	}
	c.rc.printSummary(reason)
	c.mu.Lock()
	logf("    server messages: %v", c.counts)
	if len(c.targets) > 0 {
		logf("    bitrateMeasurement targetBitrate values: %v", c.targets)
	}
	pc := c.pc
	c.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
	return code
}

func sortEvents(evs []*event) []*event {
	for i := 1; i < len(evs); i++ {
		for j := i; j > 0 && evs[j].at < evs[j-1].at; j-- {
			evs[j], evs[j-1] = evs[j-1], evs[j]
		}
	}
	return evs
}

func (c *amsClient) readLoop() {
	defer close(c.closed)
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			logf("websocket read ended: %v", err)
			return
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			logf("<- (non-JSON) %s", data)
			continue
		}
		cmd, _ := m["command"].(string)
		def, _ := m["definition"].(string)
		key := cmd
		if def != "" {
			key = cmd + ":" + def
		}
		c.mu.Lock()
		c.counts[key]++
		c.mu.Unlock()
		if cmd == "pong" {
			c.onPong()
			continue
		}
		c.printMsg(m)
		switch cmd {
		case "takeConfiguration":
			if t, _ := m["type"].(string); t == "offer" {
				sdpText, _ := m["sdp"].(string)
				if err := c.onOffer(sdpText); err != nil {
					logf("handling offer failed: %v", err)
				}
			}
		case "takeCandidate":
			cand, _ := m["candidate"].(string)
			ci := webrtc.ICECandidateInit{Candidate: cand}
			if mid, ok := m["id"].(string); ok {
				ci.SDPMid = &mid
			}
			if l, ok := m["label"].(float64); ok {
				u := uint16(l)
				ci.SDPMLineIndex = &u
			}
			c.addRemote(ci)
		case "notification":
			switch def {
			case "play_finished":
				c.finished <- "play_finished"
			case "bitrateMeasurement":
				if t, ok := m["targetBitrate"].(float64); ok {
					c.mu.Lock()
					c.targets = append(c.targets, int(t))
					c.mu.Unlock()
				}
			}
		case "error":
			c.finished <- "error " + def
		}
	}
}

func (c *amsClient) printMsg(m map[string]any) {
	if s, ok := m["sdp"].(string); ok && !c.o.verbose {
		cp := map[string]any{}
		for k, v := range m {
			cp[k] = v
		}
		cp["sdp"] = fmt.Sprintf("<%d bytes; %d m-lines; %d extmap>", len(s), strings.Count(s, "\nm="), strings.Count(s, "a=extmap:"))
		m = cp
	}
	b, _ := json.Marshal(m)
	logf("<- %s", b)
}

func (c *amsClient) onPong() {
	c.mu.Lock()
	if len(c.pings) == 0 {
		c.mu.Unlock()
		return
	}
	sent := c.pings[0]
	c.pings = c.pings[1:]
	c.mu.Unlock()
	if d := time.Since(sent); d > time.Second {
		logf("<- pong after %.1fs (frames were held)", d.Seconds())
	}
}

func (c *amsClient) onOffer(offer string) error {
	api, err := newAPI(c.o.localIP)
	if err != nil {
		return err
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	c.mu.Lock()
	if c.pc != nil {
		c.mu.Unlock()
		_ = pc.Close()
		return fmt.Errorf("second offer ignored")
	}
	c.pc = pc
	c.mu.Unlock()
	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { c.rc.readTrack(t) })
	pc.OnConnectionStateChange(c.rc.onState)
	pc.OnICECandidate(func(ci *webrtc.ICECandidate) {
		if ci == nil {
			return
		}
		j := ci.ToJSON()
		c.mu.Lock()
		if !c.answerSent {
			c.pendingLocal = append(c.pendingLocal, j)
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()
		c.sendCandidate(j)
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		return err
	}
	if c.o.verbose {
		logf("offer SDP:\n%s", offer)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		return err
	}
	logf("-> takeConfiguration answer (%d bytes)", len(answer.SDP))
	c.send(map[string]any{"command": "takeConfiguration", "streamId": c.o.stream, "type": "answer", "sdp": answer.SDP})
	c.mu.Lock()
	c.answerSent = true
	local := c.pendingLocal
	c.pendingLocal = nil
	c.remoteSet = true
	remote := c.pendingCands
	c.pendingCands = nil
	c.mu.Unlock()
	for _, j := range local {
		c.sendCandidate(j)
	}
	for _, ci := range remote {
		if err := pc.AddICECandidate(ci); err != nil {
			logf("add candidate: %v", err)
		}
	}
	return nil
}

func (c *amsClient) sendCandidate(j webrtc.ICECandidateInit) {
	label, mid := 0, "0"
	if j.SDPMLineIndex != nil {
		label = int(*j.SDPMLineIndex)
	}
	if j.SDPMid != nil && *j.SDPMid != "" {
		mid = *j.SDPMid
	}
	logf("-> takeCandidate %s", j.Candidate)
	c.send(map[string]any{"command": "takeCandidate", "streamId": c.o.stream, "label": label, "id": mid, "candidate": j.Candidate})
}

func (c *amsClient) addRemote(ci webrtc.ICECandidateInit) {
	c.mu.Lock()
	if !c.remoteSet {
		c.pendingCands = append(c.pendingCands, ci)
		c.mu.Unlock()
		return
	}
	pc := c.pc
	c.mu.Unlock()
	if err := pc.AddICECandidate(ci); err != nil {
		logf("add candidate: %v", err)
	}
}
