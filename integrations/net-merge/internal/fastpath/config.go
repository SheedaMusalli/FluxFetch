// Package fastpath defines the opt-in Windows bind driver control protocol.
package fastpath

import (
	"encoding/binary"
	"fmt"
	"net/netip"
)

const ConfigSize = 16 + 16*24
const IOCTLConfig = 0x8000a000

type Link struct {
	Address netip.Addr
	Weight  uint32
}

func Encode(pid uint64, links []Link) ([]byte, error) {
	if pid <= 4 || len(links) == 0 || len(links) > 16 {
		return nil, fmt.Errorf("an explicit process ID and 1–16 links are required")
	}
	data := make([]byte, ConfigSize)
	binary.LittleEndian.PutUint32(data[0:], 1)
	binary.LittleEndian.PutUint32(data[4:], uint32(len(links)))
	binary.LittleEndian.PutUint64(data[8:], pid)
	for i, link := range links {
		ip := link.Address.Unmap()
		if !ip.IsValid() || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || link.Weight == 0 || link.Weight > 1000 {
			return nil, fmt.Errorf("invalid fast-path link")
		}
		offset := 16 + i*24
		family := uint32(23)
		if ip.Is4() {
			family = 2
			a := ip.As4()
			copy(data[offset+8:], a[:])
		} else {
			a := ip.As16()
			copy(data[offset+8:], a[:])
		}
		binary.LittleEndian.PutUint32(data[offset:], family)
		binary.LittleEndian.PutUint32(data[offset+4:], link.Weight)
	}
	return data, nil
}
