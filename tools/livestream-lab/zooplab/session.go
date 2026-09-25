package main

// One Ant Media play session: an unimpaired WHEP upstream from mediamtx over
// loopback, and an impaired downstream peer connection toward the viewer.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

const (
	h264Fmtp42e01f = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
	h264Fmtp42001f = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"
	opusFmtp       = "minptime=10;useinbandfec=1"
	videoOrientURI = "urn:3gpp:video-orientation"

	// pion's GCC has no probing and ramps up ~8%/s, so start near the stream
	// rate; loss/delay feedback pulls it down within a second or two.
	gccInitialBitrate = 3_000_000
	gccMinBitrate     = 50_000
	gccMaxBitrate     = 20_000_000

	nackBufferPackets = 4096 // ~10 s at 4 Mbps
	pliMinInterval    = 500 * time.Millisecond
)

var errSessionClosed = errors.New("session closed")

type noStreamError struct{ error }

func isNoStream(err error) bool {
	var e noStreamError
	return errors.As(err, &e)
}

type counter struct{ pkts, bytes atomic.Uint64 }

func (c *counter) add(n int) {
	c.pkts.Add(1)
	c.bytes.Add(uint64(n))
}

type playSession struct {
	srv     *amsServer
	conn    *amsConn
	id      string
	tag     string
	created time.Time

	mu            sync.Mutex
	closed        bool
	upPC          *webrtc.PeerConnection
	whepResource  string
	downPC        *webrtc.PeerConnection
	videoSender   *webrtc.RTPSender
	estimator     cc.BandwidthEstimator
	remoteSet     bool
	pendingRemote []webrtc.ICECandidateInit
	offerSent     bool
	pendingLocal  []webrtc.ICECandidateInit
	lastPLI       time.Time
	downState     webrtc.PeerConnectionState

	videoTrack, audioTrack *webrtc.TrackLocalStaticRTP

	done        chan struct{}
	closeOnce   sync.Once
	videoOn     atomic.Bool
	upVideoSSRC atomic.Uint32
	playStarted atomic.Bool
	connected   atomic.Bool

	vIn, aIn, vFwd, aFwd                counter
	plis, firs, nacks, nackSeqs, plisUp atomic.Uint64
	twccVideo, twccAudio, rtcpErrs      atomic.Uint64

	// bitrates over the last 5 s window, in bps
	inVideoBps, inAudioBps, fwdVideoBps, fwdAudioBps atomic.Int64
	windows                                          atomic.Int64
}

func newPlaySession(c *amsConn, id string, _ *pathInfo) *playSession {
	s := &playSession{
		srv:       c.srv,
		conn:      c,
		id:        id,
		tag:       fmt.Sprintf("[ams c%d/%s]", c.id, id),
		created:   time.Now(),
		done:      make(chan struct{}),
		downState: webrtc.PeerConnectionStateNew,
	}
	s.videoOn.Store(true)
	return s
}

func (s *playSession) isDone() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

func (s *playSession) start(ctx context.Context) error {
	var err error
	s.videoTrack, err = webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: h264Fmtp42e01f,
	}, "ARDAMSv"+s.id, s.id)
	if err != nil {
		return err
	}
	s.audioTrack, err = webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: opusFmtp,
	}, "ARDAMSa"+s.id, s.id)
	if err != nil {
		return err
	}
	if err := s.startUpstream(ctx); err != nil {
		return fmt.Errorf("upstream: %w", err)
	}
	if err := s.startDownstream(); err != nil {
		return fmt.Errorf("downstream: %w", err)
	}
	go s.monitor()
	return nil
}

// ---- upstream (WHEP client to mediamtx, loopback, unimpaired) ----

