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

SHA-256 checksums for all release downloads are in `SHA256SUMS.txt`.

- Windows installer SHA-256: `1DA1F2A4965A76D0D6CEBD1F7C3A5D9DD1B72E0605BAE67F1B5CDF075CD5E2C2`
- Chrome CRX SHA-256: `1D551F786AD2A8355C54AF25888C098880C29E9C00DE519203917067CF1986C8`
- Chrome ZIP SHA-256: `4686AA1242DF334DB970F13E6098D6B747990741C9B77C10A1E134B924168541`
- Firefox XPI/ZIP SHA-256: `BDEE8803E1B16C19DE2A4C8D151A7300AF617C08DED122B7402A6ED27847D423`

The Windows installer is not Authenticode-signed. The experimental custom kernel driver is not built or included; Net Merge uses the bundled upstream Wintun component. Multi-network speed gains depend on using separate internet connections and are not guaranteed.
