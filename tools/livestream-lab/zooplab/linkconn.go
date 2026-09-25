package main

// impairedConn wraps the single UDP socket used by the Ant Media emulator's
// ICE UDP mux. Writes (server -> client) go through the flow's down pipe;
// packets read from the socket (client -> server) go through the up pipe and
// are then handed to the mux via ReadFrom.

import (
	"errors"
	"log"
	"net"
	"net/netip"
	"sync"
	"time"
)

const flowIdleTimeout = 60 * time.Second

type inboundPacket struct {
	data []byte
	from netip.AddrPort
}

type impairedConn struct {
	udp  *net.UDPConn
	link *Link
	kind string

	mu    sync.Mutex
	flows map[netip.AddrPort]*Flow

	readCh    chan inboundPacket
	closed    chan struct{}
	closeOnce sync.Once
}

var _ net.PacketConn = (*impairedConn)(nil)

func newImpairedConn(udp *net.UDPConn, link *Link, kind string) *impairedConn {
	c := &impairedConn{
		udp:    udp,
		link:   link,
		kind:   kind,
		flows:  map[netip.AddrPort]*Flow{},
		readCh: make(chan inboundPacket, pipeQueueLen),
		closed: make(chan struct{}),
	}
	go c.readLoop()
	go c.expireLoop()
	return c
}

func unmapAddrPort(ap netip.AddrPort) netip.AddrPort {
	return netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
}

func (c *impairedConn) flow(ap netip.AddrPort) *Flow {
	c.mu.Lock()
	defer c.mu.Unlock()
	if f, ok := c.flows[ap]; ok {
		return f
	}
	f := c.link.NewFlow(c.kind, ap,
		func(b []byte) bool {
			_, err := c.udp.WriteToUDPAddrPort(b, ap)
			return err == nil
		},
		func(b []byte) bool {
			select {
			case c.readCh <- inboundPacket{data: b, from: ap}:
				return true
			default:
				return false
			}
		})
	c.flows[ap] = f
	log.Printf("[%s-udp] new flow %s (profile ip %s)", c.kind, ap, f.ip)
	return f
}

func (c *impairedConn) readLoop() {
	buf := make([]byte, 65536)
	for {
		n, ap, err := c.udp.ReadFromUDPAddrPort(buf)
		if err != nil {
			select {
			case <-c.closed:
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("[%s-udp] read error: %v", c.kind, err)
			time.Sleep(10 * time.Millisecond)
			continue
		}
		b := make([]byte, n)
		copy(b, buf[:n])
		c.flow(unmapAddrPort(ap)).SendUp(b)
	}
}

func (c *impairedConn) expireLoop() {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-c.closed:
			return
		case <-t.C:
		}
		c.mu.Lock()
		for ap, f := range c.flows {
			if f.Idle() > flowIdleTimeout {
				delete(c.flows, ap)
				f.Close()
				log.Printf("[%s-udp] flow %s expired (idle)", c.kind, ap)
			}
		}
		c.mu.Unlock()
	}
}

// ReadFrom returns the next packet that made it through an up pipe.
func (c *impairedConn) ReadFrom(p []byte) (int, net.Addr, error) {
	select {
	case pk := <-c.readCh:
		n := copy(p, pk.data)
		return n, net.UDPAddrFromAddrPort(pk.from), nil
	case <-c.closed:
		return 0, nil, net.ErrClosed
	}
}

// WriteTo queues the packet on the client's down pipe. It never blocks.
func (c *impairedConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	select {
	case <-c.closed:
		return 0, net.ErrClosed
	default:
	}
	var ap netip.AddrPort
	switch a := addr.(type) {
	case *net.UDPAddr:
		ap = a.AddrPort()
	default:
		parsed, err := netip.ParseAddrPort(addr.String())
		if err != nil {
			return 0, err
		}
		ap = parsed
	}
	b := make([]byte, len(p))
	copy(b, p)
	c.flow(unmapAddrPort(ap)).SendDown(b)
	return len(p), nil
}

func (c *impairedConn) Close() error {
	c.closeOnce.Do(func() {
		close(c.closed)
		_ = c.udp.Close()
		c.mu.Lock()
		for ap, f := range c.flows {
			f.Close()
			delete(c.flows, ap)
		}
		c.mu.Unlock()
	})
	return nil
}

func (c *impairedConn) LocalAddr() net.Addr { return c.udp.LocalAddr() }

// Deadlines are not needed: reads end on Close and writes never block.
func (c *impairedConn) SetDeadline(time.Time) error      { return nil }
func (c *impairedConn) SetReadDeadline(time.Time) error  { return nil }
func (c *impairedConn) SetWriteDeadline(time.Time) error { return nil }
