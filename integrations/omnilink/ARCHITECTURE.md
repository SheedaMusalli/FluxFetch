# OmniLink: Connection-Level Multi-Adapter Network Bonding for Steam & HTTP

Steam achieves high download speeds by breaking game builds into thousands of small, immutable files fetched over parallel HTTP/HTTPS connections, which makes its traffic uniquely suited for **connection-level multi-adapter bonding** without requiring an external VPN server.

---

## 1. How Steam Downloads Work Behind the Scenes (SteamPipe Architecture)

When you click **Download** in Steam, the client does not download a single monolithic `.zip` or `.iso` file over one TCP stream. Instead, it uses Valve’s **SteamPipe** content delivery pipeline:

1. **Authentication & Manifest Resolution:**
   - Every game (`AppID`) is divided into logical **Depots** (`DepotID`) representing base assets, OS-specific binaries, or language packs.
   - The Steam client queries a Steam Connection Manager (CM) over an encrypted WebSocket/TCP session to obtain three things: a **Manifest (`ManifestGID`)**, a 256-bit symmetric **`DepotKey`**, and a list of geographically optimal **SteamPipe CDN servers** (Valve Edge caches, Akamai, Cloudflare, Fastly, or local ISP caches).

2. **Content-Addressed 1 MiB Chunks:**
   - The Manifest is a blueprint listing every file in the game and breaking those files down into **~1 MiB chunks** (typically 512 KiB to 1 MiB uncompressed).
   - Each chunk is identified by its **SHA-1 hash (`ChunkID`)**, compressed (using LZMA, VZip, or Zstandard), and encrypted with AES-256.

3. **Stateless Multi-Connection HTTP/HTTPS Pool:**
   - To download the chunks, `steam.exe` spins up a pool of **concurrent HTTP/1.1 keep-alive and HTTP/2 worker connections** (typically 8 to 32 simultaneous TCP sockets across multiple CDN edges).
   - Each worker requests individual chunks via standard stateless `GET` requests:
     ```http
     GET /depot/{depot_id}/chunk/{chunk_sha1_hash} HTTP/1.1
     Host: cache1-lhr1.steamcontent.com
     ```

4. **In-Memory Decryption, Decompression & Scatter-Gather Disk I/O:**
   - As 1 MiB chunks arrive from different TCP sockets, Steam decrypts (AES-256) and decompresses them in RAM, then writes the raw bytes at their exact file offsets inside `steamapps/downloading/{appid}/` before atomically moving finished files to `steamapps/common/`.

### Why This Architecture Enables Multi-Adapter Bonding

Because Steam fetches thousands of independent 1 MiB chunks across **dozens of concurrent TCP sockets**, CDN servers do not require all requests to originate from the same public IP address. If Socket #1 goes out over **Ethernet (ISP A)**, Socket #2 goes out over **Wi-Fi (ISP B)**, and Socket #3 goes out over **5G USB Tethering (ISP C)**, your download speed scales linearly to the sum of all active connections ($Throughput_{total} \approx \sum BW_i$).

---

## 2. Why Default Windows Networking Only Uses One Adapter

When multiple network adapters are connected on Windows (e.g., Ethernet + Wi-Fi + USB Hotspot), Windows assigns an **Interface Metric** to each route (`0.0.0.0/0`). By default:

- When `steam.exe` creates a socket and calls `connect()` without binding to a specific local IP, the Windows TCP/IP stack routes **100% of outbound sockets** through the single adapter with the lowest routing metric.
- Windows Server’s built-in **NIC Teaming (LBFO)** only works at Layer 2 when multiple Ethernet cables plug into the same switch; it cannot combine heterogeneous networks (like Ethernet + Wi-Fi + Cellular) with different gateways and subnets.

### The Critical Windows Pitfall: The "Weak Host Model"

On Windows, simply calling `bind(socket, adapter_local_ip)` is **not enough** to force traffic out of a specific network card. Because of the Windows TCP/IP routing table evaluation order, Windows may rewrite or route packets out of the default gateway interface unless you **explicitly bind both the source IP and the outbound hardware interface index (`IfIndex`)** using the Winsock `IP_UNICAST_IF` option:

$$\text{Adapter Isolation} = \text{bind}(\text{Local IPv4}) + \text{setsockopt}(\text{IPPROTO\_IP}, \text{IP\_UNICAST\_IF}, \text{htonl}(\text{IfIndex}))$$

---

## 3. System Architecture: `OmniLink` Background Tray Engine

To avoid triggering Valve Anti-Cheat (VAC) or modifying `steam.exe` memory via DLL injection, the cleanest architecture combines a **Transparent Per-Process Packet Redirector (WFP)** with a **Local Multi-NIC Socket Dispatcher** running as a headless Windows Tray application.

