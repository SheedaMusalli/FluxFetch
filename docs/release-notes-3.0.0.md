# FluxFetch 3.0.0

FluxFetch 3.0.0 brings Net Merge adapter bonding and a broader set of download, library, archive, torrent, and browser improvements.

## Highlights

- Adds Net Merge beside OmniLink, with adapter status, limits, quotas, diagnostics, and engine controls.
- Shows every active direct download and torrent together in the Downloads Library, with per-transfer progress and controls. The footer remains dedicated to torrents.
- Supports concurrent direct downloads, per-download recovery after restart, and browser downloads that are tracked independently.
- Adds an archive manager for browsing, testing, extracting, adding, and deleting files. Bundled 7-Zip handles encrypted ZIP/AES and RAR extraction.
- Improves YouTube format detection and quality selection in the app, Chrome extension, and Firefox extension.
- Adds torrent bandwidth limits and updates the speed-test and download-queue interfaces.
- Lets users choose whether to install OmniLink and Net Merge during setup.

## Downloads

- `fluxfetch-3.0.0-setup.exe` — Windows installer
- `FluxFetch-Chrome.crx` and `FluxFetch-Chrome.zip` — Chrome extension
- `FluxFetch-Firefox.xpi` and `FluxFetch-Firefox.zip` — Firefox extension
- `SHA256SUMS.txt` — SHA-256 checksums

Installer SHA-256: `1DA1F2A4965A76D0D6CEBD1F7C3A5D9DD1B72E0605BAE67F1B5CDF075CD5E2C2`

The Windows installer is not Authenticode-signed. The experimental custom kernel driver is not built or included; Net Merge uses the bundled upstream Wintun component. Multi-network speed gains depend on using separate internet connections and are not guaranteed.