func (s *playSession) startUpstream(ctx context.Context) error {
	m := &webrtc.MediaEngine{}
	videoFB := []webrtc.RTCPFeedback{
		{Type: webrtc.TypeRTCPFBNACK}, {Type: webrtc.TypeRTCPFBNACK, Parameter: "pli"},
		{Type: webrtc.TypeRTCPFBCCM, Parameter: "fir"},
	}
	for _, c := range []struct {
		pt   webrtc.PayloadType
		fmtp string
	}{{102, h264Fmtp42e01f}, {104, h264Fmtp42001f}} {
		if err := m.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: c.fmtp, RTCPFeedback: videoFB,
			},
			PayloadType: c.pt,
		}, webrtc.RTPCodecTypeVideo); err != nil {
			return err
		}
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: opusFmtp,
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return err
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return err
	}
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	se.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.LoggerFactory = s.srv.pionLF
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se))

	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = pc.Close()
		return errSessionClosed
	}
	s.upPC = pc
	s.mu.Unlock()

	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		if _, err := pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			return err
		}
	}
	pc.OnTrack(s.onUpstreamTrack)
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		log.Printf("%s upstream peer connection %s", s.tag, st)
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			s.publisherGone("upstream peer connection " + st.String())
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		return fmt.Errorf("ICE gathering: %w", ctx.Err())
	}
	endpoint := strings.TrimRight(s.srv.cfg.MediaMTX, "/") + "/" + amsPath(s.id) + "/whep"
	answer, resource, status, err := whepPost(ctx, endpoint, pc.LocalDescription().SDP)
	if err != nil {
		if status == http.StatusNotFound {
			return noStreamError{err}
		}
		return err
	}
	s.mu.Lock()
	s.whepResource = resource
	s.mu.Unlock()
	log.Printf("%s upstream WHEP session %s (answer candidates %d, using %s)", s.tag, resource, len(candidateLines(answer)), s.srv.cfg.MediaMTXICE)
	answer = replaceCandidates(answer, s.srv.upstreamCandidate)
	return pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer})
}

func (s *playSession) onUpstreamTrack(t *webrtc.TrackRemote, r *webrtc.RTPReceiver) {
	codec := t.Codec()
	log.Printf("%s upstream %s track: ssrc=%d %s pt=%d %s", s.tag, t.Kind(), t.SSRC(), codec.MimeType, codec.PayloadType, codec.SDPFmtpLine)
	go func() {
		for {
			if _, _, err := r.ReadRTCP(); err != nil {
				return
			}
		}
	}()
	switch t.Kind() {
	case webrtc.RTPCodecTypeVideo:
		s.upVideoSSRC.Store(uint32(t.SSRC()))
		s.forward(t, s.videoTrack, true)
	case webrtc.RTPCodecTypeAudio:
		s.forward(t, s.audioTrack, false)
	}
}

// forward copies RTP from an upstream track to the local track; pion
// rewrites SSRC and payload type. Upstream header extensions are dropped
// (their IDs belong to the upstream negotiation). While video is toggled off
// packets are skipped and the sequence numbers are rewritten so the viewer
// sees no gap; forwarding resumes at a frame boundary.
func (s *playSession) forward(t *webrtc.TrackRemote, out *webrtc.TrackLocalStaticRTP, video bool) {
	in, fwd := &s.aIn, &s.aFwd
	if video {
		in, fwd = &s.vIn, &s.vFwd
	}
	buf := make([]byte, 1600)
	var pkt rtp.Packet
	var seqOffset uint16
	paused := false
	lastMarker := true
	for {
		n, _, err := t.Read(buf)
		if err != nil {
			s.publisherGone(fmt.Sprintf("upstream %s track read ended (%v)", t.Kind(), err))
			return
		}
		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}
		in.add(n)
		frameStart := lastMarker
		lastMarker = pkt.Marker
		if video {
			if !s.videoOn.Load() {
				seqOffset++
				paused = true
				continue
			}
			if paused {
				if !frameStart {
					seqOffset++
					continue
				}
				paused = false
			}
		}
		pkt.Header.Extension = false
		pkt.Header.ExtensionProfile = 0
		pkt.Header.Extensions = nil
		pkt.SequenceNumber -= seqOffset
		if err := out.WriteRTP(&pkt); err != nil {
			if s.isDone() {
				return
			}
			continue
		}
		fwd.add(n)
	}
}

// ---- downstream (toward the viewer, over the impaired UDP mux) ----

