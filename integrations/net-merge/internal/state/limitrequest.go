package state

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// A running tray or `run` may be elevated and cannot be signalled from a normal shell, so a limit
// change travels through a file in ctl/, like the on/off markers. The instance applies it to its
// scheduler and saves limits.json itself.
//
// ctl/ is world-writable (that is the point: a normal user has to be able to drop a request there),
// so the elevated instance must treat what it finds as hostile. TakeLimit only trusts a small
// regular file that it opened itself, never a symlink, a FIFO or anything that could grow.

// LimitRequest is one adapter's new cap, in Mbit/s; 0 removes the cap.
type LimitRequest struct {
	Adapter string  `json:"adapter"`
	Mbps    float64 `json:"mbps"`
}

// limitRequestMax is the most of ctl/limit that is read. A real request is well under 200 bytes;
// the cap means a planted endless file cannot fill memory.
const limitRequestMax = 4 << 10

func limitRequestPath(dir string) string { return filepath.Join(dir, "ctl", "limit") }

// SendLimit hands a cap to a running instance.
func SendLimit(dir string, req LimitRequest) error {
	if err := os.MkdirAll(filepath.Join(dir, "ctl"), 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(req)
	if err != nil {
		return err
	}
	tmp := limitRequestPath(dir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o666); err != nil {
		return err
	}
	return os.Rename(tmp, limitRequestPath(dir))
}

// TakeLimit consumes a pending request. The file is renamed aside before it is read, so a request
// that arrives at the same moment cannot be deleted unread.
func TakeLimit(dir string) (LimitRequest, bool) {
	p := limitRequestPath(dir)
	taken := p + ".taken"
	os.Remove(taken) // left over if an earlier read failed
	if err := os.Rename(p, taken); err != nil {
		return LimitRequest{}, false
	}
	b, ok := readLimitRequest(taken)
	os.Remove(taken)
	if !ok {
		return LimitRequest{}, false
	}
	var req LimitRequest
	if json.Unmarshal(b, &req) != nil || req.Adapter == "" {
		return LimitRequest{}, false
	}
	return req, true
}

// readLimitRequest reads a request file if it is a small regular file. Opening it must not follow a
// symlink (which could point at /dev/zero) and must not block on a FIFO, hence openLimitFile.
func readLimitRequest(path string) ([]byte, bool) {
	f, err := openLimitFile(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	// Stat the open file, not the name: the file that was opened is the one that gets read.
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return nil, false
	}
	b, err := io.ReadAll(io.LimitReader(f, limitRequestMax))
	if err != nil {
		return nil, false
	}
	return b, true
}
