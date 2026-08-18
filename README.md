# Asset Information Lookup System

A small web app for looking up manufacturer device and warranty
information by serial number / service tag. Static frontend
(`index.html`, `css/`, `js/`) plus a Cloudflare Worker (`src/worker.js`)
that proxies the manufacturer API calls.

Supported today:

- **Dell** — via the [Dell TechDirect API](https://apidp.dell.com)'s
  Asset Entitlements endpoint.
- **Apple** — via the Apple School/Business Manager API's AppleCare
  coverage endpoint. Supports multiple separate Apple orgs (e.g. one per
  school in a trust) — a lookup searches every configured org and reports
  which one actually had the device.
- **Lenovo** — built (via Lenovo's eSupport WebAPI), but badged
  "Pending" and its lookup form disabled until `LENOVO_CLIENT_ID` is set
  — see step 3 below. Shows a link to Lenovo's manual lookup in the
  meantime.
- **HP** and **SMART Technologies** — not wired into this tool's own
  lookup (see "Adding a manufacturer" below for what that would take);
  their tab is badged "External" and opens the manufacturer's own
  official warranty checker in a new tab instead.

## Why a Cloudflare Worker instead of a purely static site

The Freshservice Asset Import tool this was modeled on is 100% static —
no backend, everything runs in the browser. These lookups can't work that
way: Dell's API requires a confidential OAuth `client_id`/`client_secret`
exchanged for a bearer token, and Apple's requires a private-key-signed
JWT client assertion — neither sends CORS headers, so a browser can't
call either directly without exposing a secret (or a private key) in
shipped JS. The Worker holds those credentials server-side (as Wrangler
secrets, never committed) and exposes one same-origin endpoint,
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

### 2. Get Apple School/Business Manager credentials

Each Apple School Manager (or Business Manager) organisation needs its
own **API account**, created inside that org's own portal:

1. Sign into [Apple School Manager](https://school.apple.com) (or
   [Business Manager](https://business.apple.com)).
2. Select your name (bottom-left) → **Preferences** → **API**.
3. **Get Started**, give the API account a name, **Create**.
4. **Generate Private Key** — downloads a `.pem` file. This only happens
   once; if you lose it, you have to create a new API account.
5. Select **Manage** to see the account's **Client ID** and **Key ID**.
6. If you manage more than one org (e.g. separate ASM tenants per
   school), repeat this for each one — this tool is built to search all
   of them per lookup, you don't have to pick one.

> **Note on API details:** the host (`api-school.apple.com` for
> `school.api`, `api-business.apple.com` for `business.api`), the OAuth
> token flow, and the `orgDevices` pagination approach in
> `src/worker.js` are confirmed against a working script, not just
> guesswork — including two non-obvious details: the JWT's `aud` claim
> is a *different* URL from the token endpoint actually POSTed to, and
> `orgDevices` has no reliable per-serial filter — a lookup has to page
> through the org's entire device list and match locally (cached for 30
> minutes per org, so this only costs a full fetch once per cache
> window, not once per lookup). All of it stays overridable via secrets
> (`APPLE_API_HOST`, `APPLE_SCOPE`, `APPLE_TOKEN_URL`,
> `APPLE_TOKEN_AUDIENCE`) in case a different org's portal ever points
> somewhere else.

### 3. Get Lenovo API credentials

Unlike Dell's TechDirect portal, there's no online self-service signup
for this one:

1. Contact your Lenovo Account Representative, or reach out through the
   [Lenovo Partner Program](https://www.lenovo.com/partners/), and ask
   for a `ClientID` for the eSupport WebAPI (warranty lookup).
2. There's no form to fill in beyond that — Lenovo issues the ClientID
   directly once your account/partner status is confirmed. This can take
   noticeably longer than Dell's or Apple's setup, since it depends on a
   person rather than a portal.
3. Until then, Lenovo's `status` in `js/app.js`'s `VENDORS` array is
   `'pending'` — the lookup form shows but stays disabled, with a link to
   Lenovo's own manual warranty lookup above it. Once `LENOVO_CLIENT_ID`
   is set (step 4 below) and confirmed working, flip that `status` to
   `'active'` — nothing else needs to change.

> **Note on API details:** the endpoint, header, and response shape
> (`InWarranty`/`Purchased`/`Shipped`/`Warranty[]`) in `src/worker.js`
> are confirmed consistent across Lenovo's own eSupport WebAPI wiki and
> several independent scripts using it. The one thing that's **not**
> independently confirmed is the exact field Lenovo uses for the
> product/model description — no source showed a full raw response
> including it, so `normalizeLenovoAsset` tries a few plausible field
> names (`Product`, `ProductName`, `Machine`, `MachineType`) and falls
> back to "Unknown model" if none match. Worth checking against a real
> response once `LENOVO_CLIENT_ID` is in place, and adjusting the
> fallback list in `src/worker.js` if the real field name differs. The
> host is overridable via `LENOVO_API_HOST` if needed.

### 4. Install Wrangler and set secrets

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

Apple's credentials go in as a single JSON secret, `APPLE_ORGS` — one
array entry per API account from step 2. The private key's newlines need
to become literal `\n` inside the JSON string (most editors/terminals
will mangle a multi-line paste otherwise):

```bash
wrangler secret put APPLE_ORGS
```
then paste something like:
```json
[
  {
    "name": "St Albans",
    "clientId": "BUSINESSAPI.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "keyId": "XXXXXXXXXX",
    "privateKey": "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg...\n-----END PRIVATE KEY-----"
  },
  {
    "name": "Marlow",
    "clientId": "BUSINESSAPI.yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
    "keyId": "YYYYYYYYYY",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
  }
]
```
To add, remove, or update an org later, re-run `wrangler secret put
APPLE_ORGS` with the full updated array — it replaces the whole secret.

Lenovo just needs the one ClientID from step 3:

```bash
wrangler secret put LENOVO_CLIENT_ID
```

For local development, create a `.dev.vars` file (already gitignored)
instead — `APPLE_ORGS` still needs to be one single-line JSON string:

```
DELL_CLIENT_ID=xxxxx
DELL_CLIENT_SECRET=xxxxx
APPLE_ORGS=[{"name":"St Albans","clientId":"...","keyId":"...","privateKey":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}]
LENOVO_CLIENT_ID=xxxxx
```

### 5. Run it locally

```bash
npx wrangler dev
```

### 6. Deploy

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

If it has an API you can get access to:

1. In `src/worker.js`, add a `lookup<Vendor>(tags, env)` function that
   calls that manufacturer's API and returns the same normalized shape
   `lookupDell` does: `{ tag, valid, model, shipDate, status,
   warrantyEndDate, warrantyMonths, daysRemaining, entitlements }` (or
   `{ tag, valid: false, error }` for a tag with no data — `monthsBetween`
   handles the `warrantyMonths` calculation for you). Wire it into
   `handleWarrantyRequest`'s vendor switch.
2. In `js/app.js`, set that vendor's `status` in the `VENDORS` array to
   `'active'`, with a `tagNoun` and `tagExample`.
3. Add any new required secrets to the README's setup steps above.

If the integration is *built* but you're still waiting on credentials
(Lenovo's current state — see above), use `status: 'pending'` with both
a `tagNoun`/`tagExample` (like `'active'`) and an `externalUrl` +
`pendingMessage` (like `'external'`). The lookup form still renders, but
disabled/greyed out (a native `<fieldset disabled>`, not just visual —
the button and textarea genuinely can't be interacted with), with the
`pendingMessage` and a link to `externalUrl` shown above it as a
stand-in. Once the secret is actually in place, just flip `status` to
`'active'` — nothing else changes, since the lookup logic was already
built and working, only gated behind the UI.

If it doesn't (no API, or access you can't realistically get — HP and
SMART Technologies are both like this today), set `status: 'external'`
and an `externalUrl` pointing at the manufacturer's own official warranty
lookup page instead — no `src/worker.js` changes needed. The tab links
straight there in a new tab rather than searching in this tool. A vendor
with neither an API nor a known official lookup page can use
`status: 'coming-soon'` as a placeholder.

## Deep linking from another tool

Another internal tool (e.g. an assets inventory system) can link straight
into a lookup instead of a user having to open this tool and type a serial
in by hand:

```
https://warranty-lookup.spaniel95.workers.dev/?vendor=dell&serial=7XJ4K52
```

- `vendor` — one of the `id`s in `js/app.js`'s `VENDORS` array (`apple`,
  `dell`, `hp`, `lenovo`, `smarttech`). Case-insensitive. If omitted or
  unrecognised, the page opens on whichever vendor tab is selected by
  default.
- `serial` (aliases: `serials`, `tag`, `tags`) — one serial/service tag, or
  several separated by commas/spaces (same format the lookup box itself
  accepts). Pre-fills the lookup box.
- If the resolved vendor currently has a live lookup (`status: 'active'`
  in `js/app.js`) and a serial was supplied, the lookup runs
  automatically — the destination page loads straight into results. For a
  vendor that isn't `'active'` yet (`'pending'`, `'external'`, or
  `'coming-soon'`), the serial is still pre-filled once that vendor's tab
  is open, but nothing runs automatically since there's no lookup to run.

Only Apple and Dell run automatically today; Lenovo will too the moment
its `status` flips to `'active'` (see "Get Lenovo API credentials"
above) — no deep-linking code changes needed for that.

## Data handling

Lookups are proxied through the Worker but nothing is logged, stored, or
persisted anywhere — no database, no KV, no analytics. Each request just
forwards to the manufacturer's API and returns the result.