func (s *playSession) startDownstream() error {
	lf := s.srv.pionLF
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: h264Fmtp42e01f,
			RTCPFeedback: []webrtc.RTCPFeedback{
				{Type: webrtc.TypeRTCPFBGoogREMB}, {Type: webrtc.TypeRTCPFBTransportCC},
				{Type: webrtc.TypeRTCPFBCCM, Parameter: "fir"},
				{Type: webrtc.TypeRTCPFBNACK}, {Type: webrtc.TypeRTCPFBNACK, Parameter: "pli"},
			},
		},
		PayloadType: 125,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return err
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: opusFmtp,
			RTCPFeedback: []webrtc.RTCPFeedback{{Type: webrtc.TypeRTCPFBTransportCC}},
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return err
	}
	for _, e := range []struct {
		uri  string
		kind webrtc.RTPCodecType
	}{
		{sdp.ABSSendTimeURI, webrtc.RTPCodecTypeAudio}, {sdp.ABSSendTimeURI, webrtc.RTPCodecTypeVideo},
		{sdp.TransportCCURI, webrtc.RTPCodecTypeAudio}, {sdp.TransportCCURI, webrtc.RTPCodecTypeVideo},
		{videoOrientURI, webrtc.RTPCodecTypeVideo},
	} {
		if err := m.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: e.uri}, e.kind); err != nil {
			return err
		}
	}

	// Interceptor order matters: packets pass from the last registered to the
	// first. cc (innermost) sees the TWCC sequence numbers that the header
	// extension interceptor assigns, and NACK retransmissions (resent from
	// the responder's inner writer) get fresh TWCC numbers.
	ir := &interceptor.Registry{}
	ccf, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
		return gcc.NewSendSideBWE(
			gcc.SendSideBWEInitialBitrate(gccInitialBitrate),
			gcc.SendSideBWEMinBitrate(gccMinBitrate),
			gcc.SendSideBWEMaxBitrate(gccMaxBitrate),
			gcc.SendSideBWEPacer(gcc.NewNoOpPacer()), // never throttle forwarding
			gcc.WithLoggerFactory(lf),
		)
	})
	if err != nil {
		return err
	}
	ccf.OnNewPeerConnection(func(_ string, e cc.BandwidthEstimator) {
		s.mu.Lock()
		s.estimator = e
		s.mu.Unlock()
	})
	ir.Add(ccf)
	twccExt, err := twcc.NewHeaderExtensionInterceptor()
	if err != nil {
		return err
	}
	ir.Add(twccExt)
	nackResp, err := nack.NewResponderInterceptor(nack.ResponderSize(nackBufferPackets), nack.WithResponderLoggerFactory(lf))
	if err != nil {
		return err
	}
	ir.Add(nackResp)
	if err := webrtc.ConfigureRTCPReports(ir); err != nil {
		return err
	}

	se := webrtc.SettingEngine{}
	se.SetICEUDPMux(s.srv.mux)
	if err := se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
		External:        []string{s.srv.cfg.MediaIP},
		AsCandidateType: webrtc.ICECandidateTypeHost,
		Mode:            webrtc.ICEAddressRewriteReplace,
	}); err != nil {
		return err
	}
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.LoggerFactory = lf
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se))

	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = pc.Close()
		return errSessionClosed
	}
	s.downPC = pc
	s.mu.Unlock()

	videoTx, err := pc.AddTransceiverFromTrack(s.videoTrack, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		return err
	}
	audioTx, err := pc.AddTransceiverFromTrack(s.audioTrack, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.videoSender = videoTx.Sender()
	s.mu.Unlock()
	go s.readRTCP(videoTx.Sender(), true)
	go s.readRTCP(audioTx.Sender(), false)

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			s.localCandidate(c.ToJSON())
		}
	})
	pc.OnICEConnectionStateChange(func(st webrtc.ICEConnectionState) {
		log.Printf("%s downstream ICE %s", s.tag, st)
	})
	pc.OnConnectionStateChange(s.onDownstreamState)

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.sendOffer(s.id, offer)
	s.offerSent = true
	for _, ci := range s.pendingLocal {
		s.conn.sendCandidate(s.id, ci)
	}
	s.pendingLocal = nil
	return nil
}

// localCandidate trickles a local candidate, after the offer has been sent.
func (s *playSession) localCandidate(ci webrtc.ICECandidateInit) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	if !s.offerSent {
		s.pendingLocal = append(s.pendingLocal, ci)
		return
	}
	s.conn.sendCandidate(s.id, ci)
}

func (s *playSession) setAnswer(sdpText string) {
	s.mu.Lock()
	pc := s.downPC
	s.mu.Unlock()
	if pc == nil {
		return
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdpText}); err != nil {
		log.Printf("%s set remote description failed: %v", s.tag, err)
		s.conn.sendError("notSetRemoteDescription", s.id)
		return
	}
	s.mu.Lock()
	s.remoteSet = true
	pending := s.pendingRemote
	s.pendingRemote = nil
	s.mu.Unlock()
	log.Printf("%s answer applied (%d queued remote candidates)", s.tag, len(pending))
	for _, ci := range pending {
		s.applyRemoteCandidate(pc, ci)
	}
}

