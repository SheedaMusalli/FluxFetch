# OmniLink speed measurement and routing investigation

Research date: 20 October 2026, Asia/Karachi. Implementation inspected: main at e970370. This document records findings and a proposed design; it does not establish that the proposed collector has been implemented or validated.

## Conclusion

The current main speed display measures only receive payload read by OmniLink's proxy. It cannot report total launcher traffic when connections bypass that proxy. Shortening the averaging window addresses display latency, not missing connections. The screenshot showing a Steam network rate of 14.6 Mbps, zero routed connections and 0.0 Mbps in OmniLink is consistent with this design failure.

Measurement must be independent of routing. The product needs an observed launcher rate and a routed rate, with explicit collection health and routing coverage. Changing labels or matching a displayed number with a multiplier is insufficient.

## Evidence from this PC and source

A read-only diagnostic sample found established IPv4 HTTP/HTTPS launcher connections while the screenshot reported zero routed connections. The launcher had started before OmniLink. Startup ordering makes existing direct connections a strong candidate. This snapshot did not capture traffic on individual sockets or establish their creation times, so it does not prove which connection carried the download. IPv6 or UDP should not be assumed to explain these particular observed IPv4 connections.

Confirmed source issues:

1. `src/interceptor.rs` only registers a new redirect when a matching outbound TCP SYN is seen. Its filter is IPv4 TCP, destination ports 80/443. Existing sessions and other protocols do not enter the relay.
2. `src/dispatcher.rs` increments receive counters only when reading the upstream relay socket. No independent launcher network observer exists.
3. Process ownership is checked using the source port and a TCP-table query at SYN time. This lacks full endpoint identity, and the table reader accepts an insufficient-buffer result instead of retrying the resized query. These need correction; neither has been proven to cause this screenshot.
4. NAT entries are removed 600 seconds after creation, even if still active. A long-lived connection can therefore lose translation state. Expiry needs connection lifecycle/idle tracking.
5. `src/overlay.rs` renders `BONDING ON` from the enabled setting. This is not evidence of traffic on multiple interfaces, successful redirection, or independent Internet capacity.

The earlier averaging adjustment was not sufficient to resolve these coverage problems.

## What the official sources establish

### Units and accounting boundaries

