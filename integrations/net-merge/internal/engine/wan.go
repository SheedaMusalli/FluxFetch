package engine

import (
	"context"
	"io"
	"net"
	"net-merge/internal/nics"
	"net/http"
	"strings"
	"time"
)

// Advisory only: identical public addresses can also be carrier NAT or an
// upstream VPN. Automatically disabling a link based on that alone loses capacity.
func parseWANTrace(data string) string {
	for _, line := range strings.Split(data, "\n") {
		if raw, ok := strings.CutPrefix(line, "ip="); ok {
			if ip := net.ParseIP(strings.TrimSpace(raw)); ip != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() {
				return ip.String()
			}
		}
	}
	return ""
}

func (s *Scheduler) probeWAN(sl *Slot) {
	s.mu.Lock()
	if !sl.present || sl.ip(Fam4) == nil || s.now().Sub(sl.lastWAN) < 5*time.Minute {
		s.mu.Unlock()
		return
	}
	sl.lastWAN = s.now()
	ip := sl.ip(Fam4)
	index := sl.Index
	s.mu.Unlock()
	dialer := &net.Dialer{LocalAddr: &net.TCPAddr{IP: ip}, Control: nics.ForceEgress(index, false), Timeout: 3 * time.Second}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, "tcp4", address)
	}, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get("https://1.1.1.1/cdn-cgi/trace")
	if err != nil {
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 8192))
	if err != nil {
		return
	}
	publicIP := parseWANTrace(string(data))
	s.mu.Lock()
	defer s.mu.Unlock()
	if sl.present && sl.ip(Fam4).Equal(ip) {
		sl.publicIP = publicIP
	}
}
