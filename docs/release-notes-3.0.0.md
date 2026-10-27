# FluxFetch 3.0.0

FluxFetch 3.0.0 includes the Net Merge adapter, simultaneous download-library progress, archive tools, and browser integration updates. The refreshed 3.0.0 installer includes a YouTube audio-track selection fix.

## Highlights

- Adds Net Merge beside OmniLink, with adapter status, limits, quotas, diagnostics, and engine controls.
- Shows every active direct download and torrent together in the Downloads Library, with per-transfer progress and controls.
- Supports concurrent direct downloads, per-download recovery after restart, and browser downloads tracked independently.
- Adds an archive manager for browsing, testing, extracting, adding, and deleting files.
- Prefers YouTube audio tracks marked as original and matches audio to the video's language when that metadata is available, avoiding a dubbed track when a preferred original track is present.
- Provides v2.0 extension packages for Chrome and Edge, plus Firefox v2.1, with buildable Firefox and Edge source bundles.
- Adds torrent bandwidth limits and updates speed-test and download-queue interfaces.
- Lets users choose whether to install OmniLink and Net Merge during setup.

## Downloads

- fluxfetch-3.0.0-setup.exe — refreshed Windows installer
- FluxFetch-Chrome.crx and FluxFetch-Chrome.zip — Chrome extension
- FluxFetch-Edge.zip — Microsoft Edge extension
- FluxFetch-Firefox.xpi and FluxFetch-Firefox.zip — Firefox extension packages
- FluxFetch-Firefox-source-2.1.zip and FluxFetch-Edge-source-2.0.zip — buildable browser-source bundles
- SHA256SUMS.txt — SHA-256 checksums

## SHA-256

- Windows installer: 1DA1F2A4965A76D0D6CEBD1F7C3A5D9DD1B72E0605BAE67F1B5CDF075CD5E2C2
- Chrome CRX: BA7B89F7DC54AEF5C8D7EB106DB07B881E996A33AC7A6DABD4D7160DE18ED94A
- Chrome ZIP: 2BD09694E050287B9FBA4F6BE0C1A0D1CE3269DDFC005FF19BBB5043BE843975
- Edge ZIP: 5DB2FA4C163F5D4BD48196B3ADADFF67034BD1017C9DAED760F690D4479CF3B8
- Firefox XPI/ZIP: A3D3A2B5B49FA12A0E79EF2C1CCA8E9682AE3C9E0AA98238F6D7CC840EC09571
- Firefox source: 85D0F584780FB73AD2F977D80F258334573C7FDD19F53845044242FFF5F394E4
- Edge source: F211F65FCF5740C9F8A5B57AB1666DF1A1998B378F26ED53F89F9DFE950AC049

The Windows installer is not Authenticode-signed. The experimental custom kernel driver is not built or included; Net Merge uses the bundled upstream Wintun component. Multi-network speed gains depend on separate Internet connections and are not guaranteed.
