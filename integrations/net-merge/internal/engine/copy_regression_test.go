package engine

import (
	"bytes"
	"context"
	"io"
	"net"
	"net-merge/internal/nics"
	"testing"
	"time"
)

func testPinnedPipe(t *testing.T, send []byte) (*slotConn, *Scheduler, <-chan int64) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	received := make(chan int64, 1)
	go func() {
		c, err := listener.Accept()
		if err != nil {
			received <- 0
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		if len(send) > 0 {
			c.Write(send)
			c.(*net.TCPConn).CloseWrite()
		}
		n, _ := io.Copy(io.Discard, c)
		received <- n
	}()
	s := NewScheduler([]nics.Nic{nic("local", "127.0.0.1", 1)})
	s.EnableQuotas(t.TempDir())
	s.SetSmart(true)
	conn, err := NewBalancer(s).DialPinned(context.Background(), "127.0.0.1", listener.Addr().(*net.TCPAddr).Port)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	return conn.(*slotConn), s, received
}

func TestCopyDownloadCannotBypassQuota(t *testing.T) {
	conn, scheduler, _ := testPinnedPipe(t, bytes.Repeat([]byte("x"), 4096))
	if err := scheduler.SetQuota("local", 1, false, false); err != nil {
		t.Fatal(err)
	}
	n, err := io.Copy(io.Discard, conn)
	if n != 1 || err == nil || scheduler.Snapshot()[0].QuotaUsed != 1 {
		t.Fatalf("io.Copy bypassed quota: copied=%d err=%v", n, err)
	}
}

func TestCopyUploadCannotBypassQuota(t *testing.T) {
	conn, scheduler, received := testPinnedPipe(t, nil)
	if err := scheduler.SetQuota("local", 1, false, false); err != nil {
		t.Fatal(err)
	}
	// Hide WriterTo so io.Copy exercises the destination's ReaderFrom shortcut.
	source := struct{ io.Reader }{bytes.NewReader(bytes.Repeat([]byte("x"), 4096))}
	n, err := io.Copy(conn, source)
	conn.Close()
	actual := <-received
	if n != 1 || actual != 1 || err == nil || scheduler.Snapshot()[0].QuotaUsed != 1 {
		t.Fatalf("io.Copy bypassed quota: copied=%d received=%d err=%v", n, actual, err)
	}
}

func TestCopyDownloadPreservesRateAndAccounting(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 2<<20)
	conn, scheduler, _ := testPinnedPipe(t, payload)
	scheduler.SetLimit("local", 8)
	started := time.Now()
	n, err := io.Copy(io.Discard, conn)
	if err != nil || n != int64(len(payload)) {
		t.Fatal(n, err)
	}
	if elapsed := time.Since(started); elapsed < 1200*time.Millisecond {
		t.Fatalf("copy bypassed speed cap: %v", elapsed)
	}
	if scheduler.Snapshot()[0].BytesIn != n {
		t.Fatal("copy bypassed traffic accounting")
	}
	conn.Close()
	if scheduler.Snapshot()[0].Active != 0 {
		t.Fatal("copy leaked active flow")
	}
}

func TestCopyUploadPreservesRateAndAccounting(t *testing.T) {
	conn, scheduler, received := testPinnedPipe(t, nil)
	scheduler.SetLimit("local", 8)
	payload := bytes.Repeat([]byte("x"), 2<<20)
	started := time.Now()
	n, err := io.Copy(conn, readerOnly{bytes.NewReader(payload)})
	if err != nil || n != int64(len(payload)) {
		t.Fatal(n, err)
	}
	if elapsed := time.Since(started); elapsed < 1200*time.Millisecond {
		t.Fatalf("copy bypassed speed cap: %v", elapsed)
	}
	conn.Close()
	if actual := <-received; actual != n {
		t.Fatal("copy delivered wrong byte count", actual, n)
	}
	if scheduler.Snapshot()[0].BytesOut != n {
		t.Fatal("copy bypassed traffic accounting")
	}
}

func TestUDPBudgetsBothDirectionsAndRejectsNextPacket(t *testing.T) {
	peer, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	peer.SetDeadline(time.Now().Add(3 * time.Second))
	scheduler := NewScheduler([]nics.Nic{nic("local", "127.0.0.1", 1)})
	scheduler.EnableQuotas(t.TempDir())
	scheduler.SetSmart(true)
	if err := scheduler.SetQuota("local", 2, false, false); err != nil {
		t.Fatal(err)
	}
	conn, err := NewBalancer(scheduler).ListenUDPFor(context.Background(), Fam4, 53)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	if n, err := conn.WriteTo([]byte("a"), peer.LocalAddr()); n != 1 || err != nil {
		t.Fatal(n, err)
	}
	buffer := make([]byte, 16)
	_, address, err := peer.ReadFrom(buffer)
	if err != nil {
		t.Fatal(err)
	}
	peer.WriteTo([]byte("b"), address)
	if n, _, err := conn.ReadFrom(buffer); n != 1 || err != nil {
		t.Fatal(n, err)
	}
	if n, err := conn.WriteTo([]byte("c"), peer.LocalAddr()); n != 0 || err != ErrQuota {
		t.Fatal("packet exceeded cap", n, err)
	}
	stats := scheduler.Snapshot()[0]
	if stats.QuotaUsed != 2 || !stats.QuotaBlocked || stats.BytesIn != 1 || stats.BytesOut != 1 {
		t.Fatal(stats)
	}
	if scheduler.Acquire(nil) != nil {
		t.Fatal("exhausted UDP adapter accepted another flow")
	}
}
