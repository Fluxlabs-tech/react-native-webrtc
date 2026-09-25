package main

// Packet path of the link emulator: one Flow per client ip:port, holding one
// pipe per direction. Each pipe serialises packets at the configured rate,
// tail-drops on queue overflow, applies loss, delay and jitter, and hands the
// packet to a single delivery goroutine through a FIFO channel. Delivery
// times never decrease, so packets are never reordered.

import (
	"math"
	"math/rand/v2"
	"net/netip"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const pipeQueueLen = 4096

type queuedPacket struct {
	data []byte
	due  time.Time
}

type pipe struct {
	flow    *Flow
	dir     int
	deliver func([]byte) bool // returns false if the receiver dropped it
	ch      chan queuedPacket

	mu       sync.Mutex
	nextFree time.Time // when the serialiser is free again
	lastDue  time.Time // delivery time of the previous packet (FIFO clamp)
	geBad    bool      // Gilbert-Elliott state

	pktsIn, bytesIn, pktsOut, bytesOut atomic.Uint64
	dropLoss, dropQueue, dropOutage    atomic.Uint64
}

// Flow is one client address (ip:port) with a pipe per direction.
type Flow struct {
	link    *Link
	kind    string // "ams" or "relay"
	client  netip.AddrPort
	ip      string // canonical IP used for the profile lookup
	created time.Time
	last    atomic.Int64 // unix nanos of the last packet in either direction
	down    *pipe
	up      *pipe
	stop    chan struct{}
	once    sync.Once
}

// NewFlow creates a flow and starts its two delivery goroutines.
// deliverDown sends toward the client, deliverUp toward the server.
func (l *Link) NewFlow(kind string, client netip.AddrPort, deliverDown, deliverUp func([]byte) bool) *Flow {
	f := &Flow{
		link:    l,
		kind:    kind,
		client:  client,
		ip:      l.CanonIP(client.Addr()),
		created: time.Now(),
		stop:    make(chan struct{}),
	}
	f.last.Store(f.created.UnixNano())
	f.down = &pipe{flow: f, dir: dirDown, deliver: deliverDown, ch: make(chan queuedPacket, pipeQueueLen)}
	f.up = &pipe{flow: f, dir: dirUp, deliver: deliverUp, ch: make(chan queuedPacket, pipeQueueLen)}
	go f.down.run()
	go f.up.run()
	l.flowsMu.Lock()
	l.flows[f] = struct{}{}
	l.flowsMu.Unlock()
	return f
}

// Close stops the delivery goroutines; queued packets are discarded.
func (f *Flow) Close() {
	f.once.Do(func() {
		close(f.stop)
		f.link.flowsMu.Lock()
		delete(f.link.flows, f)
		f.link.flowsMu.Unlock()
	})
}

func (f *Flow) Idle() time.Duration {
	return time.Since(time.Unix(0, f.last.Load()))
}

// SendDown queues a packet toward the client. The flow takes ownership of b.
func (f *Flow) SendDown(b []byte) { f.down.send(b) }

// SendUp queues a packet toward the server. The flow takes ownership of b.
func (f *Flow) SendUp(b []byte) { f.up.send(b) }

func msDur(ms float64) time.Duration { return time.Duration(ms * float64(time.Millisecond)) }

func chance(pct float64) bool { return pct > 0 && rand.Float64()*100 < pct }

func (p *pipe) send(b []byte) {
	f := p.flow
	now := time.Now()
	f.last.Store(now.UnixNano())
	p.pktsIn.Add(1)
	p.bytesIn.Add(uint64(len(b)))

	prm := f.link.params(f.ip, p.dir)
	if prm.Outage {
		p.dropOutage.Add(1)
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// Loss: Gilbert-Elliott state transition, then its loss, then random loss.
	lost := false
	if g := prm.Burst; g != nil {
		if p.geBad {
			if chance(g.PBadGood) {
				p.geBad = false
			}
		} else if chance(g.PGoodBad) {
			p.geBad = true
		}
		lost = p.geBad && chance(g.LossBad)
	} else {
		p.geBad = false
	}
	if !lost && chance(prm.LossPct) {
		lost = true
	}
	if lost {
		p.dropLoss.Add(1)
		return
	}

	// Rate: serialise with nextFree = max(now, nextFree) + size/rate and
	// tail-drop when the backlog exceeds the queue limit.
	depart := now
	if prm.RateKbps > 0 {
		if p.nextFree.Before(now) {
			p.nextFree = now
		}
		queueMs := prm.QueueMs
		if queueMs <= 0 {
			queueMs = defaultQueueMs
		}
		if p.nextFree.Sub(now) > msDur(queueMs) {
			p.dropQueue.Add(1)
			return
		}
		bits := float64((len(b) + udpOverheadBytes) * 8)
		p.nextFree = p.nextFree.Add(time.Duration(bits / (prm.RateKbps * 1000) * float64(time.Second)))
		depart = p.nextFree
	} else {
		p.nextFree = now
	}

	// Delay + jitter, clamped so delivery order is preserved.
	due := depart.Add(msDur(prm.DelayMs))
	if prm.JitterMs > 0 {
		due = due.Add(msDur(rand.Float64() * prm.JitterMs))
	}
	if due.Before(p.lastDue) {
		due = p.lastDue
	}

	select {
	case p.ch <- queuedPacket{data: b, due: due}:
		p.lastDue = due
	default:
		p.dropQueue.Add(1)
	}
}

// run is the pipe's single delivery goroutine. It sleeps on one reusable
// timer until the head packet is due.
func (p *pipe) run() {
	f := p.flow
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	for {
		var q queuedPacket
		select {
		case q = <-p.ch:
		case <-f.stop:
			return
		}
		if d := time.Until(q.due); d > 0 {
			timer.Reset(d)
			select {
			case <-timer.C:
			case <-f.stop:
				timer.Stop()
				return
			}
		}
		// An outage that started while the packet was in flight drops it too.
		if f.link.params(f.ip, p.dir).Outage {
			p.dropOutage.Add(1)
			continue
		}
		if !p.deliver(q.data) {
			p.dropQueue.Add(1)
			continue
		}
		p.pktsOut.Add(1)
		p.bytesOut.Add(uint64(len(q.data)))
	}
}

// ---- counters ----

type pipeView struct {
	PktsIn       uint64  `json:"pktsIn"`
	BytesIn      uint64  `json:"bytesIn"`
	PktsOut      uint64  `json:"pktsOut"`
	BytesOut     uint64  `json:"bytesOut"`
	DropLoss     uint64  `json:"dropLoss"`
	DropQueue    uint64  `json:"dropQueue"`
	DropOutage   uint64  `json:"dropOutage"`
	QueueDelayMs float64 `json:"queueDelayMs"`
	InFlight     int     `json:"inFlight"`
}

type flowView struct {
	Kind      string   `json:"kind"`
	Client    string   `json:"client"`
	ProfileIP string   `json:"profileIp"`
	Profile   string   `json:"profile"`
	AgeSec    float64  `json:"ageSec"`
	IdleSec   float64  `json:"idleSec"`
	Down      pipeView `json:"down"`
	Up        pipeView `json:"up"`
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

func (p *pipe) view() pipeView {
	p.mu.Lock()
	qd := time.Until(p.nextFree)
	p.mu.Unlock()
	if qd < 0 {
		qd = 0
	}
	return pipeView{
		PktsIn: p.pktsIn.Load(), BytesIn: p.bytesIn.Load(),
		PktsOut: p.pktsOut.Load(), BytesOut: p.bytesOut.Load(),
		DropLoss: p.dropLoss.Load(), DropQueue: p.dropQueue.Load(), DropOutage: p.dropOutage.Load(),
		QueueDelayMs: round1(float64(qd) / float64(time.Millisecond)),
		InFlight:     len(p.ch),
	}
}

func (l *Link) flowViews() []flowView {
	l.flowsMu.Lock()
	flows := make([]*Flow, 0, len(l.flows))
	for f := range l.flows {
		flows = append(flows, f)
	}
	l.flowsMu.Unlock()
	sort.Slice(flows, func(i, j int) bool { return flows[i].created.Before(flows[j].created) })
	out := make([]flowView, 0, len(flows))
	for _, f := range flows {
		out = append(out, flowView{
			Kind:      f.kind,
			Client:    f.client.String(),
			ProfileIP: f.ip,
			Profile:   l.targetName(f.ip),
			AgeSec:    round1(time.Since(f.created).Seconds()),
			IdleSec:   round1(f.Idle().Seconds()),
			Down:      f.down.view(),
			Up:        f.up.view(),
		})
	}
	return out
}
