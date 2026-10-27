# FluxFetch 3.0.0

FluxFetch 3.0.0 includes the Net Merge adapter, simultaneous download-library progress, archive tools, and browser integration updates. The refreshed 3.0.0 installer includes a YouTube audio-track selection fix.

## Highlights

- Adds Net Merge beside OmniLink, with adapter status, limits, quotas, diagnostics, and engine controls.
- Shows every active direct download and torrent together in the Downloads Library, with per-transfer progress and controls.
- Supports concurrent direct downloads, per-download recovery after restart, and browser downloads tracked independently.
- Adds an archive manager for browsing, testing, extracting, adding, and deleting files.
- Prefers YouTube audio tracks marked as original and matches audio to the video's language when that metadata is available, avoiding a dubbed track when a preferred original track is present.
- Provides the v2.0 Chrome, v1.0.0 Edge, and v2.1 Firefox extension packages, with buildable Firefox and Edge source bundles.
- Adds torrent bandwidth limits and updates speed-test and download-queue interfaces.
- Lets users choose whether to install OmniLink and Net Merge during setup.

## Downloads

- fluxfetch-3.0.0-setup.exe — refreshed Windows installer
- FluxFetch-Chrome.crx and FluxFetch-Chrome.zip — Chrome extension
- FluxFetch-Edge.zip — Microsoft Edge extension v1.0.0
- FluxFetch-Firefox.xpi and FluxFetch-Firefox.zip — Firefox extension packages
- FluxFetch-Firefox-source-2.1.zip and FluxFetch-Edge-source-1.0.0.zip — buildable browser-source bundles
- SHA256SUMS.txt — SHA-256 checksums

## SHA-256

- Windows installer: 3A160BEF1007AB3375B223706F60DEF1AE9C71402997A711A1ED752E3E1FFA36
- Chrome CRX: BA7B89F7DC54AEF5C8D7EB106DB07B881E996A33AC7A6DABD4D7160DE18ED94A
- Chrome ZIP: 2BD09694E050287B9FBA4F6BE0C1A0D1CE3269DDFC005FF19BBB5043BE843975
- Edge ZIP: 95417F53A71C9E694B19B7BC95D4E2CA4E1CF02B34828738F406C1966DFFB5AD
- Firefox XPI/ZIP: A3D3A2B5B49FA12A0E79EF2C1CCA8E9682AE3C9E0AA98238F6D7CC840EC09571
- Firefox source: 85D0F584780FB73AD2F977D80F258334573C7FDD19F53845044242FFF5F394E4
- Edge source: 2E563769EDB4DF3C004B1FD5B07646528D9D8B4802DAEA8DD403997A6C290306

The Windows installer is not Authenticode-signed. The experimental custom kernel driver is not built or included; Net Merge uses the bundled upstream Wintun component. Multi-network speed gains depend on separate Internet connections and are not guaranteed.
