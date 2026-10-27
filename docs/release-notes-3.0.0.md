# FluxFetch 3.0.0

FluxFetch 3.0.0 adds Net Merge, active-transfer rows in the download library, and archive tools. YouTube audio selection now prefers the original track when that information is available.

## Changes

- Net Merge sits beside OmniLink. Its panel shows adapter status and quotas, and lets you set limits and start or stop the engine.
- The library shows every active direct download and torrent with its own progress and controls. Direct downloads can run together and restore independently after a restart.
- Browser downloads are tracked separately. The new archive manager can browse, test, extract, add, and remove archive entries.
- YouTube prefers audio marked original, then a track matching the video's language when that information is available.
- Chrome v2.0 and Edge v1.0.0 packages are in the release. Install Firefox from [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/fluxfetch-integration-module/).
- Torrent bandwidth limits and updates to the speed test and download queue are included. Setup lets you choose whether to install OmniLink and Net Merge.

## Downloads

- fluxfetch-3.0.0-setup.exe — Windows installer
- FluxFetch-Chrome.crx and FluxFetch-Chrome.zip — Chrome extension
- FluxFetch-Edge.zip — Microsoft Edge extension v1.0.0
- [Firefox add-on](https://addons.mozilla.org/en-US/firefox/addon/fluxfetch-integration-module/)
- FluxFetch-Firefox-source-2.1.zip and FluxFetch-Edge-source-1.0.0.zip — source bundles for review and development
- SHA256SUMS.txt — SHA-256 checksums

## SHA-256

- Windows installer: 3A160BEF1007AB3375B223706F60DEF1AE9C71402997A711A1ED752E3E1FFA36
- Chrome CRX: BA7B89F7DC54AEF5C8D7EB106DB07B881E996A33AC7A6DABD4D7160DE18ED94A
- Chrome ZIP: 2BD09694E050287B9FBA4F6BE0C1A0D1CE3269DDFC005FF19BBB5043BE843975
- Edge ZIP: 95417F53A71C9E694B19B7BC95D4E2CA4E1CF02B34828738F406C1966DFFB5AD
- Firefox source: 85D0F584780FB73AD2F977D80F258334573C7FDD19F53845044242FFF5F394E4
- Edge source: 2E563769EDB4DF3C004B1FD5B07646528D9D8B4802DAEA8DD403997A6C290306

The Windows installer is not Authenticode-signed. The experimental custom kernel driver is not built or included; Net Merge uses the bundled upstream Wintun component. Multi-network speed gains depend on separate Internet connections and are not guaranteed.
