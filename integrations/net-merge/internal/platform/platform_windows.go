package platform

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

func IsAdmin() bool { return windows.GetCurrentProcessToken().IsElevated() }

// SingleInstance is false if another net-merge (run or tray) already owns the TUN.
// The mutex handle is intentionally kept for the life of the process.
func SingleInstance() bool {
	name, _ := windows.UTF16PtrFromString(`Global\net-merge`)
	_, err := windows.CreateMutex(nil, false, name)
	return err != windows.ERROR_ALREADY_EXISTS
}

// InstanceRunning reports whether an (elevated) net-merge holds the mutex. From a normal shell
// OpenMutex is denied rather than succeeding, which also means it exists.
func InstanceRunning() bool {
	name, _ := windows.UTF16PtrFromString(`Global\net-merge`)
	h, err := windows.OpenMutex(windows.SYNCHRONIZE, false, name)
	if err == nil {
		windows.CloseHandle(h)
		return true
	}
	return err == windows.ERROR_ACCESS_DENIED
}

// RedirectStd points stdout/stderr (including the runtime's panic output and the TUN library's
// logger) at f, for the hidden elevated process that has no console.
func RedirectStd(f *os.File) {
	os.Stdout, os.Stderr = f, f
	log.SetOutput(f) // the std logger captured the old stderr at init; the tray library logs through it
	windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, windows.Handle(f.Fd()))
	windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(f.Fd()))
}

// RelaunchElevated re-runs this exe with the given args behind a UAC prompt and returns once it
// has started.
func RelaunchElevated(args []string, hidden bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = windows.EscapeArg(a)
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	params, _ := windows.UTF16PtrFromString(strings.Join(quoted, " "))
	dir, _ := windows.UTF16PtrFromString(filepath.Dir(exe))
	show := int32(windows.SW_SHOWNORMAL)
	if hidden {
		show = windows.SW_HIDE
	}
	return windows.ShellExecute(0, verb, file, params, dir, show)
}

// OpenURL shows url in the default browser. explorer.exe hands it to the shell, which runs as the
// signed-in user: the tray is elevated, and a browser started from there would be elevated too and
// could not reach the browser that is already open. DETACHED_PROCESS keeps it off our console, which
// would otherwise make a console window appear next to the tray.
func OpenURL(url string) error {
	cmd := exec.Command("explorer.exe", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait() // explorer exits at once, but reap it either way
	return nil
}
