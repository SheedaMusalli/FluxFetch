package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var ErrQuota = errors.New("adapter data budget exhausted or could not be persisted")

// Reserve disk-backed blocks before granting payload bytes. On a crash the unused
// part of a reservation is counted as spent, never made available a second time.
// This is a relay payload budget, not an ISP bill: headers/retransmits are excluded.
type quotaAccount struct {
	mu            sync.Mutex
	path          string
	Max, Reserved int64
	Daily         bool
	Day           string
	available     int64
	failure       error
}

func loadQuota(dir, identity string) *quotaAccount {
	sum := sha256.Sum256([]byte(identity))
	q := &quotaAccount{path: filepath.Join(dir, hex.EncodeToString(sum[:])+".json")}
	data, err := os.ReadFile(q.path)
	if errors.Is(err, os.ErrNotExist) {
		return q
	}
	if err != nil {
		q.failure = err
		return q
	}
	q.failure = json.Unmarshal(data, q)
	if q.Max < 0 || q.Reserved < 0 || q.Max > 1e15 {
		q.failure = ErrQuota
	}
	return q
}

func (q *quotaAccount) save() error {
	if err := os.MkdirAll(filepath.Dir(q.path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(q)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(q.path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(q.path+".tmp", q.path)
}

func (q *quotaAccount) rollover() {
	day := time.Now().UTC().Format("2006-01-02")
	if q.Daily && q.Day != day {
		q.Day, q.Reserved, q.available = day, 0, 0
		q.failure = q.save()
	}
}

func (q *quotaAccount) configure(maxBytes int64, daily, reset bool) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	// Preserve consumed bytes when editing a cap; a reset must be explicit.
	q.Reserved -= q.available
	q.available = 0
	if reset || q.Max == 0 {
		q.Reserved = 0
	}
	q.Max, q.Daily, q.Day = maxBytes, daily, time.Now().UTC().Format("2006-01-02")
	q.failure = q.save()
	return q.failure
}

func (q *quotaAccount) allow(n int) bool {
	return q.take(n, false) == n
}

func (q *quotaAccount) take(n int, partial bool) int {
	if q == nil || n <= 0 {
		return n
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.rollover()
	if q.failure != nil {
		return 0
	}
	if q.Max == 0 {
		return n
	}
	need := int64(n)
	if partial {
		need = min(need, max(0, q.Max-q.Reserved+q.available))
	}
	if need > q.available {
		reserve := min(max(1<<20, need-q.available), max(0, q.Max-q.Reserved))
		if reserve+q.available < need {
			return 0
		}
		q.Reserved += reserve
		q.failure = q.save()
		if q.failure != nil {
			return 0
		}
		q.available += reserve
	}
	q.available -= need
	return int(need)
}

func (q *quotaAccount) snapshot() (int64, int64, bool, bool) {
	if q == nil {
		return 0, 0, false, false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.rollover()
	used := q.Reserved - q.available
	return q.Max, used, q.Daily, q.failure != nil || q.Max > 0 && used >= q.Max
}

func (q *quotaAccount) errorMessage() string {
	if q == nil {
		return ""
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.failure != nil {
		return q.failure.Error()
	}
	return ""
}

func (sl *Slot) allowBytes(n int) bool { return sl.quota.Load().allow(n) }
func (sl *Slot) grantBytes(n int) int  { return sl.quota.Load().take(n, true) }
func (sl *Slot) quotaBlocked() bool    { _, _, _, blocked := sl.quota.Load().snapshot(); return blocked }

func (s *Scheduler) EnableQuotas(dir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.quotaDir = dir
	s.quotaAccounts = make(map[string]*quotaAccount)
	for _, sl := range s.slots {
		sl.quota.Store(s.quotaForLocked(sl.identity))
	}
}

func (s *Scheduler) quotaForLocked(identity string) *quotaAccount {
	if q := s.quotaAccounts[identity]; q != nil {
		return q
	}
	q := loadQuota(s.quotaDir, identity)
	s.quotaAccounts[identity] = q
	return q
}

func (s *Scheduler) SetQuota(name string, maxBytes int64, daily, reset bool) error {
	if maxBytes < 0 || maxBytes > 1e15 {
		return fmt.Errorf("invalid data budget")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sl := range s.slots {
		if sl.Name == name && sl.present {
			q := sl.quota.Load()
			if q == nil {
				return fmt.Errorf("quota storage is unavailable")
			}
			return q.configure(maxBytes, daily, reset)
		}
	}
	return fmt.Errorf("adapter is unavailable")
}
