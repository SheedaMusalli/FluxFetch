//go:build !windows

package fastpath

import "fmt"

type Device struct{}

func Open() (*Device, error)                  { return nil, fmt.Errorf("the WFP fast path is Windows-only") }
func (d *Device) Configure(data []byte) error { return fmt.Errorf("the WFP fast path is Windows-only") }
func (d *Device) Close() error                { return nil }
