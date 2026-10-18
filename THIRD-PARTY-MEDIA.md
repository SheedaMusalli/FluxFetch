# Optional media components

FluxFetch downloads the pinned YouTube/video helpers on first use into its per-user data folder and verifies each asset against `media-tools.lock.json`. yt-dlp and Deno are downloaded when YouTube media is used; FFmpeg is deferred until FluxFetch needs to combine or prepare a video. Their license notices are downloaded alongside them. This keeps these optional components out of the base installer; they do not replace this project's MIT license.

ZIP preview and selective extraction use `adm-zip` 0.6.1 (MIT). RAR preview and extraction use `node-unrar-js` 2.0.2 (MIT), which incorporates the UnRAR extraction code; FluxFetch uses it only to extract RAR files, never to create them. Split-volume RAR archives are not supported. The package license notices are included in `third-party-licenses` and the installed `legal/third-party-licenses` folder.

The optional remote dashboard uses `selfsigned` to create a local HTTPS certificate; its license notice is also included in `third-party-licenses`.

- yt-dlp 2026.08.19: https://github.com/yt-dlp/yt-dlp/tree/2026.08.19 — its Windows executable includes additional third-party components; see the upstream license notice and source repository.
- Deno 2.9.7: https://github.com/denoland/deno/tree/v2.9.7 — MIT license.
- FFmpeg N-127451-g263f271422, build 20261012: https://github.com/yt-dlp/FFmpeg-Builds — GPLv3 build with shared libraries. FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/263f271422 . Build scripts and dependency sources are referenced in the upstream build repository. Included LICENSE.txt contains the GPL text.
- The internet speed test sends direct timed requests to Cloudflare's public measurement endpoints. The interface is inspired by Silizium from https://github.com/TechnoHoschi/openspeedtest-openwrt (MIT; license text is included in `third-party-licenses/silizium-MIT.txt`). The upstream Silizium engine measures router-local LAN speed and is not used as a simulated internet test.

Original release URLs and archive digests are recorded in media-tools.lock.json. Keep component notices and applicable source requirements when redistributing these binaries. No component is silently self-updated by FluxFetch.
