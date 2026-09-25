package main

// WHEP proxy toward mediamtx (media goes through the impaired UDP relay),
// SDP candidate rewriting, and the small WHEP client used for upstreams.

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ---- SDP helpers ----

func sdpLines(s string) []string {
	raw := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(raw))
	for _, l := range raw {
		if l = strings.TrimRight(l, "\r"); l != "" {
			out = append(out, l)
		}
	}
	return out
}

func sdpJoin(lines []string) string { return strings.Join(lines, "\r\n") + "\r\n" }

func isCandidateLine(l string) bool {
	return strings.HasPrefix(l, "a=candidate:") || strings.HasPrefix(l, "a=end-of-candidates")
}

// stripCandidates removes a=candidate and a=end-of-candidates lines.
func stripCandidates(sdp string) string {
	var out []string
	for _, l := range sdpLines(sdp) {
		if !isCandidateLine(l) {
			out = append(out, l)
		}
	}
	return sdpJoin(out)
}

// replaceCandidates removes all candidates and puts candidateLine followed by
// a=end-of-candidates at the end of every media section.
func replaceCandidates(sdp, candidateLine string) string {
	var out []string
	inMedia := false
	closeSection := func() {
		if inMedia {
			out = append(out, candidateLine, "a=end-of-candidates")
		}
	}
	for _, l := range sdpLines(sdp) {
		switch {
		case strings.HasPrefix(l, "m="):
			closeSection()
			inMedia = true
			out = append(out, l)
		case isCandidateLine(l):
		default:
			out = append(out, l)
		}
	}
	closeSection()
	return sdpJoin(out)
}

func candidateLines(sdp string) []string {
	var out []string
	for _, l := range sdpLines(sdp) {
		if strings.HasPrefix(l, "a=candidate:") {
			out = append(out, strings.TrimPrefix(l, "a="))
		}
	}
	return out
}

func hostCandidate(ip string, port int) string {
	return fmt.Sprintf("a=candidate:1 1 udp 2130706431 %s %d typ host", ip, port)
}

// ---- WHEP client ----

var httpClient = &http.Client{Timeout: 10 * time.Second}

// whepPost posts an offer; it returns the answer and the absolute resource URL.
func whepPost(ctx context.Context, endpoint, offer string) (answer, resource string, status int, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(offer))
	if err != nil {
		return "", "", 0, err
	}
	req.Header.Set("Content-Type", "application/sdp")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", "", 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusCreated {
		return "", "", resp.StatusCode, fmt.Errorf("WHEP POST %s: %s: %s", endpoint, resp.Status, strings.TrimSpace(string(body)))
	}
	if loc := resp.Header.Get("Location"); loc != "" {
		if base, perr := url.Parse(endpoint); perr == nil {
			if ref, perr := url.Parse(loc); perr == nil {
				resource = base.ResolveReference(ref).String()
			}
		}
	}
	return string(body), resource, resp.StatusCode, nil
}

func whepDelete(resource string) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, resource, nil)
	if err != nil {
		return 0, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

// ---- WHEP proxy ----

type whepProxy struct {
	mediamtx  string // e.g. http://127.0.0.1:8889
	candidate string // relay host candidate line
}

func newWHEPProxy(cfg *Config) *whepProxy {
	return &whepProxy{
		mediamtx:  strings.TrimRight(cfg.MediaMTX, "/"),
		candidate: hostCandidate(cfg.MediaIP, cfg.RelayUDP),
	}
}

// handlePost serves POST /whep/{path...}.
func (p *whepProxy) handlePost(w http.ResponseWriter, r *http.Request) {
	p.forwardOffer(w, r, strings.Trim(r.PathValue("path"), "/"))
}

// handleLive serves POST /live/whep/{id}, equivalent to /whep/ams/{id}.
func (p *whepProxy) handleLive(w http.ResponseWriter, r *http.Request) {
	p.forwardOffer(w, r, "ams/"+r.PathValue("id"))
}

func (p *whepProxy) forwardOffer(w http.ResponseWriter, r *http.Request, path string) {
	if path == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	offer := stripCandidates(string(body))
	target := p.mediamtx + "/" + path + "/whep"
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, strings.NewReader(offer))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/sdp"
	}
	req.Header.Set("Content-Type", ct)
	if a := r.Header.Get("Authorization"); a != "" {
		req.Header.Set("Authorization", a)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("[whep] POST %s from %s: upstream error: %v", path, r.RemoteAddr, err)
		http.Error(w, "upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	rct := resp.Header.Get("Content-Type")
	if resp.StatusCode == http.StatusCreated && strings.HasPrefix(rct, "application/sdp") {
		rb = []byte(replaceCandidates(string(rb), p.candidate))
	}
	if rct != "" {
		w.Header().Set("Content-Type", rct)
	}
	if etag := resp.Header.Get("ETag"); etag != "" {
		w.Header().Set("ETag", etag)
	}
	location := ""
	if loc := resp.Header.Get("Location"); loc != "" {
		if u, err := url.Parse(loc); err == nil {
			location = "/whep-session" + u.EscapedPath()
			w.Header().Set("Location", location)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(rb)
	log.Printf("[whep] POST %s from %s -> %d (offer %d candidates stripped; location %s)",
		path, r.RemoteAddr, resp.StatusCode, len(candidateLines(string(body))), location)
}

// handleSessionDelete forwards DELETE /whep-session/{rest...} to mediamtx.
func (p *whepProxy) handleSessionDelete(w http.ResponseWriter, r *http.Request) {
	target := p.mediamtx + "/" + strings.TrimLeft(r.PathValue("rest"), "/")
	status, err := whepDelete(target)
	if err != nil {
		log.Printf("[whep] DELETE %s: %v", target, err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	log.Printf("[whep] DELETE %s from %s -> %d", target, r.RemoteAddr, status)
	w.WriteHeader(status)
}

// handleSessionPatch answers trickle PATCHes without forwarding them, so
// client candidates never reach mediamtx.
func (p *whepProxy) handleSessionPatch(w http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 1<<20))
	w.WriteHeader(http.StatusNoContent)
}
