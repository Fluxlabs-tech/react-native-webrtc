package main

// UDP relay used by the WHEP proxy: clients send ICE/DTLS/SRTP to
// <media-ip>:<relay-udp>; each client address gets its own upstream socket to
// mediamtx's ICE port, so mediamtx sees one peer-reflexive address per client.
// Both directions pass through that client's impairment pipes
// (down = mediamtx -> client, up = client -> mediamtx).

import (
	"errors"
	"log"
	"net"
	"net/netip"
	"sync"
	"time"
)

type relayFlow struct {
	flow *Flow
	up   *net.UDPConn
}

type relay struct {
	link   *Link
	conn   *net.UDPConn
	target *net.UDPAddr

	mu     sync.Mutex
	flows  map[netip.AddrPort]*relayFlow
	closed chan struct{}
}

func newRelay(link *Link, port int, target string) (*relay, error) {
	taddr, err := net.ResolveUDPAddr("udp4", target)
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: port})
	if err != nil {
		return nil, err
	}
	r := &relay{link: link, conn: conn, target: taddr, flows: map[netip.AddrPort]*relayFlow{}, closed: make(chan struct{})}
	go r.readLoop()
	go r.expireLoop()
	return r, nil
}

func (r *relay) getFlow(ap netip.AddrPort) (*relayFlow, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if rf, ok := r.flows[ap]; ok {
		return rf, nil
	}
	up, err := net.DialUDP("udp4", nil, r.target)
	if err != nil {
		return nil, err
	}
	rf := &relayFlow{up: up}
	rf.flow = r.link.NewFlow("relay", ap,
		func(b []byte) bool { // down: toward the client
			_, err := r.conn.WriteToUDPAddrPort(b, ap)
			return err == nil
		},
		func(b []byte) bool { // up: toward mediamtx
			_, err := up.Write(b)
			return err == nil
		})
	r.flows[ap] = rf
	log.Printf("[relay] new flow %s <-> %s via %s (profile ip %s)", ap, r.target, up.LocalAddr(), rf.flow.ip)
	go func() {
		buf := make([]byte, 65536)
		for {
			n, err := up.Read(buf)
			if err != nil {
				if errors.Is(err, net.ErrClosed) {
					return
				}
				// ICMP port unreachable etc. are transient on UDP.
				select {
				case <-rf.flow.stop:
					return
				default:
				}
				time.Sleep(10 * time.Millisecond)
				continue
			}
			b := make([]byte, n)
			copy(b, buf[:n])
			rf.flow.SendDown(b)
		}
	}()
	return rf, nil
}

func (r *relay) readLoop() {
	buf := make([]byte, 65536)
	for {
		n, ap, err := r.conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			select {
			case <-r.closed:
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("[relay] read error: %v", err)
			time.Sleep(10 * time.Millisecond)
			continue
		}
		rf, err := r.getFlow(unmapAddrPort(ap))
		if err != nil {
			log.Printf("[relay] cannot create flow for %s: %v", ap, err)
			continue
		}
		b := make([]byte, n)
		copy(b, buf[:n])
		rf.flow.SendUp(b)
	}
}

func (r *relay) expireLoop() {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.closed:
			return
		case <-t.C:
		}
		r.mu.Lock()
		for ap, rf := range r.flows {
			if rf.flow.Idle() > flowIdleTimeout {
				delete(r.flows, ap)
				rf.flow.Close()
				_ = rf.up.Close()
				log.Printf("[relay] flow %s expired (idle)", ap)
			}
		}
		r.mu.Unlock()
	}
}

func (r *relay) Close() {
	select {
	case <-r.closed:
		return
	default:
	}
	close(r.closed)
	_ = r.conn.Close()
	r.mu.Lock()
	for ap, rf := range r.flows {
		rf.flow.Close()
		_ = rf.up.Close()
		delete(r.flows, ap)
	}
	r.mu.Unlock()
}
