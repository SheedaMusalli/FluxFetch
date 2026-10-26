package update

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		current, latest string
		want            bool
	}{
		{"0.3.3", "v0.3.4", true},
		{"v0.3.3", "v0.3.4", true},
		{"0.3.3", "v0.3.3", false},
		{"0.3.4", "v0.3.3", false},
		{"0.3.10", "v0.3.9", false}, // numbers, not text
		{"0.9.9", "v0.10.0", true},
		{"0.3", "v0.3.0", false}, // missing numbers count as zero
		{"0.3.3-dev+abc", "v0.3.4", true},
		{"0.3.3", "v0.3.4-rc1", true}, // GitHub leaves prereleases out, but be able to read one
		{"dev", "v0.3.4", false},      // a build from source has nothing to compare
		{"0.3.3", "dev", false},
	} {
		if got := Newer(c.current, c.latest); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.current, c.latest, got, c.want)
		}
	}
}

func TestIsVersion(t *testing.T) {
	for v, want := range map[string]bool{
		"0.3.3":          true,
		"v1.2":           true,
		"0.3.3-dev+menu": true,
		"dev":            false,
		"":               false,
	} {
		if got := IsVersion(v); got != want {
			t.Errorf("IsVersion(%q) = %v, want %v", v, got, want)
		}
	}
}

func TestLatestReadsTheTagAndIdentifiesItself(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/"+Repo+"/releases/latest" {
			t.Errorf("asked for %q", r.URL.Path)
		}
		if r.Header.Get("User-Agent") == "" {
			t.Error("GitHub wants a User-Agent")
		}
		io.WriteString(w, `{"tag_name":"v0.3.4"}`)
	}))
	defer srv.Close()
	old := apiBase
	apiBase = srv.URL
	defer func() { apiBase = old }()

	tag, err := Latest(context.Background())
	if err != nil {
		t.Fatalf("Latest: %v", err)
	}
	if tag != "v0.3.4" {
		t.Fatalf("Latest = %q, want v0.3.4", tag)
	}
}

func TestLatestHandlesABigReleaseBody(t *testing.T) {
	// A release carries its notes: the reply can be far bigger than the tag we want.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"tag_name":"v0.3.4","body":"`)
		io.WriteString(w, strings.Repeat("x", 200<<10))
		io.WriteString(w, `"}`)
	}))
	defer srv.Close()
	old := apiBase
	apiBase = srv.URL
	defer func() { apiBase = old }()

	tag, err := Latest(context.Background())
	if err != nil {
		t.Fatalf("Latest with long release notes: %v", err)
	}
	if tag != "v0.3.4" {
		t.Fatalf("Latest = %q, want v0.3.4", tag)
	}
}

func TestLatestFailsLoudly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "rate limited", http.StatusForbidden)
	}))
	defer srv.Close()
	old := apiBase
	apiBase = srv.URL
	defer func() { apiBase = old }()

	if _, err := Latest(context.Background()); err == nil {
		t.Fatal("a 403 must be an error, not an empty tag")
	}
}
