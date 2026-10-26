package engine

import (
	"bufio"
	"context"
	"net-merge/internal/nics"
	"testing"
	"time"
)

func smartScheduler() *Scheduler {
	s := NewScheduler([]nics.Nic{nic("fiber", "10.0.0.1", 1), nic("mobile", "10.0.1.1", 1)})
	s.SetSmart(true)
	s.ObserveRTT(s.slots[0], Fam4, 10*time.Millisecond)
	s.ObserveRTT(s.slots[1], Fam4, 80*time.Millisecond)
	return s
}

func TestDestinationPrefixes(t *testing.T) {
	for _, pair := range [][2]string{{"203.0.113.1", "203.0.113.252"}, {"2001:db8:1::1", "2001:db8:1:abcd::1"}, {"::ffff:203.0.113.1", "203.0.113.2"}} {
		if destinationKey(pair[0]) != destinationKey(pair[1]) {
			t.Fatal(pair)
		}
	}
	if destinationKey("2001:db8:1::1") == destinationKey("2001:db8:2::1") {
		t.Fatal("prefix too broad")
	}
}

func TestAffinityAndBulkPromotion(t *testing.T) {
	s := smartScheduler()
	var d *destination
	for i := 0; i < 4; i++ {
		sl, entry := s.acquireDestination(Fam4, nil, "203.0.113.1", 443)
		d = entry
		if sl.Name != "fiber" {
			t.Fatal("normal browsing lost affinity")
		}
	}
	s.destinationBytes(d, 1<<20)
	sl, _ := s.acquireDestination(Fam4, nil, "203.0.113.2", 443)
	if sl.Name != "mobile" {
		t.Fatal("bulk traffic did not spill to idle link")
	}
	ssh, _ := s.acquireDestination(Fam4, nil, "203.0.113.3", 22)
	if ssh.Name != "fiber" {
		t.Fatal("interactive traffic followed bulk promotion")
	}
}

func TestAffinityFailoverExpiryAndSkip(t *testing.T) {
	s := smartScheduler()
	now := time.Now()
	s.now = func() time.Time { return now }
	first, d := s.acquireDestination(Fam4, nil, "203.0.113.1", 443)
	fallback, next := s.acquireDestination(Fam4, map[string]struct{}{first.Name: {}}, "203.0.113.1", 443)
	if fallback == first || next != d {
		t.Fatal("dial retry did not fail over")
	}
	s.Release(first)
	s.releaseDestination(d)
	s.Release(fallback)
	s.releaseDestination(next)
	now = now.Add(61 * time.Second)
	refreshed, fresh := s.acquireDestination(Fam4, nil, "203.0.113.1", 443)
	if fresh == d || refreshed.Name != "fiber" {
		t.Fatal("idle affinity did not expire")
	}
	s.SetState(refreshed, Fam4, false)
	s.SetState(s.slots[1], Fam4, true)
	healthy, _ := s.acquireDestination(Fam4, nil, "203.0.113.1", 443)
	if healthy == refreshed {
		t.Fatal("affinity overrode link health")
	}
}

func TestBulkThresholdAndWindow(t *testing.T) {
	s := smartScheduler()
	now := time.Now()
	s.now = func() time.Time { return now }
	_, d := s.acquireDestination(Fam4, nil, "203.0.113.1", 443)
	s.destinationBytes(d, 2<<20)
	if !d.bulkUntil.IsZero() {
		t.Fatal("single flow promoted")
	}
	for i := 0; i < 3; i++ {
		s.acquireDestination(Fam4, nil, "203.0.113.1", 443)
	}
	now = now.Add(3 * time.Second)
	s.destinationBytes(d, 100)
	if !d.bulkUntil.IsZero() {
		t.Fatal("stale traffic promoted")
	}
}

func TestAffinityCacheBound(t *testing.T) {
	s := smartScheduler()
	for i := 0; i < 4200; i++ {
		host := time.Unix(int64(i), 0).String()
		sl, d := s.acquireDestination(Fam4, nil, host, 443)
		s.Release(sl)
		s.releaseDestination(d)
	}
	if len(s.destinations) > 4096 {
		t.Fatal("unbounded metadata")
	}
}

func TestSmartPinnedTCPAccountsAndReleases(t *testing.T) {
	needLoopbackAliases(t)
	port := startTarget(t)
	s := NewScheduler([]nics.Nic{nic("loopback", "127.0.0.2", 1)})
	s.SetSmart(true)
	conn, err := NewBalancer(s).DialPinned(context.Background(), "127.0.0.1", port)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	reader := bufio.NewReader(conn)
	if _, err := reader.ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write([]byte("payload\n")); err != nil {
		t.Fatal(err)
	}
	if line, err := reader.ReadString('\n'); err != nil || line != "payload\n" {
		t.Fatal(line, err)
	}
	conn.Close()
	if s.Snapshot()[0].Active != 0 {
		t.Fatal("pinned connection leaked a slot")
	}
	for _, d := range s.destinations {
		if d.active != 0 || d.bytes == 0 {
			t.Fatal("affinity accounting was not released", d.active, d.bytes)
		}
	}
}
