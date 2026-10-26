# Net Merge in FluxFetch

Vendored from https://github.com/rohit267/net-merge at commit
`3ef82b73a75353e08236016646973aedfaaa8c32` (MIT license). Upstream source,
platform implementations, CLI, tray, tests and third-party notices are retained.

## FluxFetch integration

The Windows Downloads toolbar includes **Net Merge** alongside **Run OmniLink**.
The panel starts a separate networking engine with a Windows elevation prompt;
Electron remains an ordinary user process. Stop restores the upstream TUN routes.
Closing the panel or Electron leaves the engine running until Stop is requested.
The two buttons reject conflicting OmniLink/Net Merge sessions.

Status, logs, control requests and saved budgets live in the `net-merge` directory
under Electron's userData directory. The engine writes fresh status every second.
Start is confirmed only after the virtual adapter and routes are ready.

## Added engine behavior

- Destination affinity: IPv4 /24 and IPv6 /48 prefixes, hostname keys for SOCKS,
  a 60-second idle sliding lifetime, and a 4096-entry bound.
- Bulk promotion: more than three simultaneous flows and at least 1 MiB relayed
  in a two-second sampling window allow new flows to spread. Existing flows stay
  pinned. TCP SSH and DNS bypass bulk promotion.
- TCP connect duration is sampled passively and from existing reachability
  probes. New destinations favor the lowest observed duration; capacity weights
  penalize latency inflation during bulk scheduling. This is an estimate of
  connect latency, not wire-level SYN/SYN-ACK instrumentation.
- TUN UDP DNS sockets prefer the lowest-latency link. Other UDP retains upstream
  capacity selection; flows are not migrated between interfaces.
- A bounded HTTPS request to Cloudflare's `1.1.1.1/cdn-cgi/trace`, forced through
  each physical IPv4 adapter, discovers public IPs at most every five minutes.
  The panel warns on matching IPs. It does not automatically disable them because
  carrier NAT and VPNs can also produce matching IPs.
- Per-adapter speed controls reuse upstream rate limiting.
- Persistent, optional data budgets apply to combined relayed upload/download
  payload. Daily budgets reset at UTC midnight; non-daily budgets require an
  explicit usage reset. Hardware MAC addresses identify budgets across adapter
  renames when available; names are the fallback. Reservations are synced to disk
  before payload is granted, so a crash cannot replenish spent budget. Up to
  1 MiB of an unused reservation can be counted as spent after restarting.
  Storage errors stop budgeted traffic. Headers, retransmissions, diagnostic
  probes and traffic bypassing the relay are outside this accounting; leave a
  margin below a carrier's billed allowance.

Use `-smart=false` in the CLI to select upstream scheduling without affinity.
Optimized TCP `io.Copy`/`io.CopyBuffer` paths explicitly pass through the accounting,
quota and pacing wrappers in both directions. Exhausting a TCP budget delivers the
remaining permitted bytes and then closes the flow. A live engine with a stale
heartbeat is shown as unresponsive and retains its Stop control.
The existing pooled 128 KiB relay buffers and tun2socks TUN implementation remain.
No unmeasured CPU reduction or single-connection bandwidth aggregation is claimed.

## Build

Install Go 1.27 or newer. Run `npm run build:net-merge`, or:

```powershell
./scripts/build-net-merge.ps1 -GoExe 'C:/Program Files/Go/bin/go.exe'
```

The build runs Go tests/vet, builds CLI and tray executables, verifies the pinned
Wintun archive SHA-256 and WireGuard publisher signature, and stages binaries plus
licenses in `resources/net-merge`. `npm run build:win` includes this step and the
Windows package copies these files outside ASAR. Run it again after engine edits.

Run `npm run test:net-merge` after building to exercise the real, unprivileged SOCKS
engine process: checksum correctness, an 8 Mbit/s speed limit, live quota commands,
quota exhaustion, persistence across process restart and recovery after removing
the cap. This test uses a local HTTP server bound to a physical IPv4 interface;
it does not alter TUN routes or prove independent-WAN aggregation.

Packaged FluxFetch honors an absolute `--user-data-dir` profile switch, allowing
portable launches and checks of the actual packaged executable without touching
the normal FluxFetch profile.

## Experimental kernel fast path and signing

`driver/windows` contains an optional Windows WFP bind-redirection driver and WDK
project. The Go `fast-path -pid <PID>` controller sends a fixed-width, tested
configuration to its administrator-only, exclusive device handle every second.
The driver only affects wildcard, ephemeral binds by the explicitly selected
process. IPv4 and IPv6 adapters use configured weights. Explicit binds and prior
redirections are preserved. Closing the controller or a five-second lease expiry
stops new redirections; dynamic WFP filters disappear when the driver unloads.

The bind layer does not expose a destination address. This experimental backend
therefore does not implement the TUN scheduler's affinity, quotas or speed caps,
and is separate from the default engine. It must be validated in a disposable VM
with Driver Verifier and real multi-WAN traffic before production activation.
No kernel driver is installed or loaded by FluxFetch's ordinary Start button.

`npm run build:net-merge-driver` needs Visual Studio C++ Build Tools and a matching
Windows SDK/WDK. `scripts/sign-net-merge.ps1` signs the built executables with a
current-user code-signing certificate selected by thumbprint and verifies their
publisher signatures. `-IncludeDriver` additionally signs the experimental SYS.
The script never creates a trusted publisher, exports private keys, adds a root
certificate, disables Secure Boot, or enables Windows test-signing mode.

Production kernel deployment additionally requires Microsoft hardware signing.
SignPath OSS enrollment and certificate issuance require the project owner's
external account and approval; scripts cannot confer that trust. Existing Wintun
ships with its original WireGuard signature. See the Microsoft WFP API reference:
https://learn.microsoft.com/en-us/windows-hardware/drivers/network/using-bind-or-connect-redirection
