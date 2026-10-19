# FluxFetch OmniLink integration

OmniLink routes eligible launcher transfers across independent IPv4 adapters. Process presets cover Steam, Epic Games, EA, Ubisoft Connect, GOG Galaxy, Riot, Battle.net and the Rockstar service. Client versions may use separate download workers; add their executable names explicitly when needed.

Right-click the OmniLink tray icon and choose **Add launcher or app...**. Enter the downloader executable name, one per line, save, and wait up to two seconds. Additional names are stored in `%LOCALAPPDATA%/FluxFetch/OmniLink/launchers.txt`; presets remain enabled. Entries are executable names, not paths or commands. Generic workers such as `Agent.exe` and `Launcher.exe` are opt-in because unrelated apps can use those names. The tray tooltip lists detected processes.

Start OmniLink before starting a download: it redirects newly opened IPv4 TCP connections on ports 80 and 443. Existing connections, UDP/QUIC, IPv6 and other ports are not routed. A launcher that reuses connections may need its download or process restarted. No launcher or game is modified. Bandwidth gains depend on independent Internet connections and servers permitting concurrent downloads.

The overlay and tray report routed receive payload over about one second. **Transferring** includes background requests and does not claim that a game is downloading. Rates stay zero when no routed payload arrives. Steam content logs no longer gate other launchers' telemetry.

`npm run build:omnilink` builds and stages the Windows x64 helper, WinDivert runtime and licenses. The installer includes it automatically. Rust stable MSVC is required. Real launcher downloads with multiple physical adapters remain manual validation; compilation and tests do not prove every client version or protocol is compatible.
