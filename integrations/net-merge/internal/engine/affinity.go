package engine

import (
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// Prefix affinity is bounded and sliding. Bulk promotion only affects NEW flows;
// an established TCP connection is never migrated between public IPs.
type destination struct {
	slot            *Slot
	touched, window time.Time
	active          int
	bytes           int64
	bulkUntil       time.Time
}

func destinationKey(host string) string {
	if ip, err := netip.ParseAddr(host); err == nil {
		ip = ip.Unmap()
		bits := 48
		if ip.Is4() {
			bits = 24
		}
		return netip.PrefixFrom(ip, bits).Masked().String()
	}
	return strings.ToLower(host)
}

func (s *Scheduler) SetSmart(on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.smart = on
}

func (s *Scheduler) ObserveRTT(sl *Slot, f Family, elapsed time.Duration) {
	if elapsed <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if sl.rtt[f] == 0 {
		sl.rtt[f] = elapsed
	} else {
		sl.rtt[f] += (elapsed - sl.rtt[f]) / 8
	}
	if sl.minRTT[f] == 0 || elapsed < sl.minRTT[f] {
		sl.minRTT[f] = elapsed
	}
}

func (s *Scheduler) acquireDestination(f Family, skip map[string]struct{}, host string, port int) (*Slot, *destination) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.smart {
		return s.acquireLocked(f, skip, nil, false), nil
	}
	if s.destinations == nil {
		s.destinations = make(map[string]*destination)
	}
	now := s.now()
	key := destinationKey(host)
	d := s.destinations[key]
	if d == nil || now.Sub(d.touched) > time.Minute && d.active == 0 {
		// Bound metadata even under a scan. Evicted active entries are kept alive
		// by their connections until those close; the map itself stays bounded.
		if len(s.destinations) >= 4096 {
			oldestKey := ""
			var oldest time.Time
			for k, entry := range s.destinations {
				if oldestKey == "" || entry.touched.Before(oldest) {
					oldestKey, oldest = k, entry.touched
				}
			}
			delete(s.destinations, oldestKey)
		}
		d = &destination{window: now}
		s.destinations[key] = d
	}
	interactive := port == 22 || port == 53
	preferred := d.slot
	if interactive {
		preferred = nil
	}
	if !interactive && now.Before(d.bulkUntil) {
		preferred = nil
	}
	sl := s.acquireLocked(f, skip, preferred, preferred == nil && (interactive || !now.Before(d.bulkUntil)))
	if sl == nil {
		return nil, nil
	}
	if preferred != nil || d.slot == nil {
		d.slot = sl
	}
	d.touched = now
	d.active++
	return sl, d
}

func (s *Scheduler) destinationBytes(d *destination, n int) {
	if d == nil || n <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if now.Sub(d.window) > 2*time.Second {
		d.window, d.bytes = now, 0
	}
	d.bytes += int64(n)
	d.touched = now
	if d.active > 3 && d.bytes >= 1<<20 {
		d.bulkUntil = now.Add(2 * time.Second)
	}
}

func (s *Scheduler) releaseDestination(d *destination) {
	if d == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d.active--
	d.touched = s.now()
}

type affinityConn struct {
	*net.TCPConn
	s    *Scheduler
	d    *destination
	once sync.Once
}

func (c *affinityConn) Read(p []byte) (int, error) {
	n, err := c.TCPConn.Read(p)
	c.s.destinationBytes(c.d, n)
	return n, err
}
func (c *affinityConn) Write(p []byte) (int, error) {
	n, err := c.TCPConn.Write(p)
	c.s.destinationBytes(c.d, n)
	return n, err
}
func (c *affinityConn) Close() error {
	c.once.Do(func() { c.s.releaseDestination(c.d) })
	return c.TCPConn.Close()
}

func (c *affinityConn) WriteTo(dst io.Writer) (int64, error)  { return io.Copy(dst, readerOnly{c}) }
func (c *affinityConn) ReadFrom(src io.Reader) (int64, error) { return io.Copy(writerOnly{c}, src) }
