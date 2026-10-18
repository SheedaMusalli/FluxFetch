# Contributing to FluxFetch

Thanks for helping improve FluxFetch. Keep changes focused and include the checks that matter for your change.

## Development setup

FluxFetch is a Windows desktop app. Use Windows 10/11 x64 with Node.js 22.12+, npm, .NET SDK, Windows PowerShell, and (for OmniLink) the Rust MSVC toolchain.

```powershell
git clone https://github.com/SheedaMusalli/FluxFetch.git
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

Run the full browser and download suite with `npm run test:e2e`. Include manual verification steps and a screenshot for UI changes when useful.

## Pull requests

Keep each pull request focused. For networking changes, explain any assumptions about HTTP range support, adapter routing, retries, and integrity checks. Avoid logging URLs, authentication headers, cookies, or credentials.

## Releases

Update the package version without creating a tag, then build the x64 Windows installer and browser extension:

```powershell
npm version <version> --no-git-tag-version
npm run build:win
```

Review `docs/releases/v1.0.0.md` when preparing release notes. Publish the installer, browser extension ZIP/CRX, update metadata, and SHA256 checksums together. Keep third-party notices and applicable licenses with every release.
