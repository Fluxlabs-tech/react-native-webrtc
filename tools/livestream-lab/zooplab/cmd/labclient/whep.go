package main

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

func runWHEP(o *options, events []*event) int {
	rc := newReceiver(startTime)
	api, err := newAPI(o.localIP)
	if err != nil {
		logf("api: %v", err)
		return 1
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		logf("peer connection: %v", err)
		return 1
	}
	defer pc.Close()
	for _, k := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		if _, err := pc.AddTransceiverFromKind(k, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			logf("transceiver: %v", err)
			return 1
		}
	}
	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { rc.readTrack(t) })
	pc.OnConnectionStateChange(rc.onState)
	pc.OnICEConnectionStateChange(func(st webrtc.ICEConnectionState) { logf("ICE %s", st) })

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		logf("offer: %v", err)
		return 1
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		logf("set local: %v", err)
		return 1
	}
	<-gathered
	local := pc.LocalDescription().SDP
	logf("POST %s (offer with %d candidates)", o.whep, strings.Count(local, "a=candidate:"))
	resp, err := http.Post(o.whep, "application/sdp", strings.NewReader(local))
	if err != nil {
		logf("POST: %v", err)
		return 1
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	logf("<- HTTP %d Content-Type=%q ETag=%q Location=%q", resp.StatusCode, resp.Header.Get("Content-Type"), resp.Header.Get("ETag"), resp.Header.Get("Location"))
	if resp.StatusCode != http.StatusCreated {
		logf("body: %s", strings.TrimSpace(string(body)))
		return 2
	}
	answer := string(body)
	for _, l := range strings.Split(answer, "\n") {
		if l = strings.TrimSpace(l); strings.HasPrefix(l, "a=candidate:") || l == "a=end-of-candidates" {
			logf("   answer %s", l)
		}
	}
	if o.verbose {
		logf("answer SDP:\n%s", answer)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		logf("set remote: %v", err)
		return 1
	}

	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	last := time.Now()
	for time.Since(startTime) < dur(o.seconds) {
		now := <-tick.C
		rc.printTick(now.Sub(last).Seconds())
		last = now
		events = runDue(events, time.Since(startTime))
	}
	rc.printSummary("time up")

	if loc := resp.Header.Get("Location"); loc != "" {
		base, _ := url.Parse(o.whep)
		ref, err := url.Parse(loc)
		if err == nil {
			target := base.ResolveReference(ref).String()
			req, _ := http.NewRequest(http.MethodDelete, target, nil)
			if dresp, err := http.DefaultClient.Do(req); err == nil {
				dresp.Body.Close()
				logf("DELETE %s -> HTTP %d", target, dresp.StatusCode)
			} else {
				logf("DELETE %s: %v", target, err)
			}
		}
	}
	return 0
}
