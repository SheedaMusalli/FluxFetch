# FluxFetch for Microsoft Edge — Privacy Policy

FluxFetch for Microsoft Edge connects browser downloads and direct media links to the FluxFetch Windows desktop app.

## Information the extension accesses

To identify and hand off downloads, the extension may process HTTP or HTTPS request URLs, referring-page URLs, filenames, media links, and selected request headers. Selected headers can include cookies, authorization, referer, origin, user-agent, and accept headers when needed to retrieve a download.

When a user chooses the YouTube sign-in-cookie retry option, the extension accesses YouTube cookies and the browser’s user-agent for that download.

## How information is used and shared

The extension sends the download URL and, when needed, its filename, referring page, selected request headers, cookies, and user-agent to the FluxFetch Windows app through Edge Native Messaging on the same device. The desktop app uses those details to request the download from its original website. YouTube cookies are used only for the YouTube download retry selected by the user.

FluxFetch does not send this information to a FluxFetch analytics or advertising server, sell it, or use it for unrelated purposes. The website hosting the requested download receives the request made to retrieve that download.

## Local storage and retention

Extension settings, such as automatic capture, media buttons, and excluded domains, are stored locally by Edge. Recent request metadata and discovered media URLs are held temporarily in browser session storage to match a download with its source. The extension limits and removes this temporary data as it expires or when its browser tab closes. Temporary YouTube cookie data used by the desktop app is deleted when the request ends.

## User controls

Users can turn off automatic download capture or media buttons, exclude domains, or remove the extension. A user can also decline the YouTube cookie retry; that option is not required for ordinary download handoff.

## Contact

For privacy questions, contact the FluxFetch publisher through the support contact listed on the Microsoft Edge Add-ons listing.
