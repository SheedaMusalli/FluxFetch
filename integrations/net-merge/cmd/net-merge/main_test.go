package main

import (
	"strings"
	"testing"
	"time"

	"net-merge/internal/engine"
	"net-merge/internal/state"
)

func TestLimitApplyWithoutInstanceWritesLimitsFile(t *testing.T) {
	dir := t.TempDir()
	if err := state.SaveLimits(dir, map[string]float64{"Ethernet": 10}); err != nil {
		t.Fatal(err)
	}

	live, err := limitApply(dir, "Wi-Fi", 50, false, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if live {
		t.Fatal("nothing was running, so it must not report a live change")
	}
	limits, err := state.LoadLimits(dir)
	if err != nil {
		t.Fatal(err)
	}
	if limits["Wi-Fi"] != 50 || limits["Ethernet"] != 10 {
		t.Fatalf("limits = %v, want Wi-Fi=50 and Ethernet kept at 10", limits)
	}

	if _, err := limitApply(dir, "Ethernet", 0, false, time.Second); err != nil {
		t.Fatal(err)
	}
	limits, err = state.LoadLimits(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, set := limits["Ethernet"]; set {
		t.Fatalf("Ethernet still capped: %v", limits)
	}
}

func TestLimitApplyThroughRunningInstance(t *testing.T) {
	dir := t.TempDir()
	sched := engine.NewScheduler(nil)
	stop := make(chan struct{})
	defer close(stop)

	// Stand-in for the tray's once-a-second poll: take the request, apply it, save it.
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if req, ok := state.TakeLimit(dir); ok {
				sched.SetLimit(req.Adapter, req.Mbps)
				state.SaveLimits(dir, sched.Limits())
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()

	live, err := limitApply(dir, "Ethernet 2", 35, true, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !live {
		t.Fatal("a running instance should report a live change")
	}
	limits, err := state.LoadLimits(dir)
	if err != nil {
		t.Fatal(err)
	}
	if limits["Ethernet 2"] != 35 {
		t.Fatalf("limits = %v, want Ethernet 2 = 35", limits)
	}
	if got := sched.Limits()["Ethernet 2"]; got != 35 {
		t.Fatalf("the instance applied %v, want 35", got)
	}
	if _, ok := state.TakeLimit(dir); ok {
		t.Fatal("the request must be consumed")
	}
}

func TestFormatNICsShowsTheCapInMbit(t *testing.T) {
	out := formatNICs([]engine.SlotStats{{
		Name: "Ethernet", State: "up", State6: "-", Present: true, LimitMbps: 12.5, Weight: 1, Weight6: 1,
	}})
	if !strings.Contains(out, "limit 12.5 Mbit/s") {
		t.Fatalf("want the cap in Mbit/s, got:\n%s", out)
	}
	if strings.Contains(out, "MB/s") {
		t.Fatalf("status must not mix megabytes into a Mbit/s line:\n%s", out)
	}
}
