//go:build unix

package state

import (
	"os"
	"syscall"
)

// openLimitFile opens a request for reading without following a final symlink and without blocking
// on a FIFO. Both matter because ctl/ is writable by every user: a symlink to /dev/zero would read
// forever, and a FIFO would hold the tray's menu loop until someone wrote to it. With these flags
// the open fails or returns at once, and readLimitRequest rejects whatever is not a regular file.
func openLimitFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}