```
+-------------------------------------------------------------------------+
|                           steam.exe (Client)                            |
|       Opens 16-32 Concurrent TCP Sockets to *.steamcontent.com:80/443   |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|     Layer 1: Process Traffic Interceptor (WFP ALE_CONNECT_REDIRECT)     |
|     Matches Process == "steam.exe" (Ports 80, 443) -> 127.0.0.1:19080   |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|     Layer 2: Multi-NIC Dispatcher & Load Balancer (127.0.0.1:19080)     |
|  - Dynamic Weighted Scheduler (Tracks live Mbps, RTT, & active sockets) |
|  - Optional HTTP Chunk Splitter (Splits large Range requests if HTTP)   |
+-----------+------------------------+------------------------+-----------+
            |                        |                        |
   bind() + IP_UNICAST_IF   bind() + IP_UNICAST_IF   bind() + IP_UNICAST_IF
            |                        |                        |
            v                        v                        v
   +-----------------+      +-----------------+      +-----------------+
   |   Adapter 1     |      |   Adapter 2     |      |   Adapter 3     |
   | Ethernet (ISP1) |      |  Wi-Fi (ISP2)   |      | 5G USB Tether   |
   |  IfIndex: 12    |      |  IfIndex: 18    |      |  IfIndex: 24    |
   +--------+--------+      +--------+--------+      +--------+--------+
            \                        |                        /
             \                       |                       /
              v                      v                      v
+-------------------------------------------------------------------------+
|                 SteamPipe CDN Edge Servers (*.steamcontent.com)         |
+-------------------------------------------------------------------------+
```

### Architectural Components

| Module                                                           | Responsibility                                                                                                                                                                           | Windows API / Crate / Library                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **1. NIC Monitor (`AdapterManager`)**                            | Enumerates UP physical/tethered adapters, extracts IPv4 address + `IfIndex`, listens for plug/unplug events, and runs lightweight gateway/DNS reachability checks.                       | `GetAdaptersAddresses`, `NotifyIpInterfaceChange` (`iphlpapi.dll`)          |
| **2. Traffic Redirector (`WfpRedirector` / `SteamInterceptor`)** | Transparently redirects outbound TCP connections from `steam.exe` (or configured apps) to the local loopback dispatcher without touching `steam.exe` memory.                             | WinDivert (Microsoft-signed WFP callout driver)                             |
| **3. Multi-NIC Dispatcher (`BondDispatcher`)**                   | Accepts redirected connections, selects the optimal NIC via **Dynamic Weighted Least-Load**, binds outbound sockets via `IP_UNICAST_IF`, and splices TCP streams with zero-copy buffers. | Tokio Async Runtime + `socket2` (`setsockopt`)                              |
| **4. Adaptive Load Balancer (`LoadBalancer`)**                   | Calculates real-time throughput ($EWMA$) and latency per adapter. Assigns more Steam chunk connections to faster adapters and drains stalled adapters immediately.                       | Lock-free atomic counters (`AtomicU64` bytes/sec, active connection gauges) |
| **5. Headless Tray UI (`OmniLinkTrayApp`)**                      | Compiles with `#![windows_subsystem = "windows"]` so **zero main window or taskbar icon** appears. Lives solely in the "Show Hidden Icons" system tray with a right-click menu.          | `tray-icon` + `muda` + `winit`                                              |

---

## 4. Load-Balancing & Dynamic Scheduling Algorithm

Static round-robin fails when combining asymmetric links (e.g., a 100 Mbps Ethernet line + a 250 Mbps 5G USB tether) because slow links bottleneck the pool. Instead, implement **Dynamic Capacity-Weighted Scheduling**:

1. **Per-Adapter Weight Score ($W_i$):**
   Every 500 ms, update the Exponentially Weighted Moving Average ($EWMA$) of each adapter's peak observed bandwidth ($B_{\text{max}, i}$), current active utilization ($B_{\text{cur}, i}$), and Round-Trip Time ($RTT_i$):

   $$\text{Score}_i = \frac{\max(B_{\text{max}, i} - B_{\text{cur}, i}, \text{MinProbeBW})}{\text{ActiveConnections}_i + 1} \times \frac{1}{\sqrt{RTT_i}}$$

2. **Slow-Start Probing:**
   When a new adapter is enabled, initialize $B_{\text{max}, i}$ with a high probe weight for 3 seconds so Steam immediately pushes 4–6 parallel chunk connections through it to discover its true ceiling.

3. **Stall Eviction (Mid-Download Failover):**
   If an adapter’s throughput drops to zero for $>3.5\text{ seconds}$ while sockets are active, close those upstream sockets immediately. Steam’s CDN client automatically retries failed chunk `GET` requests within milliseconds, which the dispatcher immediately routes to the remaining healthy adapters.
