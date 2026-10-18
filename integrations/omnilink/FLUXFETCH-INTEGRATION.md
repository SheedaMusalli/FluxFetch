# FluxFetch OmniLink integration

This directory contains the Steam Download Booster / OmniLink source copied into FluxFetch. Its original source files and project documentation are preserved. The `overlay.rs` palette and heading are adapted to FluxFetch's dark interface colors and branding.

`npm run build:omnilink` builds the Windows x64 tray helper from this source and stages its executable, WinDivert runtime files, and license into `resources/omnilink`. The Windows installer build runs this step automatically. Rust's stable MSVC toolchain is required.

The FluxFetch **Run OmniLink** button starts the helper through Windows' standard administrator-consent flow. The helper uses WinDivert to intercept Steam HTTP(S) traffic and attempt per-connection multi-adapter routing. Its own tray menu controls whether bonding is enabled, which adapters are selected, and whether the overlay is visible. FluxFetch does not silently elevate, configure Windows routes, or claim that every Steam download/CDN will combine links. Actual throughput depends on the user's independent Internet connections and Steam's servers.

OmniLink's live interception and Steam download behavior remain a manual hardware validation step; a successful compile or unit test does not prove a given PC/network configuration will accelerate Steam. WinDivert's dual LGPLv3/GPLv2 license notice is copied alongside the source and is included with the packaged helper.
