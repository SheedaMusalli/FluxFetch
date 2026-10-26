package state

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLimitRequestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if req, ok := TakeLimit(dir); ok {
		t.Fatalf("want no request, got %+v", req)
	}
	if err := SendLimit(dir, LimitRequest{Adapter: "Ethernet 2", Mbps: 7.5}); err != nil {
		t.Fatal(err)
	}
	req, ok := TakeLimit(dir)
	if !ok {
		t.Fatal("want the request back")
	}
	if req.Adapter != "Ethernet 2" || req.Mbps != 7.5 {
		t.Fatalf("got %+v", req)
	}
	if _, ok := TakeLimit(dir); ok {
		t.Fatal("a request must be consumed exactly once")
	}
}

func TestTakeLimitIgnoresGarbage(t *testing.T) {
	dir := t.TempDir()
	if err := SendLimit(dir, LimitRequest{Adapter: "Wi-Fi", Mbps: 2}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(limitRequestPath(dir), []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if req, ok := TakeLimit(dir); ok {
		t.Fatalf("want garbage ignored, got %+v", req)
	}
}

// Only the first limitRequestMax bytes are read, so a valid-looking request that is too long is
// refused rather than used (and a planted endless file cannot exhaust memory).
func TestTakeLimitRefusesAnOversizedRequest(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "ctl"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"adapter":"` + strings.Repeat("a", limitRequestMax) + `","mbps":5}`
	if err := os.WriteFile(limitRequestPath(dir), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if req, ok := TakeLimit(dir); ok {
		t.Fatalf("accepted a %d-byte request: %+v", len(body), req)
	}
}
