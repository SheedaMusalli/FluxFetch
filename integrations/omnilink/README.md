# OmniLink: Connection-Level Multi-Adapter Bonding for High-Speed Downloads

**OmniLink** is a high-performance Windows system tray engine written in native Rust that aggregates multiple heterogeneous network connections (Ethernet, Wi-Fi, 5G USB tethering, mobile hotspots) into a single, high-bandwidth pipe for eligible launcher downloads and high-throughput HTTP streams.

---

## ⚡ How It Works

1. **SteamPipe 1 MiB Chunked Architecture:** Steam breaks game depots into thousands of immutable ~1 MiB content-addressed files requested across 16–32 concurrent TCP sockets.
2. **Windows Weak Host Model Bypass:** Windows normally forces 100% of outbound connections through whichever single network card has the lowest interface routing metric. OmniLink bypasses this by strictly pinning each outbound TCP connection to both the local adapter IPv4 address and its hardware interface index using the Winsock `IP_UNICAST_IF` option:
   $$\text{Adapter Isolation} = \text{bind}(\text{Local IPv4}) + \text{setsockopt}(\text{IPPROTO\_IP}, \text{IP\_UNICAST\_IF}, \text{htonl}(\text{IfIndex}))$$
3. **Transparent Traffic Redirection:** Uses Microsoft-signed WinDivert (WFP kernel callout driver) to detect and redirect outbound TCP port 80/443 sockets originating from configured launcher processes to a local loopback dispatcher (`127.0.0.1:19080`).
4. **Dynamic Capacity-Weighted Load Balancer:** Continuously monitors bandwidth (via lock-free `AtomicU64` counters updated on every read/write) and round-trip latency ($RTT$) per adapter, dynamically scheduling chunk sockets proportional to available headroom and evicting stalled interfaces within 3.5 seconds.
5. **Headless Tray Application:** Runs strictly in the Windows "Show Hidden Icons" notification tray with `#![windows_subsystem = "windows"]`, providing real-time per-adapter throughput meters and control toggles.

---

## 📁 Project Structure

```text
d:\Projects\Steam Download Booster by AntiGravity\
├── Cargo.toml                      # Project manifest, dependencies, and release LTO profiles
├── build.rs                        # Links WinDivert.lib, embeds UAC manifest, stages driver DLLs
├── app.manifest                    # Administrator elevation & PerMonitorV2 high-DPI manifest
├── app_dev.manifest                # asInvoker manifest for dev/test execution
├── ARCHITECTURE.md                 # Complete architectural specification & design blueprint
├── launch_omnilink.bat             # One-click launcher with UAC elevation
├── run_verification.bat            # One-click hardware verification test
├── vendor/windivert/x64/           # WinDivert 2.2.2-A x64 binaries (lib, dll, sys)
├── src/
│   ├── main.rs                     # Headless Windows entry point & Tokio runtime setup
│   ├── lib.rs                      # Library re-exports for integration test suites
│   ├── tray.rs                     # Tray icon, status generation & muda right-click context menu
│   ├── adapters.rs                 # Win32 GetAdaptersAddresses hardware NIC discovery & filter
│   ├── socket_binder.rs            # Winsock bind() + IP_UNICAST_IF big-endian interface binding
│   ├── load_balancer.rs            # 500ms EWMA capacity-weighted scheduler & stall detector
│   ├── overlay.rs                  # Opaque FluxFetch-themed draggable Steam telemetry overlay
│   ├── dispatcher.rs               # Async TCP & SOCKS5 loopback proxy with zero-copy stream splicing
│   └── interceptor.rs              # WinDivert WFP redirector & PID ownership tracking
└── tests/
    └── multi_nic_verification.rs   # Automated hardware adapter & public WAN IP verification
```

---

## 🧪 Hardware Verification Test Results

Run the verification test on your system anytime:

```cmd
run_verification.bat
```

or via PowerShell:

```powershell
cargo test --test multi_nic_verification -- --nocapture
```

### Verified Live Output on This Machine:

