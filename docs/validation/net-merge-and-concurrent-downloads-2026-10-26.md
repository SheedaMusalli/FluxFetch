# Net Merge follow-up audit and concurrent downloads — 26 October 2026

## Current build

- Installer: `artifacts/net-merge-release/fluxfetch-2.0.1-net-merge-tested-setup.exe`
- Size: 185,427,892 bytes.
- SHA-256: `28FEDC42E224250DB1F591D305FDECE71B1A1086A35D5ADC75739828B8B6C4BE`.
- Rebuilt on request after the skipped-case follow-up. All three TypeScript checks, a fresh production build, installer payload verification and packaged app launch passed. Build record: `artifacts/net-merge-release/installer-build-info.json`; checksum sidecar: `fluxfetch-2.0.1-net-merge-tested-setup.exe.sha256`.
- Signature: **NotSigned**. The generic electron-builder signing progress messages do not establish an Authenticode signature.
- This installer supersedes the original `fluxfetch-2.0.1-setup.exe` and the earlier build with the same `net-merge-tested` filename.
- Packaged app: `artifacts/net-merge-release/win-unpacked/fluxfetch.exe`.

## Concurrent library behavior

Manually started direct downloads run together. Setup and file-name reservations are serialized; the actual transfers run independently. The explicit Queue & Schedule feature retains sequential scheduling.

The library receives snapshots and events for every direct download by ID. Each active row shows downloaded bytes, total size, percentage, speed, and its own pause/resume/cancel controls. Direct progress windows continue to subscribe only to their own ID. Reloading the library reconstructs all rows. Restarting the app restores every persisted download paused, preserving each partial file for independent resumption.

All current torrents also appear as library rows with their individual state, progress and controls. The bottom transfer panel contains torrents only. Paused torrents and torrents awaiting metadata remain visible. Finished and seeding torrents remain in the library until removed. Torrent removal from these controls keeps downloaded files.

Browser-originated direct downloads can start while other direct transfers are active or paused. The browser queue adopts and tracks each native download by ID after restart. Media processing also waits for its own transfer ID, preventing a newer direct download from hiding the media transfer's completion.

## Concurrency validation

- TypeScript checks: main, renderer and E2E passed.
- ESLint: changed TypeScript and concurrency tests passed.
- Focused Electron suite: **32 passed, 1 skipped**. Includes ordinary transfers, recovery, torrent UI and live library checks.
- New real transfer scenario: three concurrent direct files, two requested with the same filename, unique output paths, independent pause/resume, other transfers continuing, library reload, and all three SHA-256 checksums correct.
- New real libtorrent scenario: two separate magnet transfers coexist with a direct download; both appear in the table and torrent-only footer; pausing one leaves the other unpaused. These magnets intentionally have no swarm, so this validates metadata/waiting/control behavior rather than swarm throughput.
- Restore scenario: two distinct saved downloads both restore paused and both resume to files matching their source checksums.
- Native browser-host integration: **1 passed**. Authenticated concurrent downloads, encrypted request persistence, both transfers restored/resumed, and redirect credential isolation.
- Actual packaged EXE: **three simultaneous 8 MiB files** downloaded through the discovered Realtek Ethernet adapter. All checksums matched `7014ae0f2fc0fee42a440b97859207efb72ffee09d4864f7433f1bf756a17aca`. Per-row controls and absence of a direct-download footer were verified. No test-only network overrides were used; `app.isPackaged` was true.
- Packaged evidence: `artifacts/library-packaged-result.json`, `artifacts/library-packaged-live.png`.
- Repeat packaged download check: `node scripts/verify-packaged-library.cjs` after staging the packaged app.
- Final broader Electron smoke run: **99 passed, 9 skipped, 0 failed** in 5.1 minutes against the final source build; `artifacts/concurrent-library-smoke/.last-run.json`. Includes per-download windows, cancellation, library history, sequential queue UI, crash recovery, settings, network handling and all six Net Merge journeys.
- Follow-up requested rerun: **all nine previously skipped cases subsequently passed** across targeted runs. Eight network cases used independently source-bound `127.0.0.1` and `127.0.0.2` TCP sockets; the ninth used a real Windows ACL denying file/directory creation in a fresh temporary destination. See [the skipped-case rerun report](skipped-tests-2026-10-26.md) for conditions and the permission-harness corrections. This is coverage across separate runs, not a claim that one run reported 108 passes.

