# Contributing to FluxFetch

Keep changes focused and run the checks that cover them.

## Development setup

FluxFetch is a Windows desktop app. Use Windows 10/11 x64 with Node.js 22.12+, npm, .NET SDK, Windows PowerShell, and (for OmniLink) the Rust MSVC toolchain.

```powershell
git clone https://github.com/SheedaMusalli/FluxFetch-Download-Manager.git
cd FluxFetch
npm ci
npm run dev
```

## Checks

```powershell
npm run lint
npm run typecheck
npm run format:check
npm run test:e2e:smoke
```

Run the full browser and download suite with `npm run test:e2e`. For UI changes, include any manual steps you used and a screenshot when it helps reviewers.

## Pull requests

For networking changes, note assumptions about HTTP ranges, adapter routing, retries, and integrity checks. Do not log URLs, auth headers, cookies, or credentials.

## Releases

Update the package version without creating a tag, then build the x64 Windows installer and browser extension:

```powershell
npm version <version> --no-git-tag-version
npm run build:win
```

Review `docs/releases/v1.0.0.md` when preparing release notes. Publish the installer, browser extension ZIP/CRX, update metadata, and SHA256 checksums together. Keep third-party notices and applicable licenses with every release.