Valve documents the distinction between bits and bytes and warns that LAN link speed is not Internet download speed. Both fields in this screenshot already say Mbps, so an eightfold unit correction does not explain the zero reading. [Steam Support](https://help.steampowered.com/en/faqs/view/5AC5-8056-E88F-F3FF)

SteamPipe transfers compressed, encrypted chunks that are expanded on the client. Consequently downloaded network bytes, installed bytes and disk activity are different quantities. Disk throughput must not be used to calculate network download throughput. [Valve SteamPipe documentation](https://partner.steamgames.com/doc/sdk/uploading?l=english)

### Process ownership and connection coverage

WinDivert's network layer provides packets without process IDs. Flow/socket layers provide process information but do not replay events predating handle creation. Its documentation describes correlating network five-tuples with process events. Our recommendation is to seed existing endpoint ownership from Windows TCP tables and use events for subsequent changes. The seed supports measurement; it does not make an established connection redirectable. [WinDivert layer/filter documentation](https://reqrypt.org/windivert-doc.html)

The official stream redirection example is a useful reference for packet translation, but it is not proof of correct per-process metering or universal launcher compatibility. [WinDivert streamdump source](https://raw.githubusercontent.com/basil00/WinDivert/master/examples/streamdump/streamdump.c)

### Independent measurement options

Windows kernel ETW provides TCP and UDP send/receive events. Microsoft specifically warns against assigning ownership using only the event-header process ID; consumers must use the network event's process property. Event schemas include endpoint information and a size field. This makes ETW a candidate for observing launcher network activity even when a relay is uninvolved. It requires proper schema/version decoding and loss detection. [TCP events](https://learn.microsoft.com/en-us/windows/win32/etw/tcpip), [IPv4 TCP schema](https://learn.microsoft.com/en-us/windows/win32/etw/tcpip-typegroup1), [IPv4 UDP schema](https://learn.microsoft.com/en-us/windows/win32/etw/udpip-typegroup1)

For TCP cross-checking, Windows EStats offers per-connection counters, including IPv6 variants. Collection must be enabled with sufficient privilege; consumers must check `EnableCollection` and API success. Disabled collection is not a valid zero measurement. [GetPerTcpConnectionEStats](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getpertcpconnectionestats)

Counter semantics matter: `DataBytesIn` includes retransmitted received payload, while `ThruBytesReceived` represents cumulatively acknowledged receive progress. Neither should be confused with decompressed game-file bytes. For TCP useful-throughput comparison, evaluate receive-progress deltas; use raw-byte counters separately for transport diagnostics. [TCP extended data statistics](https://learn.microsoft.com/en-us/windows/win32/api/tcpestats/ns-tcpestats-tcp_estats_data_rod_v0)

Interface `InOctets`/`OutOctets` are appropriate for whole-adapter activity. They include other apps and non-unicast traffic, so substituting their totals for launcher speed would introduce another error. [MIB_IF_ROW2](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/ns-netioapi-mib_if_row2)

### Routing versus measurement

Microsoft documents WFP ALE connection redirection and the redirect records/context that associate original and proxy connections. This is an alternative for a more substantial driver-backed routing design, with a separate implementation, signing and validation cost. It is not a reason to ship an untested driver or to claim existing sockets can be moved transparently. [WFP bind/connect redirection](https://learn.microsoft.com/en-us/windows-hardware/drivers/network/using-bind-or-connect-redirection)

`IP_UNICAST_IF` selects an outgoing IPv4 interface; its index is supplied in network byte order. Our binder already sets this option and binds a local address. That alone does not establish receive-path correctness, multiple active upstreams or a bandwidth gain. [Microsoft socket options](https://learn.microsoft.com/en-us/windows/win32/winsock/ipproto-ip-socket-options)

## Recommended implementation

1. Add an independent launcher observer. Prototype ETW TCP/UDP receive events for broad live network coverage, alongside a TCP EStats diagnostic mode to validate accounting. Track IPv4/IPv6 separately and enumerate running client/service processes. Identify process instances using PID plus lifetime information to avoid PID-reuse mistakes. Do not infer successful collection from a process being present.
2. Retain proxy counters for routed payload. Associate each upstream proxy socket with its originating launcher, client endpoint and selected interface. Count the external transfer once. Do not add both the relay's upstream bytes and its client-facing delivery bytes into the same launcher total. With packet-level observation, correlate rewritten legs explicitly; do not assume every local relay leg still appears as a loopback address after NAT.
3. Expose distinct metrics: observed launcher network receive rate, OmniLink routed payload rate, and whole-adapter receive rate. Use compatible byte definitions before calculating a coverage ratio; packet bytes and relay payload bytes are not directly interchangeable. Do not derive a speed-gain percentage from adapter link rates.
4. Report routing states accurately: disabled, unavailable, waiting for new connections, routing on one adapter, and routing on multiple adapters. Multiple adapters being present/enabled is not evidence that traffic uses both. An observer failure should display unavailable/stale data, not a fabricated zero.
5. Improve interception ownership using full protocol/local/remote tuples, retry TCP-table buffer growth, track connection lifecycle and avoid expiring active NAT state purely by age. Use socket/flow metadata where applicable. Keep measurement working for direct sessions even when redirection cannot apply.

## How speeds should stay synchronized

Every total, adapter row and tray tooltip must consume the same immutable telemetry snapshot and the same measurement interval. Do not independently recalculate or smooth each UI field.

For an interval from t0 to t1:

`Mbps = 8 * (received_bytes(t1) - received_bytes(t0)) / (elapsed_seconds * 1,000,000)`

Use a monotonic clock and the actual elapsed duration, not the nominal timer interval. Windows recommends its performance counter for high-resolution interval measurement. Initialize newly attached counters at their current value so historical bytes cannot create a startup spike. Handle resets and disappearing connections explicitly. [Microsoft timing guidance](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps)

A reasonable proposed UI policy is a 250-500 ms publish cadence with a time-weighted one-second rate and an optional longer average. These are proposed product choices, not Valve's documented sampling settings. Aggregate byte deltas over one shared interval before computing rates. Expire stale samples; distinguish measured idle from missing telemetry.

The reviewed Valve sources do not document the exact current Steam UI averaging algorithm or offer a universal launcher-rate synchronization interface. Matching it digit-for-digit cannot be promised. Compare matched units and comparable bytes over 30-60 second intervals, alongside simultaneous UI recordings. Different sampling boundaries, protocol overhead, retransmissions and background requests may produce modest differences; an ongoing download with an unexplained zero needs a coverage/collection diagnosis.

## Required validation before another accuracy claim

- Start a transfer before OmniLink: observed launcher traffic must appear while routing coverage can remain zero.
- Start OmniLink first and then a new transfer: record original sockets, relay sockets and actual adapter byte deltas.
- Test Steam Workshop as well as game downloads; avoid dependence on only game-update log entries.
- Exercise Epic and other launcher worker/service processes, direct IPv6 traffic and UDP traffic. Observation support and routing support must be reported separately.
- Use controlled known-size TCP transfers to compare cumulative receive progress, relay bytes and delivered bytes over the same interval. Include multiple concurrent streams and retransmission scenarios.
- Run a competing browser download: it must affect adapter totals without inflating the selected launcher's total.
- Verify no double-counting through the proxy, no startup spikes, pause/resume, process restart/PID reuse, adapter removal and collection failures.
- Keep a routed connection active beyond ten minutes to test lifecycle-based NAT retention.
- Validate routing across genuinely independent connections with separate egress observations. A compilation, synthetic distribution simulation or socket-owner lookup alone cannot prove live bandwidth aggregation.

This investigation produced no new accuracy release. The next substantive change should be an independent measurement collector and routing diagnostics, followed by these live tests.

## Implementation follow-up, 20 October 2026

The independent collector is now implemented using the Microsoft-Windows-Kernel-Network ETW provider through pinned FerrisETW 1.2.0. It reads the event payload PID, receives TCP/UDP IPv4/IPv6 events, checks session/loss/decoding health, and matches process lifetime timestamps. Proxy registration distinguishes its upstream from the launcher-facing leg to count the transfer once. The displayed observed rate, routed rate and interface receive rates come from a single elapsed-time snapshot. Collection failures and stale samples display unavailable, and routing labels reflect measured use of one or multiple adapters rather than the enabled setting.

The TCP ownership query now retries buffer growth and validates full endpoints. Translation entries remain while their original socket exists, removing the ten-minute active-session expiry. Routing remains limited to new eligible IPv4 TCP connections; observing an existing or unsupported flow does not make it redirected.

Controlled elevated ETW tests on this PC observed exactly 2,097,152 bytes on each pre-existing IPv4/IPv6 TCP transfer, 262,144 bytes on each IPv4/IPv6 UDP transfer, and 2,097,152 bytes on a proxied transfer with duplicate delivery excluded. The saved [validation output](validation/omnilink-observer-2026-10-20.txt) records those runs. These are byte-accounting tests, not evidence of public-launcher aggregation speed. EStats remains an optional future independent cross-check, not an implemented data source.
