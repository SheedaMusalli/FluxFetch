package state

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLimitsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := map[string]float64{"Ethernet 3": 10, "Wi-Fi": 2.5}
	if err := SaveLimits(dir, want); err != nil {
		t.Fatal(err)
	}
	got, err := LoadLimits(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("LoadLimits = %v, want %v", got, want)
	}
}

func TestLoadLimitsWithoutAFile(t *testing.T) {
	got, err := LoadLimits(t.TempDir())
	if err != nil {
		t.Fatalf("a missing limits file must not be an error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("want no limits, got %v", got)
	}
}

func TestLoadLimitsSanitises(t *testing.T) {
	dir := t.TempDir()
	raw := `{"version":1,"limits":{"neg":-1,"zero":0,"huge":1e9,"ok":5,"":7}}`
	if err := os.WriteFile(LimitsPath(dir), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadLimits(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]float64{"ok": 5}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("LoadLimits = %v, want %v", got, want)
	}
}

func TestLoadLimitsBrokenFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(LimitsPath(dir), []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadLimits(dir); err == nil {
		t.Fatal("want an error for a broken limits file")
	}
}

// macOS empties /var/run at boot, so caps kept there would be forgotten by the next morning.
func TestLimitsSurviveARebootOnMacOS(t *testing.T) {
	for _, c := range []struct {
		goos, stateDir, want string
	}{
		{"darwin", macStateDir, macLimitsDir},
		{"linux", macStateDir, macStateDir},
		{"windows", `C:\Users\me\AppData\Local\net-merge`, `C:\Users\me\AppData\Local\net-merge`},
		{"darwin", "/tmp/somewhere-else", "/tmp/somewhere-else"}, // a custom -state-dir is left alone
	} {
		got := limitsDirFor(c.goos, c.stateDir)
		if got != c.want {
			t.Errorf("limitsDirFor(%s, %q) = %q, want %q", c.goos, c.stateDir, got, c.want)
		}
	}
	if got, want := LimitsPath(macStateDir), filepath.Join(limitsDir(macStateDir), "limits.json"); got != want {
		t.Errorf("LimitsPath(%q) = %q, want %q", macStateDir, got, want)
	}
}
