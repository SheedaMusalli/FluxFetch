# FluxFetch torrent session

FluxFetch runs its own libtorrent session in a hidden child process. It does not need an installed qBittorrent client or use qBittorrent's Web UI.

qBittorrent's [`SessionImpl`](https://github.com/qbittorrent/qBittorrent/blob/master/src/base/bittorrent/sessionimpl.cpp) is a C++/Qt application built around libtorrent sessions, torrent handles, peer discovery, tracker alerts and resume data. FluxFetch uses the same underlying engine family through its official native Python bindings, with an independently written session controller. No qBittorrent source code is copied into this helper.

## Architecture

- Electron owns the process and sends bounded JSON requests over private standard-input/output pipes. No torrent RPC port is opened.
- One session manages all torrent handles, DHT bootstrapping, peer exchange, local discovery, UPnP/NAT-PMP, magnet metadata and BitTorrent v1/v2 transfers.
- Torrent states distinguish metadata discovery, file checks, waiting for peers, active transfer, pause, errors and seeding. Rates are libtorrent's payload rates.
- The UI shows file progress, tracker replies/errors, connected peers, the info hash, upload ratio, ETA and DHT/listening diagnostics. Reannounce requests refresh tracker and DHT discovery.
- Bounded throughput tuning allows 500 global connections and 250 per torrent, up to 1,024 outstanding piece requests, 10-second peer connection timeouts and tracker-tier announcements. Adaptive request sizing and TCP/uTP congestion control remain enabled, and per-torrent download limits are preserved.
- Tracker discovery uses all supplied trackers across tiers. New and resumed torrents clear the sequential flag and use the normal piece picker; sparse per-file progress does not imply sequential downloading.
- Metadata determines the actual content path, and its containing directory is created immediately. The UI can open that directory while a transfer is active. Removing with keep-files does not delete downloaded data.
- Jobs, metainfo and periodic libtorrent resume records live under `%APPDATA%\FluxFetch\torrent-session`. Paused jobs stay paused after restart. Shutdown and parent-pipe closure save state before exiting.
- `.torrent` files register in Windows Open With. Windows retains control of the user's default application. File and magnet launches ask for a destination before adding a transfer.

`config/torrent-engine.lock.json` pins the official CPython embeddable runtime and the libtorrent wheel, including SHA-256 checksums. `npm run build:torrent` prepares them; no Python installation or pip is needed on the end user's PC. Notices are shipped in `legal/third-party-licenses` and in the embedded runtime's license file.

Run `npm run test:torrent-engine` on Windows after preparing the engine. The regression test transfers a locally generated file between two local libtorrent sessions, checks its bytes, tracker failure diagnostics, pause/resume, restart persistence and removal. It contacts no public swarm. `e2e/torrent.spec.ts` covers Electron IPC, confirmations, Windows launch arguments and the themed removal dialog.

## Existing aria2 sessions

This engine does not read aria2's incompatible session format. Existing files are retained. Re-add the original torrent or magnet and select the same destination; libtorrent checks the existing data before fetching missing pieces. A torrent without reachable peers cannot be made to download by changing the client, and the UI reports discovery/connection status instead of pretending a transfer is active.
