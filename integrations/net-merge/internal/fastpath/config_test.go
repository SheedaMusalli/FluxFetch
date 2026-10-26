package fastpath

import (
	"encoding/binary"
	"net/netip"
	"testing"
)

func TestWireLayout(t *testing.T) {
	data, err := Encode(12345, []Link{{netip.MustParseAddr("192.168.1.2"), 3}, {netip.MustParseAddr("2001:db8::1"), 1}})
	if err != nil {
		t.Fatal(err)
	}
	if len(data) != 400 || binary.LittleEndian.Uint64(data[8:]) != 12345 || binary.LittleEndian.Uint32(data[16:]) != 2 || data[24] != 192 || binary.LittleEndian.Uint32(data[40:]) != 23 || data[48] != 0x20 {
		t.Fatal("driver ABI mismatch")
	}
	if IOCTLConfig != (0x8000<<16 | 2<<14 | 0x800<<2) {
		t.Fatal("IOCTL mismatch")
	}
}
func TestRejectInvalidConfig(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "0.0.0.0", "::", "ff02::1", "fe80::1"} {
		if _, err := Encode(100, []Link{{netip.MustParseAddr(ip), 1}}); err == nil {
			t.Fatalf("accepted %s", ip)
		}
	}
	if _, err := Encode(0, nil); err == nil {
		t.Fatal("accepted global interception")
	}
}
