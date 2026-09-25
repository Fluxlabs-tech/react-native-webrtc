package main

import (
	"os"

	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4/pkg/media/samplebuilder"

	"fmt"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// rxStats counts received RTP packets and loss from sequence-number gaps.
type rxStats struct {
	kind string

	mu              sync.Mutex
	pkts, bytes     uint64
	started         bool
	baseExt, maxExt int64
	firstAt         time.Time
	lastAt          time.Time

	// previous interval snapshot
	pPkts, pBytes uint64
	pExpected     int64
}

func newRxStats(kind string) *rxStats { return &rxStats{kind: kind} }

func (r *rxStats) add(p *rtp.Packet, n int, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.started {
		r.started = true
		r.baseExt = int64(p.SequenceNumber)
		r.maxExt = r.baseExt
		r.firstAt = now
	} else {
		diff := int16(p.SequenceNumber - uint16(r.maxExt))
		if ext := r.maxExt + int64(diff); ext > r.maxExt {
			r.maxExt = ext
		}
	}
	r.pkts++
	r.bytes += uint64(n)
	r.lastAt = now
}

func (r *rxStats) expectedLocked() int64 {
	if !r.started {
		return 0
	}
	return r.maxExt - r.baseExt + 1
}

type interval struct {
	pkts         uint64
	kbps         float64
	lost         int64
	lossPct      float64
	totalPkts    uint64
	totalBytes   uint64
	totalLost    int64
	totalLossPct float64
}

func pct(lost, expected int64) float64 {
	if expected <= 0 {
		return 0
	}
	return 100 * float64(lost) / float64(expected)
}

// tick returns the counters since the previous tick (dt seconds ago).
func (r *rxStats) tick(dt float64) interval {
	r.mu.Lock()
	defer r.mu.Unlock()
	exp := r.expectedLocked()
	iv := interval{
		pkts:       r.pkts - r.pPkts,
		totalPkts:  r.pkts,
		totalBytes: r.bytes,
		totalLost:  exp - int64(r.pkts),
	}
	if dt > 0 {
		iv.kbps = float64(r.bytes-r.pBytes) * 8 / dt / 1000
	}
	iExp := exp - r.pExpected
	iv.lost = iExp - int64(iv.pkts)
	iv.lossPct = pct(iv.lost, iExp)
	iv.totalLossPct = pct(iv.totalLost, exp)
	r.pPkts, r.pBytes, r.pExpected = r.pkts, r.bytes, exp
	return iv
}

func (r *rxStats) totals() (pkts, bytes uint64, lost int64, lossPct float64, first, last time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	exp := r.expectedLocked()
	return r.pkts, r.bytes, exp - int64(r.pkts), pct(exp-int64(r.pkts), exp), r.firstAt, r.lastAt
}

// isH264Keyframe reports whether an RTP payload carries (the start of) an
// IDR slice (NAL 5) or an SPS (NAL 7), including inside STAP-A and FU-A.
func isH264Keyframe(payload []byte) bool {
	if len(payload) < 1 {
		return false
	}
	isKey := func(t byte) bool { return t == 5 || t == 7 }
	switch nal := payload[0] & 0x1f; nal {
	case 24: // STAP-A
		for i := 1; i+2 < len(payload); {
			size := int(payload[i])<<8 | int(payload[i+1])
			i += 2
			if size == 0 || i+size > len(payload) {
				break
			}
			if isKey(payload[i] & 0x1f) {
				return true
			}
			i += size
		}
		return false
	case 28: // FU-A
		return len(payload) >= 2 && payload[1]&0x80 != 0 && isKey(payload[1]&0x1f)
	default:
		return isKey(nal)
	}
}

// receiver reads the tracks of a peer connection into rxStats.
type receiver struct {
	start       time.Time
	video       *rxStats
	audio       *rxStats
	mu          sync.Mutex
	connectedAt time.Time
	keyframeAt  time.Time
	state       webrtc.PeerConnectionState
}

func newReceiver(start time.Time) *receiver {
	return &receiver{start: start, video: newRxStats("video"), audio: newRxStats("audio")}
}

func (rc *receiver) since(t time.Time) float64 { return t.Sub(rc.start).Seconds() }

func (rc *receiver) onState(st webrtc.PeerConnectionState) {
	rc.mu.Lock()
	rc.state = st
	first := st == webrtc.PeerConnectionStateConnected && rc.connectedAt.IsZero()
	if first {
		rc.connectedAt = time.Now()
	}
	rc.mu.Unlock()
	logf("peer connection %s", st)
}

var dumpPath string

func (rc *receiver) readTrack(t *webrtc.TrackRemote) {
	c := t.Codec()
	logf("track %s ssrc=%d %s pt=%d", t.Kind(), t.SSRC(), c.MimeType, c.PayloadType)
	st := rc.audio
	video := t.Kind() == webrtc.RTPCodecTypeVideo
	if video {
		st = rc.video
	}
	buf := make([]byte, 1600)
	var p rtp.Packet
	var dump *os.File
	var sb *samplebuilder.SampleBuilder
	if video && dumpPath != "" {
		if f, err := os.Create(dumpPath); err == nil {
			dump = f
			defer f.Close()
			sb = samplebuilder.New(512, &codecs.H264Packet{}, 90000)
		}
	}
	for {
		n, _, err := t.Read(buf)
		if err != nil {
			return
		}
		if p.Unmarshal(buf[:n]) != nil {
			continue
		}
		if sb != nil {
			cp := p.Clone()
			sb.Push(cp)
			for s := sb.Pop(); s != nil; s = sb.Pop() {
				dump.Write(s.Data)
			}
		}
		now := time.Now()
		st.add(&p, n, now)
		if video && isH264Keyframe(p.Payload) {
			rc.mu.Lock()
			first := rc.keyframeAt.IsZero()
			if first {
				rc.keyframeAt = now
			}
			conn := rc.connectedAt
			rc.mu.Unlock()
			if first {
				extra := ""
				if !conn.IsZero() {
					extra = fmt.Sprintf(", %.0f ms after connected", now.Sub(conn).Seconds()*1000)
				}
				logf("FIRST KEYFRAME (H.264 IDR/SPS): %.0f ms after start%s", rc.since(now)*1000, extra)
			}
		}
	}
}

func (rc *receiver) printTick(dt float64) {
	v := rc.video.tick(dt)
	a := rc.audio.tick(dt)
	rc.mu.Lock()
	st := rc.state
	rc.mu.Unlock()
	logf("video %4d pkt/s %6.0f kbps lost %3d (%5.1f%%) | audio %3d pkt/s %4.0f kbps lost %2d (%4.1f%%) | pc=%s",
		v.pkts, v.kbps, v.lost, v.lossPct, a.pkts, a.kbps, a.lost, a.lossPct, st)
}

func (rc *receiver) printSummary(label string) {
	rc.mu.Lock()
	conn, key := rc.connectedAt, rc.keyframeAt
	rc.mu.Unlock()
	logf("=== summary (%s) after %.1fs", label, time.Since(rc.start).Seconds())
	if !conn.IsZero() {
		logf("    connected at +%.2fs", rc.since(conn))
	} else {
		logf("    never connected")
	}
	if !key.IsZero() {
		logf("    first keyframe at +%.2fs", rc.since(key))
	}
	for _, s := range []*rxStats{rc.video, rc.audio} {
		pkts, bytes, lost, lossPct, first, last := s.totals()
		kbps := 0.0
		if d := last.Sub(first).Seconds(); d > 0 {
			kbps = float64(bytes) * 8 / d / 1000
		}
		logf("    %s: %d pkts, %.2f MB, avg %.0f kbps (first..last packet), lost %d (%.2f%%)",
			s.kind, pkts, float64(bytes)/1e6, kbps, lost, lossPct)
	}
}
