# FluxFetch 3.0.0

FluxFetch 3.0.0 includes the Net Merge adapter, simultaneous download-library progress, archive tools, and browser integration updates. The refreshed 3.0.0 installer includes a YouTube audio-track selection fix.

## Highlights

- Adds Net Merge beside OmniLink, with adapter status, limits, quotas, diagnostics, and engine controls.
- Shows every active direct download and torrent together in the Downloads Library, with per-transfer progress and controls.
- Supports concurrent direct downloads, per-download recovery after restart, and browser downloads tracked independently.
- Adds an archive manager for browsing, testing, extracting, adding, and deleting files.
- Prefers YouTube audio tracks marked as original and matches audio to the video's language when that metadata is available, avoiding a dubbed track when a preferred original track is present.
- Provides v2.0 extension packages for Chrome, Edge, and Firefox, with buildable Firefox and Edge source bundles.
- Adds torrent bandwidth limits and updates speed-test and download-queue interfaces.
- Lets users choose whether to install OmniLink and Net Merge during setup.

## Downloads

- fluxfetch-3.0.0-setup.exe — refreshed Windows installer
- FluxFetch-Chrome.crx and FluxFetch-Chrome.zip — Chrome extension
- FluxFetch-Edge.zip — Microsoft Edge extension
- FluxFetch-Firefox.xpi and FluxFetch-Firefox.zip — Firefox extension packages
- FluxFetch-Firefox-source-2.0.zip and FluxFetch-Edge-source-2.0.zip — buildable browser-source bundles
- SHA256SUMS.txt — SHA-256 checksums

## SHA-256

- Windows installer: 3A160BEF1007AB3375B223706F60DEF1AE9C71402997A711A1ED752E3E1FFA36
- Chrome CRX: 40432D6F3EC8085CE043330706F9F63116D4FD0760AF36F0608680795282D147
- Chrome ZIP: 9C53B1E6B6CB037BA25267EDA762D4E38B507A2597570F690A836739D591F13C
- Edge ZIP: 21AB97F836BFBE79DF467693CA99E27EA08CBEC774F07AC2C5E1962501DB28D9
- Firefox XPI/ZIP: C2982D3635DADBEFDBC14B5047A3705C0A3520580C93B5FF2015C3895D157143
- Firefox source: 69CE4D4041A7E905686E4478BF3B5C4122E413969754D617794F1231A65A039F
- Edge source: F211F65FCF5740C9F8A5B57AB1666DF1A1998B378F26ED53F89F9DFE950AC049

The Windows installer is not Authenticode-signed. The experimental custom kernel driver is not built or included; Net Merge uses the bundled upstream Wintun component. Multi-network speed gains depend on separate Internet connections and are not guaranteed.
