package engine

import (
	"errors"
	"io"
	"net-merge/internal/nics"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestQuotaSurvivesRestartConservatively(t *testing.T) {
	dir := t.TempDir()
	q := loadQuota(dir, "hardware-id")
	if err := q.configure(2<<20, false, false); err != nil {
		t.Fatal(err)
	}
	if !q.allow(10) {
		t.Fatal("initial data denied")
	}
	restarted := loadQuota(dir, "hardware-id")
	_, used, _, _ := restarted.snapshot()
	if used != 1<<20 {
		t.Fatal("crash gave reserved bytes back")
	}
	if !restarted.allow(1<<20) || restarted.allow(1) {
		t.Fatal("budget not enforced")
	}
}

func TestQuotaConcurrentFlowsAndEdit(t *testing.T) {
	q := loadQuota(t.TempDir(), "mobile")
	if err := q.configure(1000, false, false); err != nil {
		t.Fatal(err)
	}
	var accepted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if q.allow(100) {
				accepted.Add(100)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 1000 {
		t.Fatal(accepted.Load())
	}
	if err := q.configure(1200, false, false); err != nil {
		t.Fatal(err)
	}
	if !q.allow(200) || q.allow(1) {
		t.Fatal("editing cap reset usage")
	}
	if err := q.configure(1200, false, true); err != nil {
		t.Fatal(err)
	}
	if !q.allow(1200) {
		t.Fatal("explicit reset failed")
	}
}

func TestQuotaDailyResetAndFailClosed(t *testing.T) {
	q := loadQuota(t.TempDir(), "mobile")
	if err := q.configure(100, true, false); err != nil {
		t.Fatal(err)
	}
	q.allow(100)
	q.Day = time.Now().UTC().Add(-24 * time.Hour).Format("2006-01-02")
	if !q.allow(100) {
		t.Fatal("UTC daily rollover failed")
	}
	q.path = ""
	if q.configure(100, false, true) == nil || q.allow(1) {
		t.Fatal("storage failure did not fail closed")
	}
}

func TestQuotaExcludedFromAllDownFallback(t *testing.T) {
	s := NewScheduler([]nics.Nic{nic("mobile", "10.0.0.1", 1)})
	s.EnableQuotas(t.TempDir())
	if err := s.SetQuota("mobile", 1, false, false); err != nil {
		t.Fatal(err)
	}
	s.slots[0].allowBytes(1)
	if s.Acquire(nil) != nil {
		t.Fatal("exhausted link selected as fail-open fallback")
	}
}

func TestQuotaFollowsHardwareAcrossRename(t *testing.T) {
	dir := t.TempDir()
	original := nic("phone", "10.0.0.1", 1)
	original.HardwareID = "00:11:22:33:44:55"
	s := NewScheduler([]nics.Nic{original})
	s.EnableQuotas(dir)
	if err := s.SetQuota("phone", 1000, false, false); err != nil {
		t.Fatal(err)
	}
	s.slots[0].allowBytes(100)
	renamed := original
	renamed.Name = "renamed phone"
	next := NewScheduler([]nics.Nic{renamed})
	next.EnableQuotas(dir)
	if !next.slots[0].quotaBlocked() {
		t.Fatal("renaming adapter replenished budget")
	}
}

func TestQuotaStopsWritesOnExistingFlow(t *testing.T) {
	s := NewScheduler([]nics.Nic{nic("phone", "10.0.0.1", 1)})
	s.EnableQuotas(t.TempDir())
	if err := s.SetQuota("phone", 5, false, false); err != nil {
		t.Fatal(err)
	}
	if n, err := s.slots[0].writePaced(io.Discard, []byte("hello"), false); n != 5 || err != nil {
		t.Fatal(n, err)
	}
	if n, err := s.slots[0].writePaced(io.Discard, []byte("!"), false); n != 0 || !errors.Is(err, ErrQuota) {
		t.Fatal("existing flow bypassed quota", n, err)
	}
}

func TestReconnectSharesLiveQuotaAccount(t *testing.T) {
	before := nic("phone", "10.0.0.1", 1)
	before.HardwareID = "phone-hardware"
	s := NewScheduler([]nics.Nic{before})
	s.EnableQuotas(t.TempDir())
	old := s.Acquire(nil)
	if err := s.SetQuota("phone", 1000, false, false); err != nil {
		t.Fatal(err)
	}
	old.allowBytes(600)
	after := before
	after.Name, after.Index = "renamed phone", 7
	s.Update([]nics.Nic{after})
	fresh := s.Acquire(nil)
	if fresh == old || fresh.quota.Load() != old.quota.Load() {
		t.Fatal("live adapter aliases got separate budgets")
	}
	if !fresh.allowBytes(400) || old.allowBytes(1) {
		t.Fatal("reconnect replenished budget")
	}
}
