# Asset Information Lookup System

A small web app for looking up manufacturer warranty status by serial
number / service tag. Static frontend (`index.html`, `css/`, `js/`) plus a
Cloudflare Worker (`src/worker.js`) that proxies the manufacturer API calls.

Supported today:

- **Dell** — via the [Dell TechDirect API](https://apidp.dell.com)'s
  Asset Entitlements endpoint.
- **Lenovo** — Coming soon.
- **Apple** — Coming soon (Apple doesn't currently offer a public
  self-service warranty-check API, so this one may end up manual/limited
  even once added).

## Why a Cloudflare Worker instead of a purely static site

The Freshservice Asset Import tool this was modeled on is 100% static —
no backend, everything runs in the browser. Warranty lookups can't work
that way: Dell's API requires a confidential OAuth `client_id`/
`client_secret` exchanged for a bearer token, and it doesn't send
CORS headers, so a browser can't call it directly without exposing the
secret in shipped JS. The Worker holds that secret server-side (as a
Wrangler secret, never committed) and exposes one same-origin endpoint,
`/api/warranty/<vendor>?tags=...`, that the frontend calls instead.

It also still serves the static assets (Workers' `assets` feature), so
this deploys as a single Worker — no separate Pages project.

## Setup

### 1. Get Dell API credentials

1. Register for a free account at [Dell TechDirect API](https://apidp.dell.com).
2. Create an app/project and subscribe to the **Warranty API** (Asset
   Entitlements). Dell issues a `Client ID` and `Client Secret`.
3. Dell's exact endpoint paths have shifted across API versions in the
   past — `src/worker.js` defaults to the v5 production endpoints
   (`apigtwb2c.us.dell.com`) documented at the time this was written, but
   double-check the base URLs shown in your own TechDirect API dashboard.
   If they differ, no code change is needed — set the `DELL_TOKEN_URL`
   and/or `DELL_WARRANTY_URL` variables instead (see below).

### 2. Install Wrangler and set secrets

```bash
npm install -g wrangler   # or use npx wrangler for everything below
wrangler login

wrangler secret put DELL_CLIENT_ID
wrangler secret put DELL_CLIENT_SECRET
```

Only set `DELL_TOKEN_URL` / `DELL_WARRANTY_URL` if Dell's real endpoints
differ from the defaults baked into `src/worker.js`:

```bash
wrangler secret put DELL_TOKEN_URL
wrangler secret put DELL_WARRANTY_URL
```

For local development, create a `.dev.vars` file (already gitignored)
instead:

```
DELL_CLIENT_ID=xxxxx
DELL_CLIENT_SECRET=xxxxx
```

### 3. Run it locally

```bash
npx wrangler dev
```

### 4. Deploy

Manually:

```bash
npx wrangler deploy
```

Or automatically on every push to `main` via
`.github/workflows/deploy.yml` — add these two repository secrets under
**Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — an API token with Workers Scripts edit
  permission for your account.
- `CLOUDFLARE_ACCOUNT_ID` — found on the right-hand sidebar of any page
  in the Cloudflare dashboard.

## Project structure

```
index.html            Page layout, Settings/Release Notes/Help dialogs
css/styles.css        Styling (light/dark aware via prefers-color-scheme,
                      plus a manual override in Settings). Colors are CSS
                      custom properties at the top of the file.
js/app.js             UI wiring — manufacturer tabs, lookup form, results,
                      dialogs, PWA install prompt
src/worker.js         Cloudflare Worker: /api/warranty/<vendor> endpoint,
                      Dell OAuth + Asset Entitlements calls, static asset
                      fallback for everything else
wrangler.jsonc        Worker + static assets configuration
manifest.webmanifest  PWA manifest (name, icons, theme colors)
service-worker.js     Minimal service worker, exists only to satisfy the
                      browser's PWA installability check
assets/x-mark.png     Source X logo
assets/icons/         Favicon/app icons generated from assets/x-mark.png
                      composited into the shield mark
```

## Installing as an app

This is an installable PWA. On Chrome/Edge (desktop or Android), an
**Install App** button appears in the Settings pop-out (gear icon, top
right) once the browser decides the site qualifies — it adds a
standalone, taskbar/home-screen-pinnable copy with its own icon. Safari
(iOS/macOS) has no equivalent programmatic prompt, so the button never
appears there, but **Add to Home Screen** from the Share sheet still
works and uses the same icon/name.

### Regenerating the icons

`assets/icons/*.png` are all generated from `assets/x-mark.png`
composited onto a navy shield mark — there's no build step wired up for
this, so if the source X logo changes, regenerate them by hand (a plain
square/rounded-square background with the shield outline and X centered
inside, exported at 32/48/180/192/512px, plus 192/512 "maskable"
variants with extra padding so OS icon masking doesn't clip the shield).

## Adding a manufacturer

1. In `src/worker.js`, add a `lookup<Vendor>(tags, env)` function that
   calls that manufacturer's API and returns the same normalized shape
   `lookupDell` does: `{ tag, valid, model, shipDate, status,
   warrantyEndDate, daysRemaining, entitlements }` (or `{ tag, valid:
   false, error }` for a tag with no data). Wire it into
   `handleWarrantyRequest`'s vendor switch.
2. In `js/app.js`, flip that vendor's `status` in the `VENDORS` array from
   `'coming-soon'` to `'active'`.
3. Add any new required secrets to the README's setup steps above.

## Data handling

Lookups are proxied through the Worker but nothing is logged, stored, or
persisted anywhere — no database, no KV, no analytics. Each request just
forwards to the manufacturer's API and returns the result.
