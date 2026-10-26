package engine

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"

	"net-merge/internal/nics"
)

// slotConn counts a pinned TCP flow's bytes and releases its slot on Close. It exposes
// CloseRead/CloseWrite because the TUN relay half-closes each direction separately.
type slotConn struct {
	*net.TCPConn
	sl       *Slot
	fam      Family
	s        *Scheduler
	once     sync.Once
	activity *flowActivity
	affinity *affinityConn
}

// TCPConn's promoted WriterTo/ReaderFrom would otherwise bypass Read/Write when
// tun2socks calls io.CopyBuffer. Hide those shortcuts at both ends of the copy.
type readerOnly struct{ io.Reader }
type writerOnly struct{ io.Writer }

func (c *slotConn) WriteTo(dst io.Writer) (int64, error) {
	return io.Copy(dst, readerOnly{c})
}
func (c *slotConn) ReadFrom(src io.Reader) (int64, error) {
	return io.Copy(writerOnly{c}, src)
}

func (c *slotConn) Read(p []byte) (int, error) {
	if pair := c.sl.limit.Load(); pair != nil && len(p) > pair.chunk {
		p = p[:pair.chunk] // hand out a chunk at a time, so a limited flow stays smooth
	}
	n, err := c.TCPConn.Read(p)
	granted := c.sl.grantBytes(n)
	if granted < n {
		c.Close()
		n, err = granted, ErrQuota
	}
	if n > 0 {
		c.sl.bytesIn[c.fam].Add(int64(n))
		if c.affinity != nil {
			c.s.destinationBytes(c.affinity.d, n)
		}
		if c.activity != nil {
			c.activity.bytes.Add(int64(n))
		}
		c.sl.throttle(true, n)
	}
	return n, err
}

func (c *slotConn) Write(p []byte) (int, error) {
	n, err := c.sl.writePaced(c.TCPConn, p, false)
	c.sl.bytesOut[c.fam].Add(int64(n))
	if c.affinity != nil {
		c.s.destinationBytes(c.affinity.d, n)
	}
	if c.activity != nil {
		c.activity.bytes.Add(int64(n))
	}
	return n, err
}

// release frees the slot's balancing count. It happens at the first half-close, not at the final
// Close: the relay can keep a finished flow open for up to a minute waiting for the peer's FIN,
// and counting those as active would steer new flows away from the NIC that just finished.
func (c *slotConn) release() {
	c.once.Do(func() {
		c.s.untrack(c.sl, c.fam, c.activity)
		c.s.ReleaseFor(c.sl, c.fam)
	})
}

func (c *slotConn) CloseRead() error  { c.release(); return c.TCPConn.CloseRead() }
func (c *slotConn) CloseWrite() error { c.release(); return c.TCPConn.CloseWrite() }
func (c *slotConn) Close() error {
	c.release()
	if c.affinity != nil {
		return c.affinity.Close()
	}
	return c.TCPConn.Close()
}

// DialPinned is DialTCP for front-ends that hand the conn to someone else to pump.
func (b *Balancer) DialPinned(ctx context.Context, host string, port int) (net.Conn, error) {
	c, sl, f, err := b.DialTCP(ctx, host, port)
	if err != nil {
		return nil, err
	}
	result := &slotConn{sl: sl, fam: f, s: b.S, activity: b.S.track(sl, f)}
	if affinity, ok := c.(*affinityConn); ok {
		result.TCPConn, result.affinity = affinity.TCPConn, affinity
	} else {
		result.TCPConn = c.(*net.TCPConn)
	}
	return result, nil
}

type slotPacketConn struct {
	net.PacketConn
	sl  *Slot
	fam Family
}

func (c *slotPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	n, a, err := c.PacketConn.ReadFrom(p)
	if !c.sl.allowBytes(n) {
		c.Close()
		return 0, a, ErrQuota
	}
	if n > 0 {
		c.sl.bytesIn[c.fam].Add(int64(n))
		c.sl.throttlePacket(true, n)
	}
	return n, a, err
}

func (c *slotPacketConn) WriteTo(p []byte, a net.Addr) (int, error) {
	if !c.sl.allowBytes(len(p)) {
		c.Close()
		return 0, ErrQuota
	}
	c.sl.throttlePacket(false, len(p))
	n, err := c.PacketConn.WriteTo(p, a)
	c.sl.bytesOut[c.fam].Add(int64(n))
	return n, err
}

// ListenUDP opens a UDP socket pinned to one NIC (a UDP "flow" = the socket, so every datagram
// of that flow leaves the same way). UDP flows are short and numerous (DNS), so they don't hold
// a balancing slot: the pick still spreads them via the scheduler's tie-breaking.
func (b *Balancer) ListenUDP(ctx context.Context, f Family) (net.PacketConn, error) {
	return b.ListenUDPFor(ctx, f, 0)
}

func (b *Balancer) ListenUDPFor(ctx context.Context, f Family, port int) (net.PacketConn, error) {
	network := "udp4"
	if f == Fam6 {
		network = "udp6"
	}
	tried := map[string]struct{}{}
	lastErr := errors.New("no usable network adapter")
	for {
		b.S.mu.Lock()
		sl := b.S.acquireLocked(f, tried, nil, b.S.smart && port == 53)
		b.S.mu.Unlock()
		if sl == nil {
			return nil, lastErr
		}
		tried[sl.key] = struct{}{}
		lc := net.ListenConfig{Control: nics.ForceEgress(sl.Index, f == Fam6)}
		pc, err := lc.ListenPacket(ctx, network, net.JoinHostPort(sl.ip(f).String(), "0"))
		b.S.ReleaseFor(sl, f)
		if err != nil {
			if classify(err).linkDown {
				b.S.Fail(sl, f, b.FailCooldown)
			}
			lastErr = err
			continue
		}
		return &slotPacketConn{PacketConn: pc, sl: sl, fam: f}, nil
	}
}
