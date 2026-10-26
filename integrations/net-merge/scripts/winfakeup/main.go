//go:build windows

// winfakeup is a CI helper: a Wintun adapter with a default route that wins over the real NIC's
// and drops everything sent to it, so the real NIC becomes a secondary adapter (like a USB tether
// next to Wi-Fi). It exits, and Windows removes the adapter and route, after the given duration.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"time"

	"golang.zx2c4.com/wireguard/tun"
)

func main() {
	life, err := time.ParseDuration(os.Args[1])
	if err != nil {
		panic(err)
	}
	dev, err := tun.CreateTUN("fakeup", 1500)
	if err != nil {
		panic(err)
	}
	defer dev.Close()
	name, _ := dev.Name()
	for _, a := range [][]string{
		{"netsh", "interface", "ipv4", "set", "address", "name=" + name, "source=static", "address=10.99.0.2", "mask=255.255.255.0", "gateway=10.99.0.1", "gwmetric=1"},
		{"netsh", "interface", "ipv4", "set", "interface", name, "metric=1"},
	} {
		out, err := exec.Command(a[0], a[1:]...).CombinedOutput()
		fmt.Println(a, err, string(out))
	}
	fmt.Println("fakeup ready")
	go func() {
		bufs, sizes := [][]byte{make([]byte, 65536)}, []int{0}
		for {
			if _, err := dev.Read(bufs, sizes, 0); err != nil {
				return
			}
		}
	}()
	time.Sleep(life)
}