func (s *playSession) addRemoteCandidate(cand, mid string, label json.RawMessage) {
	cand = strings.TrimSpace(strings.TrimPrefix(cand, "a="))
	if cand == "" {
		return // end of candidates
	}
	ci := webrtc.ICECandidateInit{Candidate: cand}
	if mid != "" {
		ci.SDPMid = &mid
	}
	if l, ok := rawInt(label); ok && l >= 0 && l < 65536 {
		u := uint16(l)
		ci.SDPMLineIndex = &u
	}
	s.mu.Lock()
	if !s.remoteSet {
		s.pendingRemote = append(s.pendingRemote, ci)
		s.mu.Unlock()
		return
	}
	pc := s.downPC
	s.mu.Unlock()
	s.applyRemoteCandidate(pc, ci)
}

func (s *playSession) applyRemoteCandidate(pc *webrtc.PeerConnection, ci webrtc.ICECandidateInit) {
	if err := pc.AddICECandidate(ci); err != nil {
		log.Printf("%s add remote candidate %q: %v", s.tag, ci.Candidate, err)
	}
}

func (s *playSession) onDownstreamState(st webrtc.PeerConnectionState) {
	log.Printf("%s downstream peer connection %s", s.tag, st)
	s.mu.Lock()
	s.downState = st
	sender := s.videoSender
	s.mu.Unlock()
	switch st {
	case webrtc.PeerConnectionStateConnected:
		s.connected.Store(true)
		if sender != nil {
			if pair, err := sender.Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
				log.Printf("%s selected pair %s", s.tag, pair)
			}
		}
		if !s.playStarted.Swap(true) {
			s.conn.sendNotify("play_started", s.id)
		}
	case webrtc.PeerConnectionStateFailed:
		s.connected.Store(false)
		s.finish("downstream peer connection failed", false)
	default:
		s.connected.Store(false)
	}
}

func (s *playSession) setVideo(on bool) {
	prev := s.videoOn.Swap(on)
	log.Printf("%s video forwarding %s (was %s)", s.tag, onOff(on), onOff(prev))
	if on && !prev {
		s.requestKeyframe("toggleVideo resume", true)
	}
}

// requestKeyframe sends a PLI upstream, at most one per pliMinInterval unless forced.
func (s *playSession) requestKeyframe(reason string, force bool) {
	s.mu.Lock()
	if !force && time.Since(s.lastPLI) < pliMinInterval {
		s.mu.Unlock()
		return
	}
	s.lastPLI = time.Now()
	pc := s.upPC
	s.mu.Unlock()
	ssrc := s.upVideoSSRC.Load()
	if pc == nil || ssrc == 0 {
		return
	}
	if err := pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}}); err != nil {
		log.Printf("%s PLI upstream failed: %v", s.tag, err)
		return
	}
	n := s.plisUp.Add(1)
	if force || n <= 3 || n%20 == 0 {
		log.Printf("%s PLI -> upstream ssrc %d (%s, #%d)", s.tag, ssrc, reason, n)
	}
}

// readRTCP drains a sender's RTCP (running the interceptors: NACK responder,
// GCC feedback) and turns PLI/FIR into upstream keyframe requests. pion hands
// a compound packet to every sender whose SSRC it mentions, so feedback is
// only counted on the video sender.
//
// An interceptor error (e.g. GCC rejecting one feedback packet) surfaces as a
// read error for that packet only, so the loop keeps going unless the sender
// is closed; otherwise one bad packet would silence all further feedback.
func (s *playSession) readRTCP(sender *webrtc.RTPSender, video bool) {
	kind, twcc := "audio", &s.twccAudio
	if video {
		kind, twcc = "video", &s.twccVideo
	}
	consecutive := 0
	for {
		pkts, _, err := sender.ReadRTCP()
		if err != nil {
			if s.isDone() || errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, net.ErrClosed) {
				return
			}
			n := s.rtcpErrs.Add(1)
			if n <= 5 || n%500 == 0 {
				log.Printf("%s %s RTCP read error #%d (continuing): %v", s.tag, kind, n, err)
			}
			if consecutive++; consecutive > 10 {
				time.Sleep(time.Millisecond)
			}
			continue
		}
		consecutive = 0
		for _, p := range pkts {
			if _, ok := p.(*rtcp.TransportLayerCC); ok {
				twcc.Add(1)
			}
		}
		if !video {
			continue
		}
		for _, p := range pkts {
			switch p := p.(type) {
			case *rtcp.PictureLossIndication:
				s.plis.Add(1)
				s.requestKeyframe("viewer PLI", false)
			case *rtcp.FullIntraRequest:
				s.firs.Add(1)
				s.requestKeyframe("viewer FIR", false)
			case *rtcp.TransportLayerNack:
				s.nacks.Add(1)
				for _, pair := range p.Nacks {
					s.nackSeqs.Add(uint64(len(pair.PacketList())))
				}
			}
		}
	}
}

