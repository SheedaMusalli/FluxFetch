package fastpath

import "golang.org/x/sys/windows"

type Device struct{ handle windows.Handle }

func Open() (*Device, error) {
	path, _ := windows.UTF16PtrFromString(`\\.\FluxFetchNetMerge`)
	handle, err := windows.CreateFile(path, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return nil, err
	}
	return &Device{handle}, nil
}
func (d *Device) Configure(data []byte) error {
	var returned uint32
	return windows.DeviceIoControl(d.handle, IOCTLConfig, &data[0], uint32(len(data)), nil, 0, &returned, nil)
}
func (d *Device) Close() error { return windows.CloseHandle(d.handle) }