```text
=== Phase 1: Hardware Adapter & Public WAN IP Verification ===
[PASS] IfIndex 12 | Ethernet           | Local IP: 192.168.100.197 | Gateway: 192.168.100.1   | WAN IP: 103.169.99.73   | RTT: 22.6438ms
[PASS] IfIndex 15 | Wi-Fi              | Local IP: 192.168.1.51    | Gateway: 192.168.1.1     | WAN IP: 103.169.99.73   | RTT: 42.0239ms

=== Phase 2: Load Balancer Distribution Simulation (16 Concurrent Steam Chunks) ===
  Chunk #00 routed via -> Wi-Fi (IfIndex 15)
  Chunk #01 routed via -> Ethernet (IfIndex 12)
  Chunk #02 routed via -> Wi-Fi (IfIndex 15)
  Chunk #03 routed via -> Ethernet (IfIndex 12)
  Chunk #04 routed via -> Wi-Fi (IfIndex 15)
  Chunk #05 routed via -> Ethernet (IfIndex 12)
  Chunk #06 routed via -> Wi-Fi (IfIndex 15)
  Chunk #07 routed via -> Ethernet (IfIndex 12)
  Chunk #08 routed via -> Wi-Fi (IfIndex 15)
  Chunk #09 routed via -> Ethernet (IfIndex 12)
  Chunk #10 routed via -> Wi-Fi (IfIndex 15)
  Chunk #11 routed via -> Ethernet (IfIndex 12)
  Chunk #12 routed via -> Wi-Fi (IfIndex 15)
  Chunk #13 routed via -> Ethernet (IfIndex 12)
  Chunk #14 routed via -> Wi-Fi (IfIndex 15)
  Chunk #15 routed via -> Ethernet (IfIndex 12)
test verify_per_adapter_isolation_and_public_ips ... ok
```

---

## 🚀 Running OmniLink

1. Double-click `launch_omnilink.bat` or run:
   ```powershell
   Start-Process -FilePath ".\target\release\omnilink-tray.exe" -Verb RunAs
   ```
2. Accept the Windows UAC Administrator prompt.
3. OmniLink runs strictly in the background. Click the **Show Hidden Icons (`^`)** chevron in your Windows taskbar tray to see the green OmniLink icon.
4. **Right-click** the icon to view:
   - Live combined bandwidth meter (e.g., `OmniLink: Active (240.5 Mbps)`)
   - Enable / Pause Multi-NIC Bonding toggle
   - **Show Desktop HUD Overlay** toggle (checked by default)
   - Individual Network Adapters list with per-adapter real-time Mbps and enable/disable checkboxes
   - Scheduling Mode selection (`Dynamic Capacity Weighted` or `Strict Round-Robin`)
   - Rescan Network Adapters (for newly connected USB 5G tethering or Wi-Fi networks)
   - Start with Windows toggle
   - Quit OmniLink

---

## 🖥️ FluxFetch Desktop Overlay

OmniLink includes a sleek, floating desktop HUD overlay that stays on top of every application, browser, and borderless game:

- **Always On Top (`WS_EX_TOPMOST`):** Never gets hidden behind active game windows or browser tabs.
- **Opaque FluxFetch Theme:** Solid dark surfaces, purple accents, and smooth rounded corners match the FluxFetch interface.
- **Zero Desktop Clutter (`WS_EX_TOOLWINDOW`):** Does not appear in your Windows Taskbar or Alt+Tab switcher.
- **Fully Draggable:** Click and drag anywhere on the overlay to position it on any monitor.
- **Launcher Metrics:** Independent ETW observation covers selected launcher IPv4/IPv6 TCP and UDP receive traffic, including pre-existing direct connections. Routed payload and whole-adapter receive rates are displayed separately from the same telemetry snapshot. Collection failures are marked unavailable.
- **Expandable Details:** Use the arrow control to expand or collapse per-adapter routed receive speeds and bonding status.
- **Easy Hide / Show:**
  - **From System Tray:** Right-click the green OmniLink tray icon $\rightarrow$ uncheck/check **`Show Desktop HUD Overlay`**.
  - **From Overlay:** Right-click the overlay directly $\rightarrow$ click **`Hide Overlay`** or **`Reset Position to Top-Right`**.

---

## 🔍 How to Test Multi-NIC Dispatching

### 1. Direct Proxy Verification (curl SOCKS5)

With OmniLink running, test the dispatcher directly using curl in PowerShell:

```powershell
curl.exe --socks5 127.0.0.1:19080 http://api.ipify.org
```

When switched to **Strict Round-Robin**, alternating curl requests will rotate across each enabled network adapter.

### 2. Live Steam Downloads

1. Open Windows **Task Manager** (`Ctrl+Shift+Esc`) and navigate to the **Performance** tab.
2. Select **Ethernet** and open **Wi-Fi** side-by-side (or open `resmon.exe` -> Network).
3. Start or resume any game download in Steam.
4. Watch both network adapters spike and sustain high throughput simultaneously instead of one sitting idle at 0 Kbps!

For launcher presets, custom client setup and protocol limits, see [FluxFetch integration](FLUXFETCH-INTEGRATION.md).