func (s *playSession) targetBitrate() int {
	s.mu.Lock()
	e := s.estimator
	s.mu.Unlock()
	if e == nil {
		return 0
	}
	return e.GetTargetBitrate()
}

// gccSummary renders the estimator's target and internal loss/delay state.
func (s *playSession) gccSummary() string {
	s.mu.Lock()
	e := s.estimator
	s.mu.Unlock()
	if e == nil {
		return "n/a"
	}
	st := e.GetStats()
	num := func(k string) float64 {
		switch v := st[k].(type) {
		case int:
			return float64(v)
		case float64:
			return v
		}
		return 0
	}
	return fmt.Sprintf("target %s (loss-based %s avgLoss %.2f, delay-based %s %v/%v)",
		fmtBps(float64(e.GetTargetBitrate())), fmtBps(num("lossTargetBitrate")), num("averageLoss"),
		fmtBps(num("delayTargetBitrate")), st["usage"], st["state"])
}

// inputBitrates returns the measured upstream (stream) bitrates in bps.
func (s *playSession) inputBitrates() (int, int) {
	if s.windows.Load() > 0 {
		return int(s.inVideoBps.Load()), int(s.inAudioBps.Load())
	}
	el := time.Since(s.created).Seconds()
	if el <= 0 {
		return 0, 0
	}
	return int(float64(s.vIn.bytes.Load()) * 8 / el), int(float64(s.aIn.bytes.Load()) * 8 / el)
}

func (s *playSession) publisherGone(reason string) {
	if s.isDone() {
		return
	}
	go s.finish("publisher gone: "+reason, true)
}

type sessSnap struct {
	t                                  time.Time
	vIn, aIn, vFwd, aFwd, vPkts, aPkts uint64
}

func (s *playSession) snap() sessSnap {
	return sessSnap{
		t:   time.Now(),
		vIn: s.vIn.bytes.Load(), aIn: s.aIn.bytes.Load(),
		vFwd: s.vFwd.bytes.Load(), aFwd: s.aFwd.bytes.Load(),
		vPkts: s.vFwd.pkts.Load(), aPkts: s.aFwd.pkts.Load(),
	}
}

func bpsBetween(a, b uint64, dt float64) int64 {
	if dt <= 0 || a < b {
		return 0
	}
	return int64(float64(a-b) * 8 / dt)
}

// monitor polls mediamtx every 2 s, sends bitrateMeasurement every 5 s while
// connected and logs statistics every 10 s.
func (s *playSession) monitor() {
	poll := time.NewTicker(2 * time.Second)
	meas := time.NewTicker(5 * time.Second)
	stat := time.NewTicker(10 * time.Second)
	defer poll.Stop()
	defer meas.Stop()
	defer stat.Stop()
	p5 := sessSnap{t: s.created}
	p10 := p5
	apiErr := false
	for {
		select {
		case <-s.done:
			return
		case <-poll.C:
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			pi, err := s.srv.getPath(ctx, amsPath(s.id))
			cancel()
			if err != nil {
				if !apiErr {
					log.Printf("%s mediamtx API poll failed: %v", s.tag, err)
				}
				apiErr = true
				continue
			}
			apiErr = false
			if pi == nil || !pi.Ready {
				s.publisherGone("mediamtx API reports the path is not ready")
				return
			}
		case <-meas.C:
			now := s.snap()
			dt := now.t.Sub(p5.t).Seconds()
			s.inVideoBps.Store(bpsBetween(now.vIn, p5.vIn, dt))
			s.inAudioBps.Store(bpsBetween(now.aIn, p5.aIn, dt))
			s.fwdVideoBps.Store(bpsBetween(now.vFwd, p5.vFwd, dt))
			s.fwdAudioBps.Store(bpsBetween(now.aFwd, p5.aFwd, dt))
			s.windows.Add(1)
			p5 = now
			if s.connected.Load() {
				m := msgBitrate{
					Command: "notification", Definition: "bitrateMeasurement", StreamID: s.id,
					TargetBitrate: s.targetBitrate(),
					VideoBitrate:  int(s.fwdVideoBps.Load()),
					AudioBitrate:  int(s.fwdAudioBps.Load()),
				}
				log.Printf("%s -> bitrateMeasurement target=%d video=%d audio=%d", s.tag, m.TargetBitrate, m.VideoBitrate, m.AudioBitrate)
				s.conn.send(m)
			}
		case <-stat.C:
			now := s.snap()
			dt := now.t.Sub(p10.t).Seconds()
			s.mu.Lock()
			state := s.downState
			s.mu.Unlock()
			log.Printf("%s stats 10s: fwd video %d pkts %s, audio %d pkts %s | total fwd v=%d a=%d | NACK %d (%d seqs) PLI %d FIR %d -> upstream PLI %d | TWCC fb v=%d a=%d, RTCP errs %d | GCC %s | video %s | %s",
				s.tag, now.vPkts-p10.vPkts, fmtBps(float64(bpsBetween(now.vFwd, p10.vFwd, dt))),
				now.aPkts-p10.aPkts, fmtBps(float64(bpsBetween(now.aFwd, p10.aFwd, dt))),
				now.vPkts, now.aPkts, s.nacks.Load(), s.nackSeqs.Load(), s.plis.Load(), s.firs.Load(), s.plisUp.Load(),
				s.twccVideo.Load(), s.twccAudio.Load(), s.rtcpErrs.Load(),
				s.gccSummary(), onOff(s.videoOn.Load()), state)
			p10 = now
		}
	}
}

