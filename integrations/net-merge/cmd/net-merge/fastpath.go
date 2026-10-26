package main

import (
	"flag"
	"fmt"
	"math"
	"net-merge/internal/fastpath"
	"net-merge/internal/platform"
	"net/netip"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// This is deliberately opt-in and separate from TUN. The bind layer does not
// expose a remote destination, so affinity/quota features remain on the TUN path.
func cmdFastPath(args []string) {
	fs := flag.NewFlagSet("fast-path", flag.ExitOnError)
	var c common
	c.register(fs)
	pid := fs.Uint64("pid", 0, "process ID to opt in (required; use a disposable test app)")
	fs.Parse(args)
	if *pid <= 4 {
		die(fmt.Errorf("fast-path requires -pid for a single application"))
	}
	if !platform.IsAdmin() {
		die(fmt.Errorf("run the fast-path controller as administrator"))
	}
	if !platform.SingleInstance() {
		die(fmt.Errorf("stop the running Net Merge engine before using the fast path"))
	}
	device, err := fastpath.Open()
	if err != nil {
		die(fmt.Errorf("open signed FluxFetchNetMerge driver: %w", err))
	}
	defer device.Close()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stop)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		ns, err := c.nics()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
		var links []fastpath.Link
		for _, nic := range ns {
			for _, raw := range []string{nic.IP.String(), nic.IP6.String()} {
				if address, err := netip.ParseAddr(raw); err == nil && address.IsGlobalUnicast() {
					links = append(links, fastpath.Link{Address: address, Weight: uint32(math.Max(1, math.Min(1000, nic.Weight*100)))})
				}
			}
		}
		data, err := fastpath.Encode(*pid, links)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
		if err := device.Configure(data); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return
		}
		select {
		case <-stop:
			return
		case <-tick.C:
		}
	}
}
