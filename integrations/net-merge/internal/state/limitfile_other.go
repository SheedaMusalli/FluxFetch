//go:build !unix

package state

import "os"

// openLimitFile opens a request for reading. Windows has no O_NOFOLLOW/O_NONBLOCK in syscall, so
// there the regular-file check in readLimitRequest is the guard; ctl/ is not world-writable there.
func openLimitFile(path string) (*os.File, error) { return os.Open(path) }
