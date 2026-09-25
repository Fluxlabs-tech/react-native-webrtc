package main

// Network impairment ("link") configuration: per-direction parameters,
// presets, schedules and the default / per-client-IP profile state.
// The packet path (flows and pipes) lives in pipe.go.

import (
	"fmt"
	"log"
	"math"
	"net"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// udpOverheadBytes approximates the IPv4 + UDP header bytes of every packet.
const udpOverheadBytes = 28

// defaultQueueMs is used when a rate is set without an explicit queue limit.
const defaultQueueMs = 300

const (
	dirDown = 0 // server -> client
	dirUp   = 1 // client -> server
)

// BurstLoss is a Gilbert-Elliott loss model. All values are percentages.
type BurstLoss struct {
	PGoodBad float64 `json:"pGoodBad"`
	PBadGood float64 `json:"pBadGood"`
	LossBad  float64 `json:"lossBad"`
}

// DirParams is the impairment applied to one direction.
type DirParams struct {
	RateKbps float64    `json:"rateKbps"`
	QueueMs  float64    `json:"queueMs"`
	DelayMs  float64    `json:"delayMs"`
	JitterMs float64    `json:"jitterMs"`
	LossPct  float64    `json:"lossPct"`
	Burst    *BurstLoss `json:"burst,omitempty"`
	Outage   bool       `json:"outage"`
}

// Profile holds both directions: Down is server -> client, Up is client -> server.
type Profile struct {
	Down DirParams `json:"down"`
	Up   DirParams `json:"up"`
}

func checkNum(name string, v, max float64) error {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || (max > 0 && v > max) {
		if max > 0 {
			return fmt.Errorf("%s must be within 0..%g", name, max)
		}
		return fmt.Errorf("%s must be >= 0", name)
	}
	return nil
}

func (d *DirParams) normalize() error {
	for _, c := range []struct {
		name string
		v    float64
		max  float64
	}{
		{"rateKbps", d.RateKbps, 0}, {"queueMs", d.QueueMs, 0}, {"delayMs", d.DelayMs, 0},
		{"jitterMs", d.JitterMs, 0}, {"lossPct", d.LossPct, 100},
	} {
		if err := checkNum(c.name, c.v, c.max); err != nil {
			return err
		}
	}
	if b := d.Burst; b != nil {
		for _, c := range []struct {
			name string
			v    float64
		}{{"burst.pGoodBad", b.PGoodBad}, {"burst.pBadGood", b.PBadGood}, {"burst.lossBad", b.LossBad}} {
			if err := checkNum(c.name, c.v, 100); err != nil {
				return err
			}
		}
	}
	if d.RateKbps > 0 && d.QueueMs == 0 {
		d.QueueMs = defaultQueueMs
	}
	return nil
}

func (p *Profile) normalize() error {
	if err := p.Down.normalize(); err != nil {
		return fmt.Errorf("down: %w", err)
	}
	if err := p.Up.normalize(); err != nil {
		return fmt.Errorf("up: %w", err)
	}
	return nil
}

// ---- presets and schedules ----

func symmetric(d DirParams) Profile { return Profile{Down: d, Up: d} }

func rated(downKbps, upKbps float64, d DirParams) Profile {
	p := Profile{Down: d, Up: d}
	p.Down.RateKbps = downKbps
	p.Up.RateKbps = upKbps
	return p
}

func downCap(kbps float64) Profile {
	return Profile{
		Down: DirParams{RateKbps: kbps, QueueMs: 300, DelayMs: 20},
		Up:   DirParams{DelayMs: 20},
	}
}

var presets = map[string]Profile{
	"clean":    {},
	"wifi":     rated(30000, 10000, DirParams{DelayMs: 5}),
	"4g":       rated(6000, 2000, DirParams{DelayMs: 30, JitterMs: 10, LossPct: 0.3}),
	"4g-poor":  rated(2000, 800, DirParams{DelayMs: 60, JitterMs: 40, LossPct: 1.5, QueueMs: 400}),
	"3g":       rated(1000, 400, DirParams{DelayMs: 120, JitterMs: 60, LossPct: 2, QueueMs: 600}),
	"edge":     rated(250, 100, DirParams{DelayMs: 250, JitterMs: 100, LossPct: 3, QueueMs: 1000}),
	"lossy-2":  symmetric(DirParams{LossPct: 2, DelayMs: 20}),
	"lossy-5":  symmetric(DirParams{LossPct: 5, DelayMs: 20}),
	"lossy-10": symmetric(DirParams{LossPct: 10, DelayMs: 20}),
	"burst":    symmetric(DirParams{Burst: &BurstLoss{PGoodBad: 1, PBadGood: 25, LossBad: 80}, DelayMs: 20}),
	"outage":   symmetric(DirParams{Outage: true}),
	"cap-3000": downCap(3000),
	"cap-2000": downCap(2000),
	"cap-1500": downCap(1500),
}

type schedStep struct {
	Preset string
	Dur    time.Duration
}

var schedules = map[string][]schedStep{
	"fluctuate": {
		{"4g", 20 * time.Second}, {"4g-poor", 15 * time.Second}, {"3g", 15 * time.Second},
		{"edge", 10 * time.Second}, {"outage", 4 * time.Second}, {"4g-poor", 10 * time.Second},
		{"wifi", 20 * time.Second},
	},
	"flaky": {
		{"4g", 10 * time.Second}, {"outage", 2 * time.Second}, {"4g", 15 * time.Second},
		{"lossy-10", 8 * time.Second}, {"4g", 10 * time.Second}, {"outage", 5 * time.Second},
	},
	"dips": {
		{"wifi", 20 * time.Second}, {"cap-2000", 15 * time.Second}, {"wifi", 20 * time.Second},
		{"3g", 15 * time.Second},
	},
	"long-outage": {
		{"4g", 15 * time.Second}, {"outage", 20 * time.Second}, {"4g", 30 * time.Second},
	},
}

func init() {
	for name, p := range presets {
		if err := p.normalize(); err != nil {
			panic(fmt.Sprintf("preset %s: %v", name, err))
		}
		presets[name] = p
	}
	for name, steps := range schedules {
		for _, st := range steps {
			if _, ok := presets[st.Preset]; !ok {
				panic(fmt.Sprintf("schedule %s uses unknown preset %s", name, st.Preset))
			}
		}
	}
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func describeSchedule(steps []schedStep) string {
	parts := make([]string, len(steps))
	for i, st := range steps {
		parts[i] = fmt.Sprintf("%s %s", st.Preset, st.Dur)
	}
	return strings.Join(parts, ", ")
}

// ---- profile state ----

// linkTarget is the profile applied to the default target or to one client IP.
type linkTarget struct {
	Name    string // preset name, "custom", or "<schedule>:<preset>"
	Profile Profile
}

// linkState is an immutable snapshot, swapped atomically on every change so
// the packet path can read it without locking.
type linkState struct {
	def       linkTarget
	overrides map[string]linkTarget // canonical client IP -> target
}

type schedRun struct {
	name     string
	target   string // "" = default profile, else client IP
	steps    []schedStep
	idx      int
	since    time.Time
	canceled bool
	stop     chan struct{}
}

// Link holds the impairment configuration and every active flow.
type Link struct {
	mediaIP string

	state atomic.Pointer[linkState]

	mu      sync.Mutex // serialises updates; guards changed and scheds
	changed chan struct{}
	scheds  map[string]*schedRun

	flowsMu sync.Mutex
	flows   map[*Flow]struct{}
}

func NewLink(mediaIP string) *Link {
	l := &Link{
		mediaIP: mediaIP,
		changed: make(chan struct{}),
		scheds:  map[string]*schedRun{},
		flows:   map[*Flow]struct{}{},
	}
	l.state.Store(&linkState{def: linkTarget{Name: "clean"}, overrides: map[string]linkTarget{}})
	return l
}

// CanonIP maps an address to the key used for per-client profiles. Loopback
// is treated as the media IP: the Android emulator and anything else running
// on this Mac reach it from the Mac's own address, while their HTTP/WebSocket
// connections may arrive on 127.0.0.1.
func (l *Link) CanonIP(a netip.Addr) string {
	a = a.Unmap()
	if a.IsLoopback() {
		return l.mediaIP
	}
	return a.WithZone("").String()
}

// CanonIPString accepts "ip" or "ip:port".
func (l *Link) CanonIPString(s string) (string, error) {
	s = strings.TrimSpace(s)
	if host, _, err := net.SplitHostPort(s); err == nil {
		s = host
	}
	a, err := netip.ParseAddr(strings.Trim(s, "[]"))
	if err != nil {
		return "", fmt.Errorf("bad client IP %q", s)
	}
	return l.CanonIP(a), nil
}

func (st *linkState) target(ip string) linkTarget {
	if t, ok := st.overrides[ip]; ok {
		return t
	}
	return st.def
}

// params returns the parameters for one direction of a client IP. It is
// called for every packet, so changes take effect immediately.
func (l *Link) params(ip string, dir int) DirParams {
	t := l.state.Load().target(ip)
	if dir == dirDown {
		return t.Profile.Down
	}
	return t.Profile.Up
}

func (l *Link) targetName(ip string) string {
	return l.state.Load().target(ip).Name
}

// InOutage reports whether either direction of a client IP is in outage.
func (l *Link) InOutage(ip string) bool {
	p := l.state.Load().target(ip).Profile
	return p.Down.Outage || p.Up.Outage
}

// Changed returns a channel that is closed at the next configuration change.
func (l *Link) Changed() <-chan struct{} {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.changed
}

// WaitNoOutage blocks while the client IP is in outage. It returns false if
// cancel fires or max (when > 0) elapses first.
func (l *Link) WaitNoOutage(ip string, cancel <-chan struct{}, max time.Duration) bool {
	var deadline <-chan time.Time
	if max > 0 {
		t := time.NewTimer(max)
		defer t.Stop()
		deadline = t.C
	}
	for {
		ch := l.Changed()
		if !l.InOutage(ip) {
			return true
		}
		select {
		case <-ch:
		case <-cancel:
			return false
		case <-deadline:
			return false
		}
	}
}

func targetLabel(target string) string {
	if target == "" {
		return "default"
	}
	return target
}

// applyLocked stores a new snapshot with target replaced. l.mu must be held.
func (l *Link) applyLocked(target string, t linkTarget) {
	old := l.state.Load()
	ns := &linkState{def: old.def, overrides: make(map[string]linkTarget, len(old.overrides)+1)}
	for k, v := range old.overrides {
		ns.overrides[k] = v
	}
	if target == "" {
		ns.def = t
	} else {
		ns.overrides[target] = t
	}
	l.state.Store(ns)
	close(l.changed)
	l.changed = make(chan struct{})
}

func (l *Link) cancelScheduleLocked(target string) {
	if r := l.scheds[target]; r != nil {
		r.canceled = true
		close(r.stop)
		delete(l.scheds, target)
		log.Printf("[link] schedule %q on %s stopped", r.name, targetLabel(target))
	}
}

// SetProfile applies a custom or preset profile, stopping any schedule on
// that target.
func (l *Link) SetProfile(target string, t linkTarget) {
	l.mu.Lock()
	l.cancelScheduleLocked(target)
	l.applyLocked(target, t)
	l.mu.Unlock()
	log.Printf("[link] %s -> %s %s", targetLabel(target), t.Name, profileSummary(t.Profile))
}

// SetPreset applies a preset or starts a schedule by name.
func (l *Link) SetPreset(target, name string) error {
	if steps, ok := schedules[name]; ok {
		l.mu.Lock()
		l.cancelScheduleLocked(target)
		r := &schedRun{name: name, target: target, steps: steps, stop: make(chan struct{})}
		l.scheds[target] = r
		l.mu.Unlock()
		log.Printf("[link] schedule %q started on %s: %s (cycles until changed)", name, targetLabel(target), describeSchedule(steps))
		go l.runSchedule(r)
		return nil
	}
	p, ok := presets[name]
	if !ok {
		return fmt.Errorf("unknown preset or schedule %q", name)
	}
	l.SetProfile(target, linkTarget{Name: name, Profile: p})
	return nil
}

func (l *Link) runSchedule(r *schedRun) {
	for i := 0; ; i = (i + 1) % len(r.steps) {
		st := r.steps[i]
		l.mu.Lock()
		if r.canceled {
			l.mu.Unlock()
			return
		}
		r.idx = i
		r.since = time.Now()
		l.applyLocked(r.target, linkTarget{Name: r.name + ":" + st.Preset, Profile: presets[st.Preset]})
		l.mu.Unlock()
		log.Printf("[link] schedule %q on %s: step %d/%d -> %s for %s", r.name, targetLabel(r.target), i+1, len(r.steps), st.Preset, st.Dur)
		t := time.NewTimer(st.Dur)
		select {
		case <-t.C:
		case <-r.stop:
			t.Stop()
			return
		}
	}
}

// DeleteOverride removes a client override (and its schedule).
func (l *Link) DeleteOverride(ip string) bool {
	l.mu.Lock()
	l.cancelScheduleLocked(ip)
	_, existed := l.state.Load().overrides[ip]
	if existed {
		old := l.state.Load()
		ns := &linkState{def: old.def, overrides: map[string]linkTarget{}}
		for k, v := range old.overrides {
			if k != ip {
				ns.overrides[k] = v
			}
		}
		l.state.Store(ns)
		close(l.changed)
		l.changed = make(chan struct{})
	}
	l.mu.Unlock()
	if existed {
		log.Printf("[link] override for %s removed (now uses default)", ip)
	}
	return existed
}

// Reset sets the default to clean and removes all overrides and schedules.
func (l *Link) Reset() {
	l.mu.Lock()
	for target := range l.scheds {
		l.cancelScheduleLocked(target)
	}
	l.state.Store(&linkState{def: linkTarget{Name: "clean"}, overrides: map[string]linkTarget{}})
	close(l.changed)
	l.changed = make(chan struct{})
	l.mu.Unlock()
	log.Printf("[link] reset: default clean, all overrides and schedules removed")
}

func dirSummary(d DirParams) string {
	if d.Outage {
		return "OUTAGE"
	}
	var parts []string
	if d.RateKbps > 0 {
		parts = append(parts, fmt.Sprintf("%gkbps q%gms", d.RateKbps, d.QueueMs))
	}
	if d.DelayMs > 0 {
		parts = append(parts, fmt.Sprintf("delay %gms", d.DelayMs))
	}
	if d.JitterMs > 0 {
		parts = append(parts, fmt.Sprintf("jitter %gms", d.JitterMs))
	}
	if d.LossPct > 0 {
		parts = append(parts, fmt.Sprintf("loss %g%%", d.LossPct))
	}
	if b := d.Burst; b != nil {
		parts = append(parts, fmt.Sprintf("GE(%g/%g/%g)", b.PGoodBad, b.PBadGood, b.LossBad))
	}
	if len(parts) == 0 {
		return "clean"
	}
	return strings.Join(parts, " ")
}

func profileSummary(p Profile) string {
	return fmt.Sprintf("[down: %s | up: %s]", dirSummary(p.Down), dirSummary(p.Up))
}

// ---- JSON view for GET /lab/link ----

type schedView struct {
	Name         string    `json:"name"`
	Step         int       `json:"step"`
	Steps        int       `json:"steps"`
	Preset       string    `json:"preset"`
	Since        time.Time `json:"since"`
	RemainingSec float64   `json:"remainingSec"`
}

type targetView struct {
	Name     string     `json:"name"`
	Summary  string     `json:"summary"`
	Profile  Profile    `json:"profile"`
	Schedule *schedView `json:"schedule,omitempty"`
}

type linkView struct {
	MediaIP   string                `json:"mediaIp"`
	Default   targetView            `json:"default"`
	Overrides map[string]targetView `json:"overrides"`
	Flows     []flowView            `json:"flows"`
	Presets   []string              `json:"presets"`
	Schedules map[string]string     `json:"schedules"`
}

func (l *Link) View() linkView {
	st := l.state.Load()
	l.mu.Lock()
	sv := map[string]*schedView{}
	for target, r := range l.scheds {
		if r.since.IsZero() {
			continue
		}
		step := r.steps[r.idx]
		sv[target] = &schedView{
			Name: r.name, Step: r.idx + 1, Steps: len(r.steps), Preset: step.Preset, Since: r.since,
			RemainingSec: math.Round(math.Max(0, (step.Dur-time.Since(r.since)).Seconds())*10) / 10,
		}
	}
	l.mu.Unlock()
	mk := func(target string, t linkTarget) targetView {
		return targetView{Name: t.Name, Summary: profileSummary(t.Profile), Profile: t.Profile, Schedule: sv[target]}
	}
	v := linkView{
		MediaIP:   l.mediaIP,
		Default:   mk("", st.def),
		Overrides: map[string]targetView{},
		Flows:     l.flowViews(),
		Presets:   sortedKeys(presets),
		Schedules: map[string]string{},
	}
	for ip, t := range st.overrides {
		v.Overrides[ip] = mk(ip, t)
	}
	for name, steps := range schedules {
		v.Schedules[name] = describeSchedule(steps)
	}
	return v
}
