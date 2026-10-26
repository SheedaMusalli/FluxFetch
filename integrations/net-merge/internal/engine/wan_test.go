package engine

import "testing"

func TestParseWANTrace(t *testing.T) {
	if got := parseWANTrace("fl=abc\nip=8.8.8.8\nloc=US\n"); got != "8.8.8.8" {
		t.Fatal(got)
	}
	for _, invalid := range []string{"ip=127.0.0.1", "ip=192.168.0.1", "ip=not-an-ip", "html=login required", "ip=::1"} {
		if parseWANTrace(invalid) != "" {
			t.Fatal(invalid)
		}
	}
}
