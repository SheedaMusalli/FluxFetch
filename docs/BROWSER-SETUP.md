# Connect your browser to FluxFetch

Install [FluxFetch for Windows](https://github.com/SheedaMusalli/FluxFetch/releases/latest) first. Setup registers the local Native Messaging helper; loading a ZIP alone cannot connect to the app. This release provides unpacked Chromium and temporary Firefox packages, not browser-store listings.

## Choose a package

| Browser                 | Release asset           | Extension page                                |
| ----------------------- | ----------------------- | --------------------------------------------- |
| Chrome                  | `FluxFetch-Chrome.zip`  | `chrome://extensions`                         |
| Edge                    | `FluxFetch-Chrome.zip`  | `edge://extensions`                           |
| Brave                   | `FluxFetch-Chrome.zip`  | `brave://extensions`                          |
| Vivaldi                 | `FluxFetch-Chrome.zip`  | `vivaldi://extensions`                        |
| Opera / Opera GX        | `FluxFetch-Chrome.zip`  | `opera://extensions`                          |
| Other Chromium browsers | `FluxFetch-Chrome.zip`  | Browser menu → Extensions → Manage extensions |
| Firefox                 | `FluxFetch-Firefox.zip` | `about:debugging#/runtime/this-firefox`       |

Other Chromium browsers need unpacked Manifest V3 and Native Messaging support. Chrome/Edge and Mozilla host registrations are installed by setup; Chromium forks must support the relevant Windows host lookup. Compatibility with every fork has not been individually tested.

## Chromium browsers

1. Download **FluxFetch-Chrome.zip** from the same release as the desktop app.
2. Right-click → **Extract All** into a permanent folder. Do not load from inside the ZIP or an extraction preview.
3. Open the appropriate page above, enable **Developer mode**, and click **Load unpacked**.
4. Select the folder directly containing `manifest.json`.
5. Enable and pin **FluxFetch Download Manager**, then open its popup and confirm **Connected**. Use **Open app** if needed.
6. Refresh existing webpages. Test a normal direct-file download or right-click a direct link → **Download with FluxFetch**.

Keep the folder in place. You can also load `<installation folder>\resources\extension`; a separate permanent folder is easier to manage across reinstalls. Do not remove/change the manifest `key`: the expected Chromium ID is `hhepjnimojcdbcifmjaflopikglidjbo`.

The CRX3 package is not a Chrome Web Store approval. Where Windows browsers restrict off-store CRX installation, use **Load unpacked**. Managed browsers may block Developer mode; the app does not override browser policy.

Official references: [Edge sideloading](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading), [Vivaldi extensions](https://help.vivaldi.com/desktop/appearance-customization/extensions/), [Brave compatibility](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave), [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

## Firefox

1. Download and extract **FluxFetch-Firefox.zip**, rather than the Chromium ZIP.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**, then select `manifest.json` from the extracted Firefox folder.
4. Open the popup and confirm **Connected**. Refresh existing webpages.
5. Repeat loading after Firefox restarts.

The bundled copy lives at `<installation folder>\resources\extension-firefox`. Keep its ID `fluxfetch@fluxfetch.app` unchanged so it matches the Mozilla native-host allowlist.

This ZIP is **unsigned**. Standard Firefox does not persistently install it through **Install Add-on From File**; renaming it to `.xpi` does not change that. Persistent distribution requires Mozilla signing. **No signed Firefox XPI is included in v2.0.0.** See [Mozilla's temporary-installation instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

## Using and updating the extension

- In FluxFetch Settings, choose your save folder. Confirm **Connected** in the browser popup.
- Enable **Automatic capture** or explicitly choose **Download with FluxFetch** on a direct link. The app asks before accepting captured downloads.
- Disable capture or exclude a site to keep its downloads in the browser.
- Automatic capture skips images and known downloads smaller than 128 KiB. Explicit actions and torrents are separate. Private sessions, unsupported requests and browser safety blocks may stay in the browser.
- Supported public YouTube pages have a dedicated format-selection workflow. Tools download on first use; DRM, live broadcasts and some restricted videos remain unsupported.
- To update, install the desktop release in **Update** mode, replace extracted extension files with the matching package, then **Reload** its browser card and refresh webpages. Reload Firefox's temporary add-on as needed. Preserve extension identities.

## Troubleshooting

| Symptom                               | Resolution                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disconnected / native host not found  | Run desktop setup in Update mode for the Windows account using the browser. Fully reopen the browser and check the package/identity.                                                                                |
| Wrong folder                          | Chromium's loader takes the folder directly containing `manifest.json`; Firefox's temporary loader takes the file.                                                                                                  |
| Chromium fork loads but won't connect | Check compatible Windows Native Messaging host lookup. Setup registers Chrome/Edge locations; arbitrary forks may need browser-specific integration. Report browser/version instead of disabling security settings. |
| Firefox extension disappeared         | Temporary add-ons are removed at restart. Load it again; this release has no signed persistent XPI.                                                                                                                 |
| Old tab has no controls               | Refresh after loading/reloading the extension.                                                                                                                                                                      |
| Download stays in browser             | Check capture, exclusions, small/image filtering and ordinary HTTP/HTTPS GET support. Try an explicit direct link.                                                                                                  |
| 403, login challenge or expired URL   | Obtain a fresh link or use the browser; FluxFetch does not bypass site challenges.                                                                                                                                  |
