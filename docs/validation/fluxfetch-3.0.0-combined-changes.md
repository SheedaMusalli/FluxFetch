# FluxFetch 3.0.0 — combined change record

This report combines the earlier FluxFetch/Net Merge and concurrent-transfer work with the Antigravity changes summarized in the user-provided attachment. The project checkout now lives at `F:\FluxFetch`.

## Combined application changes

### Network engines and downloads

- Added the Net Merge entry beside OmniLink in the downloads library, with engine status, start/stop, adapter limits, quotas and diagnostics. The vendored upstream project and integration source are in `integrations/net-merge`; its CLI and tray executables are packaged from `resources/net-merge`.
- Preserved FluxFetch's concurrent direct-download behavior: each transfer owns its runtime, destination reservation, progress row and pause/resume/cancel controls. Reload/restart restores each partial transfer, and the library also lists all torrents while the footer remains torrent-only.
- Direct-download streams use independently bound network routes. Newly discovered interfaces can be added to a running splittable download when the manager refreshes its interface list; they join as routes become available. Per-stream scheduling and retry handling remain inside the download manager.
- Browser-originated downloads and YouTube processing track their own transfer IDs, so parallel transfers do not hide or block each other's completion.
- Added socket TCP_NODELAY/keepalive settings and a larger disk writer buffer.

### Downloads library and app interface

- Added resizable, persistent library columns and configurable visibility, including speed, progress, ETA, category and network information.
- Live direct downloads and torrents appear together in the library with per-transfer controls. The bottom transfer footer reports torrents only.
- File-size formatting uses MB below 1 GiB and GB at or above 1 GiB. The completed-download screen closes after its follow-up actions.
- Updated the speed-test layout, torrent download/upload limits, and queue action-button sizing.

### Archive manager

- Added the archive manager UI for browsing, searching, sorting, testing, extracting, adding, deleting and refreshing archive contents.
- Bundled the 7-Zip CLI/runtime in `resources/archive-tools` and included it as an extra Windows resource. The archive backend uses it for encrypted ZIP/AES and RAR operations, alongside ZIP/RAR preview support.
- Archive path checks reject traversal outside the chosen extraction folder.

### YouTube and browser extensions

- Added page-side YouTube format discovery and background prefetching in both Chrome and Firefox extensions.
- Redesigned the quality picker, added resolution/audio badges, and corrected backend height propagation and audio-only detection.

### Installer and version

- Set the application version to **3.0.0** and rebuilt the Net Merge CLI/tray with the matching version string.
- Added an installer component-selection page for OmniLink and Net Merge. The installer persists selections and removes unselected engine resources; the app hides engine entry points when their binaries are absent.
- The latest project release installer is `release/fluxfetch-3.0.0-setup.exe` (186,265,130 bytes, SHA-256 `1DA1F2A4965A76D0D6CEBD1F7C3A5D9DD1B72E0605BAE67F1B5CDF075CD5E2C2`). It is **not Authenticode-signed**.
- The separately audited Net Merge installer is `artifacts/net-merge-release/fluxfetch-3.0.0-net-merge-tested-setup.exe` (185,427,824 bytes, SHA-256 `78DEF435EADE3A975333AAACC22C2131425F33D118EDF60B577AF827DF4DB79C2`). It is also **not Authenticode-signed**. Its packaged app version and Net Merge version were verified as 3.0.0.
- Chrome and Firefox extension packages and hashes are recorded in `release/SHA256SUMS.txt`.

## Validation evidence

- The combined checkout passes `npm run typecheck` (main, renderer and E2E TypeScript projects).
- Earlier concurrent-transfer validation exercised three simultaneous direct files, duplicate filenames, per-transfer pause/resume, restart recovery, checksums, and simultaneous torrents; the smoke report recorded 99 passed, 9 skipped, 0 failed. The nine skipped cases were subsequently rerun and passed across focused runs. See `skipped-tests-2026-10-26.md` and `net-merge-and-concurrent-downloads-2026-10-26.md` for the detailed evidence and limits.
- Net Merge process and packaged-app checks are documented in `net-merge-and-concurrent-downloads-2026-10-26.md` and the associated files under `artifacts/`.
- TypeScript checks were rerun after the move to `F:\FluxFetch` and pass. ESLint error checks pass on the changed application and extension sources. The full-repository lint command was stopped after consuming over 1 GB of memory without completing; formatting warnings from the broader targeted scan are not claimed as resolved.

## Scope and limits

- Net Merge is a user-mode networking engine. The repository contains an experimental Windows WFP driver project, but it was not built, installed, signed or validated. No custom kernel driver or signed FluxFetch binaries are included in the verified deliverable.
- The bundled Wintun component is the upstream signed component; this does not mean the experimental FluxFetch driver is signed.
- Physical multi-WAN throughput/failover and privileged TUN route lifecycle were not verified on this machine. Adapter-source simulation tests do not establish real-world multi-provider bandwidth aggregation.
- The report in `net-merge-and-concurrent-downloads-2026-10-26.md` records the earlier 2.0.1 build as a historical build record; the 3.0.0 build facts above supersede it for current release identification.
