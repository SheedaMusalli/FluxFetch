//go:build unix

package state

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// ctl/ is writable by every user on the machine, and on macOS the tray that reads it runs as root.
// A FIFO planted there must not be able to freeze the tray's menu loop.
func TestTakeLimitDoesNotBlockOnAFifo(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "ctl"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(limitRequestPath(dir), 0o666); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		if req, ok := TakeLimit(dir); ok {
			t.Errorf("took a request from a FIFO: %+v", req)
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("TakeLimit blocked on a FIFO")
	}
	if _, err := os.Stat(limitRequestPath(dir)); !os.IsNotExist(err) {
		t.Fatalf("the FIFO should have been consumed, Stat: %v", err)
	}
}

// A symlink to something endless (/dev/zero, a huge file) must be refused, not followed.
func TestTakeLimitRefusesASymlink(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "ctl"), 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "planted.json")
	if err := os.WriteFile(target, []byte(`{"adapter":"Ethernet","mbps":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, limitRequestPath(dir)); err != nil {
		t.Fatal(err)
	}

	if req, ok := TakeLimit(dir); ok {
		t.Fatalf("followed a symlink and took %+v", req)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("the link's target was touched: %v", err)
	}
}
