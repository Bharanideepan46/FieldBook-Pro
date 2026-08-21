# FieldBook Pro (PWA)

Installable, offline agronomy field-data app. Auto-deploys to GitHub Pages on every push.

## One-time setup
1. Push all files (keep the `.github` folder).
2. **Settings -> Pages -> Source = GitHub Actions**.
Live at `https://<user>.github.io/<repo>/`.

## Features
- Installable PWA with **Add-to-Home-Screen banner** (Android/Chromium) and iOS hint.
- **Offline** app shell via service worker; weather/CDN calls stay network-only.
- **Auto-versioned cache**: each deploy stamps the commit SHA into the SW cache
  name, old caches are purged, and an **"Update available - Refresh"** toast appears.
- `404.html` redirects deep links back into the SPA.
- Verified by automated runtime tests (Agronomy fixes, bridge, banner, SW).

## Files
index.html, app.html, bridge-web.js, install-banner.js, service-worker.js,
manifest.webmanifest, offline.html, 404.html, icons/, .nojekyll,
.github/workflows/deploy.yml