## Defects found and fixed during the Net Merge audit

The initial implementation was incomplete. Real optimized TCP copies bypassed quota/rate/accounting wrappers through promoted `net.TCPConn` methods. The reproduction transferred 4,096 bytes despite a one-byte cap, in both directions. Explicit `ReadFrom` and `WriteTo` wrappers now force the same accounting and quota paths as ordinary reads and writes. Regression tests cover both directions and the final partially allowed chunk.

Other fixes include charging only bytes actually written, shared UDP/TCP quota accounting, preserving the Stop control for a live engine with a stale heartbeat, waiting for actual TUN readiness instead of declaring success early, malformed status validation, and surfacing quota storage errors.

The actual packaged app also exposed incorrect packaged icon paths that prevented startup. Those were corrected and verified by launching the packaged EXE. The Windows crash-test harness was corrected to kill the test Electron process tree, rather than only its launcher shell.

## Net Merge validation evidence

- Upstream Go suite and added affinity, scheduling, quota, TCP-copy, UDP and driver-protocol checks passed; `go vet ./...` passed. The complete Go suite was repeated three times after the engine corrections.
- Real packaged engine process: 2 MiB relay checksum verified; an 8 Mbit/s limit took 2,057 ms; a 100,000-byte budget delivered 99,787 body bytes, with the remainder accounted for by request/response bytes; restarting with the exhausted persisted quota delivered zero body bytes. Removing the quota restored the full checksum-correct transfer.
- Evidence: `artifacts/net-merge-process-test/result.json` and `engine.log`.
- Net Merge Electron journeys cover simulated status, controls, limits/budgets, missing runtime, invalid input, launch errors and stale heartbeat. Simulation is not evidence of privileged TUN operation.
- Previous complete smoke baseline after the Net Merge fixes: **97 passed, 9 skipped**; `artifacts/net-merge-audit-final`.
- Final packaged app starts with an isolated profile, reports the bundled engine installed and stopped, enables Start, and rejects invalid adapter/limit input; `artifacts/net-merge-packaged-result.json`.
- Installer extracted without installing: app archive, main/preload scripts, engine binaries, Wintun, licenses and icons matched staging output. Existing OmniLink and torrent runtimes were present. The latest packaging integrity check covered 8,307 files and startup entries.

## Implemented features and remaining limits

| Area | State |
| --- | --- |
| Full upstream source at commit `4f9579410244c15abd6a8a8ac1787e3e7bf4ca45`, MIT attribution | Included under `integrations/net-merge` |
| Net Merge dialog alongside OmniLink; start/stop, speed limits, persistent budgets | Implemented |
| Bounded destination-prefix affinity, bulk-flow steering, latency and RTT inflation scheduling | Implemented and engine tested |
| Physical-adapter HTTPS public-IP discovery | Implemented; equal egress IP produces a warning, not automatic adapter deduplication |
| Per-hardware quota identity across rename/reconnect, daily/manual reset, fail-closed storage behavior | Implemented and engine tested |
| Standard Wintun runtime | Included; original WireGuard publisher signature verified |
| WFP kernel driver and controller | Experimental source, INF, build project and control protocol included; **not compiled or loaded** |
| Driver signing | Signing script included; no signing certificate available |
| Privileged service, eBPF, GRO/GSO acceleration | **Not implemented** |

The WFP prototype cannot be described as a working production driver. Visual Studio C++ tools and Windows SDK/WDK were unavailable, and there was no code-signing certificate. No Driver Verifier run, kernel loading, Microsoft hardware signing, or certification was performed. The normal Start button uses upstream Wintun, not the experimental WFP prototype.

Only one physical Internet connection was available. Real multi-WAN aggregation/failover and system-wide privileged TUN route changes were not exercised. The bounded TUN verification helper is `scripts/verify-net-merge-tun.ps1`; it has not been run. No throughput or CPU improvement claim is made for these untested paths. The original nine smoke skips have now been covered using real local sockets with simulated interface changes and an actual Windows ACL denial; these checks do not establish physical multi-WAN performance.
