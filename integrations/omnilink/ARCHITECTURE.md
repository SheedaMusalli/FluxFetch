# OmniLink architecture

OmniLink has two separate jobs: redirect selected connections and report network activity. Redirecting traffic does not provide a complete measure of launcher traffic, so the app keeps those counters separate.

## Routing path

```text
Selected launcher
    │ new IPv4 TCP connection on port 80 or 443
    ▼
WinDivert interceptor
    │ redirects the connection to the local dispatcher
    ▼
Dispatcher ── chooses an enabled adapter
    │ binds the adapter's local IPv4 address and interface index
    ▼
Remote server
```

WinDivert identifies eligible outbound connections from configured launcher processes. The dispatcher opens the upstream connection on one available adapter and relays the TCP stream. It may assign different connections to different adapters, but a single connection remains on one adapter.

The current redirector handles new IPv4 TCP connections to ports 80 and 443. It does not redirect existing connections, UDP/QUIC, IPv6, or other ports. See [the integration notes](FLUXFETCH-INTEGRATION.md) for process presets and user-visible limits.

## Adapter selection

The adapter manager tracks interface addresses and indices. Outbound sockets bind both the selected local IPv4 address and the Windows `IP_UNICAST_IF` interface index; binding only an address does not reliably select the route on Windows.

The load balancer uses observed traffic and connection latency to choose among enabled adapters. Interface link rate is not a measure of Internet capacity. Separate upstream Internet connections are needed to add capacity, and the remote server must accept concurrent connections from them.

## Telemetry

Relay counters include traffic that passes through the dispatcher. A separate ETW collector measures selected launcher receive traffic, including direct connections that OmniLink cannot redirect. Interface counters show traffic from all applications. The overlay and tray read the same snapshot so these values are not mixed or shown as interchangeable speeds.

ETW collection can fail or lose events. In that case the launcher reading is unavailable, not zero. The observer and relay measurements are useful for diagnostics; they do not prove that a public launcher will gain speed.

## Components

| Component             | Role                                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| Adapter manager       | Tracks usable interfaces, addresses, and interface indices.                |
| WinDivert interceptor | Selects launcher processes and redirects eligible outbound connections.    |
| Dispatcher            | Relays connections and opens each upstream socket on one selected adapter. |
| Load balancer         | Chooses an enabled adapter for each new relayed connection.                |
| ETW observer          | Measures selected launcher traffic independently of the relay.             |
| Tray and overlay      | Display status, counters, and adapter controls.                            |

The helper runs with Windows administrator approval because packet redirection and ETW collection require elevated access. The FluxFetch desktop app itself does not run elevated.