// finish closes both peer connections and the upstream WHEP resource.
// With notify it then sends play_finished.
func (s *playSession) finish(reason string, notify bool) {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		up, down, resource := s.upPC, s.downPC, s.whepResource
		s.mu.Unlock()
		close(s.done)
		s.conn.dropSession(s)
		s.srv.unregister(s)
		if down != nil {
			if err := down.Close(); err != nil {
				log.Printf("%s close downstream: %v", s.tag, err)
			}
		}
		if up != nil {
			if err := up.Close(); err != nil {
				log.Printf("%s close upstream: %v", s.tag, err)
			}
		}
		del := "none"
		if resource != "" {
			if st, err := whepDelete(resource); err != nil {
				del = err.Error()
			} else {
				del = fmt.Sprint(st)
			}
		}
		log.Printf("%s session closed: %s (after %.1fs; fwd video %d pkts, audio %d pkts; WHEP DELETE -> %s)",
			s.tag, reason, time.Since(s.created).Seconds(), s.vFwd.pkts.Load(), s.aFwd.pkts.Load(), del)
		if notify {
			s.conn.sendNotify("play_finished", s.id)
		}
	})
}

type sessionView struct {
	Conn          uint64  `json:"conn"`
	Remote        string  `json:"remote"`
	StreamID      string  `json:"streamId"`
	AgeSec        float64 `json:"ageSec"`
	State         string  `json:"state"`
	VideoOn       bool    `json:"videoOn"`
	FwdVideoPkts  uint64  `json:"fwdVideoPkts"`
	FwdAudioPkts  uint64  `json:"fwdAudioPkts"`
	FwdVideoBps   int64   `json:"fwdVideoBps"`
	FwdAudioBps   int64   `json:"fwdAudioBps"`
	InVideoBps    int64   `json:"inVideoBps"`
	InAudioBps    int64   `json:"inAudioBps"`
	TargetBitrate int     `json:"targetBitrate"`
	NACKs         uint64  `json:"nacks"`
	NACKSeqs      uint64  `json:"nackSeqs"`
	PLIs          uint64  `json:"plis"`
	FIRs          uint64  `json:"firs"`
	PLIsUpstream  uint64  `json:"plisUpstream"`
}

func (s *playSession) view() sessionView {
	s.mu.Lock()
	state := s.downState
	s.mu.Unlock()
	return sessionView{
		Conn: s.conn.id, Remote: s.conn.remote, StreamID: s.id,
		AgeSec: round1(time.Since(s.created).Seconds()), State: state.String(), VideoOn: s.videoOn.Load(),
		FwdVideoPkts: s.vFwd.pkts.Load(), FwdAudioPkts: s.aFwd.pkts.Load(),
		FwdVideoBps: s.fwdVideoBps.Load(), FwdAudioBps: s.fwdAudioBps.Load(),
		InVideoBps: s.inVideoBps.Load(), InAudioBps: s.inAudioBps.Load(),
		TargetBitrate: s.targetBitrate(),
		NACKs:         s.nacks.Load(), NACKSeqs: s.nackSeqs.Load(), PLIs: s.plis.Load(), FIRs: s.firs.Load(),
		PLIsUpstream: s.plisUp.Load(),
	}
}
