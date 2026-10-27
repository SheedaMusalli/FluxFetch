# Connect your browser to FluxFetch

Install [FluxFetch for Windows](https://github.com/SheedaMusalli/FluxFetch/releases/latest) first. Setup registers the local Native Messaging helper. Chrome and Edge use unpacked extension packages; install Firefox from [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/fluxfetch-integration-module/).

## Choose a package

| Browser                 | Release asset                                                                                   | Extension page                                |
| ----------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Chrome                  | `FluxFetch-Chrome.zip`                                                                          | `chrome://extensions`                         |
| Edge                    | FluxFetch-Edge.zip                                                                              | edge://extensions                             |
| Brave                   | `FluxFetch-Chrome.zip`                                                                          | `brave://extensions`                          |
| Vivaldi                 | `FluxFetch-Chrome.zip`                                                                          | `vivaldi://extensions`                        |
| Opera / Opera GX        | `FluxFetch-Chrome.zip`                                                                          | `opera://extensions`                          |
| Other Chromium browsers | `FluxFetch-Chrome.zip`                                                                          | Browser menu → Extensions → Manage extensions |
| Firefox                 | [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/fluxfetch-integration-module/) | Add-ons listing                               |

Other Chromium browsers need unpacked Manifest V3 and Native Messaging support. Chrome/Edge and Mozilla host registrations are installed by setup; Chromium forks must support the relevant Windows host lookup. Compatibility with every fork has not been individually tested.

## Chromium browsers

1. Download FluxFetch-Edge.zip for Edge, or FluxFetch-Chrome.zip for Chrome and other Chromium browsers.
2. Right-click → **Extract All** into a permanent folder. Do not load from inside the ZIP or an extraction preview.
3. Open the appropriate page above, enable **Developer mode**, and click **Load unpacked**.
4. Select the folder directly containing `manifest.json`.
5. Enable and pin **FluxFetch Download Manager**, then open its popup and confirm **Connected**. Use **Open app** if needed.
6. Refresh existing webpages. Test a normal direct-file download or right-click a direct link → **Download with FluxFetch**.

Keep the folder in place. You can also load `<installation folder>\resources\extension`; a separate permanent folder is easier to manage across reinstalls. Do not remove/change the manifest `key`: the expected Chromium ID is `hhepjnimojcdbcifmjaflopikglidjbo`.

The CRX3 package is not a Chrome Web Store approval. Where Windows browsers restrict off-store CRX installation, use **Load unpacked**. Managed browsers may block Developer mode; the app does not override browser policy.

Official references: [Edge sideloading](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading), [Vivaldi extensions](https://help.vivaldi.com/desktop/appearance-customization/extensions/), [Brave compatibility](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave), [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

## Firefox

Install [FluxFetch from Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/fluxfetch-integration-module/). Open the extension popup and check for **Connected**, then refresh any open webpages. The FluxFetch Windows app must be installed so the extension can reach its local helper. Firefox updates the add-on through Mozilla.

The source bundle in the GitHub release is for reviewers and developers; users should install from Mozilla Add-ons. The installed add-on ID must stay `fluxfetch@fluxfetch.app` so it matches the native-host allowlist. The Edge ZIP omits Chrome's manifest `key` field, which Partner Center rejects.

## Using and updating the extension

- In FluxFetch Settings, choose your save folder. Confirm **Connected** in the browser popup.
- Enable **Automatic capture** or explicitly choose **Download with FluxFetch** on a direct link. The app asks before accepting captured downloads.
- Disable capture or exclude a site to keep its downloads in the browser.
- Automatic capture skips images and known downloads smaller than 128 KiB. Explicit actions and torrents are separate. Private sessions, unsupported requests and browser safety blocks may stay in the browser.
- Supported public YouTube pages have a dedicated format-selection workflow. The desktop downloader prefers tracks yt-dlp marks as original or that match the video's language. Tools download on first use; DRM, live broadcasts and some restricted videos remain unsupported.
- To update, run the desktop installer in **Update** mode. Replace the unpacked Chrome or Edge files, click **Reload** on the extension card, and refresh open webpages. Firefox updates through Mozilla Add-ons. Keep the extension IDs unchanged so each browser stays connected to the local helper.

## Troubleshooting

| Symptom                               | Resolution                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disconnected / native host not found  | Run desktop setup in Update mode for the Windows account using the browser. Fully reopen the browser and check the package/identity.                                                                                |
| Wrong folder                          | Choose the folder that directly contains `manifest.json` when loading an unpacked Chromium extension.                                                                                                               |
| Chromium fork loads but won't connect | Check compatible Windows Native Messaging host lookup. Setup registers Chrome/Edge locations; arbitrary forks may need browser-specific integration. Report browser/version instead of disabling security settings. |
| Firefox extension is missing          | Install or re-enable it from [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/fluxfetch-integration-module/). Check that Firefox has not disabled it.                                               |
| Old tab has no controls               | Refresh after loading/reloading the extension.                                                                                                                                                                      |
| Download stays in browser             | Check capture, exclusions, small/image filtering and ordinary HTTP/HTTPS GET support. Try an explicit direct link.                                                                                                  |
| 403, login challenge or expired URL   | Obtain a fresh link or use the browser; FluxFetch does not bypass site challenges.                                                                                                                                  |
