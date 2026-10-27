# OmniLink

OmniLink is FluxFetch's Windows tray helper for routing selected game-launcher traffic over more than one network adapter. It is written in Rust and uses WinDivert to redirect eligible connections to a local dispatcher.

## What it routes

OmniLink redirects new IPv4 TCP connections on ports 80 and 443 from selected launcher processes. The dispatcher binds its outbound socket to an adapter's local address and interface index. Each TCP connection stays on one adapter; OmniLink does not split a single connection across links.

Existing connections are not redirected. UDP, QUIC, IPv6, and other ports are not routed. Start OmniLink before the launcher download if you want its new eligible connections to be considered. Some launchers keep connections open, so restarting their download or process may be necessary.

The tray menu lets you choose adapters and add launcher executable names. FluxFetch includes presets for Steam, Epic Games, EA, Ubisoft Connect, GOG Galaxy, Riot, Battle.net, and Rockstar. Custom names are stored in `%LOCALAPPDATA%/FluxFetch/OmniLink/launchers.txt`.

Separate Internet connections can provide additional capacity. Adapters sharing the same upstream connection do not add bandwidth. Actual results depend on the launcher, its servers, routing, and available capacity.

## Telemetry

OmniLink reports launcher receive traffic separately from payload relayed by OmniLink and total receive traffic on each adapter. A Windows ETW collector observes selected launchers over TCP and UDP, including traffic that does not pass through the relay. If collection fails or loses events, the display reports the data as unavailable rather than zero.

The overlay and tray use the same telemetry snapshot. Adapter totals include traffic from all applications; they are not presented as launcher speed. See [FluxFetch integration details](FLUXFETCH-INTEGRATION.md) for the counter definitions, routing limits, and validation steps.

## Build and check

Build the Windows helper and stage its runtime with:

```powershell
npm run build:omnilink
```

Rust stable with the MSVC toolchain is required. The build stages the helper, WinDivert runtime, and licenses. `npm run build:win` includes this step.

For the controlled observer test, build and run the diagnostic as Administrator:

```powershell
cargo build --manifest-path integrations/omnilink/Cargo.toml --example verify_observer
target/debug/examples/verify_observer.exe C:/absolute/path/report.json
```

The diagnostic checks known local IPv4/IPv6 TCP and UDP payloads and proxy accounting. It does not test public launcher compatibility or prove a speed increase. Real launcher downloads across separate physical Internet connections still need manual validation.
