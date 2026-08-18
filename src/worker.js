// Backend for /api/warranty/*. Every other request falls through to the
// static assets (index.html/css/js) via env.ASSETS — see the default
// export below. This exists specifically because Dell's and Apple's APIs
// both need server-held OAuth credentials and don't allow browser CORS,
// so the lookup can't be done from js/app.js directly the way the rest of
// this app's UI logic can.
//
// Dell requires two Worker secrets, set via `wrangler secret put`:
//   DELL_CLIENT_ID
//   DELL_CLIENT_SECRET
// from a Dell TechDirect API (apidp.dell.com) registration.
//
// Apple requires one Worker secret, APPLE_ORGS — a JSON array, one entry
// per Apple School/Business Manager API account:
//   [{ "name": "...", "clientId": "...", "keyId": "...", "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----" }]
// A lookup tries every configured org in parallel and uses whichever one
// actually has the device — see README.md for how to generate these.

const MAX_TAGS_PER_REQUEST = 20;
// Dell service tags are typically 7 chars; Apple serials run up to 12
// (older format) or as few as 8 (current format) — one shared pattern
// covers both rather than branching per vendor.
const TAG_PATTERN = /^[A-Za-z0-9]{4,12}$/;

class WarrantyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Module-scope cache: reused across requests handled by the same isolate,
// reset on cold start/redeploy. Good enough here — worth avoiding a
// pointless token fetch per lookup, not worth a KV/Durable Object just to
// persist a ~1-hour-lived token across isolate restarts.
let cachedToken = null;

async function getDellToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }
  if (!env.DELL_CLIENT_ID || !env.DELL_CLIENT_SECRET) {
    throw new WarrantyError(500, 'Dell API credentials are not configured on the server.');
  }

  const tokenUrl = env.DELL_TOKEN_URL || 'https://apigtwb2c.us.dell.com/auth/oauth/v2/token';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.DELL_CLIENT_ID,
    client_secret: env.DELL_CLIENT_SECRET,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new WarrantyError(502, `Dell authentication failed (${res.status}).`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new WarrantyError(502, 'Dell authentication response was missing an access token.');
  }
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : 55 * 60 * 1000),
  };
  return cachedToken.value;
}

// Maps one raw Dell asset-entitlements record into the shape js/app.js
// renders. Dell's own status/date fields vary in casing/format across API
// versions, so this normalizes rather than passing the raw payload through.
function normalizeDellAsset(tag, raw) {
  const entitlements = Array.isArray(raw?.entitlements) ? raw.entitlements : [];
  if (!raw || raw.invalid || entitlements.length === 0) {
    return { tag, valid: false, error: 'No matching device found.' };
  }

  const mapped = entitlements.map((e) => ({
    serviceLevelDescription: e.serviceLevelDescription || e.serviceLevelCode || 'Unknown coverage',
    serviceLevelCode: e.serviceLevelCode || null,
    startDate: e.startDate ? e.startDate.slice(0, 10) : null,
    endDate: e.endDate ? e.endDate.slice(0, 10) : null,
  }));

  const endDates = mapped.map((e) => e.endDate).filter(Boolean).sort();
  const warrantyEndDate = endDates.length ? endDates[endDates.length - 1] : null;

  let status = 'unknown';
  let daysRemaining = null;
  if (warrantyEndDate) {
    const end = new Date(`${warrantyEndDate}T23:59:59Z`);
    daysRemaining = Math.ceil((end.getTime() - Date.now()) / 86_400_000);
    status = daysRemaining >= 0 ? 'active' : 'expired';
  }

  return {
    tag,
    valid: true,
    model: raw.productLineDescription || raw.productId || 'Unknown model',
    shipDate: raw.shipDate ? raw.shipDate.slice(0, 10) : null,
    country: raw.countryCode || null,
    status,
    warrantyEndDate,
    daysRemaining,
    entitlements: mapped,
  };
}

async function lookupDell(tags, env) {
  const token = await getDellToken(env);
  const warrantyUrl = env.DELL_WARRANTY_URL || 'https://apigtwb2c.us.dell.com/PROD/sbil/eapi/v5/asset-entitlements';
  const url = new URL(warrantyUrl);
  url.searchParams.set('servicetags', tags.join(','));

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 401) {
    cachedToken = null;
    throw new WarrantyError(502, 'Dell authentication expired mid-request — please try again.');
  }
  if (!res.ok) {
    throw new WarrantyError(502, `Dell warranty lookup failed (${res.status}).`);
  }

  const data = await res.json();
  const list = Array.isArray(data) ? data : [];
  const byTag = new Map(list.map((raw) => [String(raw.serviceTag || '').toUpperCase(), raw]));

  return tags.map((tag) => normalizeDellAsset(tag, byTag.get(tag.toUpperCase())));
}

// ---------------------------------------------------------------------
// Apple School/Business Manager — unlike Dell, an organisation can have
// several separate API accounts (e.g. one per school in a trust), and a
// given device only exists behind whichever one manages it. Every
// configured org is queried in parallel per serial number and whichever
// one actually has the device wins.
//
// Host/scope/token-audience below are confirmed against a working
// PowerShell script the org already uses successfully against
// api-school.apple.com — not just third-party guesswork. Two details
// that guesswork got wrong the first time round, now fixed:
//   1. The JWT's `aud` claim is a *different* URL
//      (.../auth/oauth2/v2/token) from the token endpoint actually
//      POSTed to (.../auth/oauth2/token, no v2) — they looked like they
//      should be the same URL, but aren't.
//   2. `orgDevices` doesn't support filtering by serial number via a
//      query param — the only reliable way to find a device is to page
//      through the *entire* org device list and match locally, so
//      that's what findAppleDeviceInOrg does (via a cached map, so this
//      full fetch only happens once per org per cache window, not once
//      per lookup).
// All of it stays overridable via secrets (APPLE_API_HOST / APPLE_SCOPE
// / APPLE_TOKEN_URL / APPLE_TOKEN_AUDIENCE) in case a different org's
// portal ever points somewhere else. See README.md.
// ---------------------------------------------------------------------

function getAppleHost(env) {
  if (env.APPLE_API_HOST) return env.APPLE_API_HOST;
  const scope = env.APPLE_SCOPE || 'school.api';
  return scope === 'business.api' ? 'https://api-business.apple.com' : 'https://api-school.apple.com';
}

// clientId -> { value, expiresAt }, same reasoning as Dell's cachedToken.
const appleTokenCache = new Map();

// clientId -> { map: Map<serial, {id, attributes}>, expiresAt } — built
// by paginating the org's full device list (see the note above on why
// there's no per-serial filter to call instead). Cached rather than
// re-fetched on every lookup since a trust's device list can run into
// the thousands and doesn't change minute to minute.
const appleDeviceMapCache = new Map();
const APPLE_DEVICE_MAP_TTL_MS = 30 * 60 * 1000;

function base64url(bytes) {
  let binary = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importApplePrivateKey(pem, orgName) {
  try {
    const b64 = pem
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\s+/g, '');
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  } catch {
    throw new WarrantyError(500, `Apple private key for "${orgName}" is malformed — expected a PKCS8 PEM (the .pem Apple's portal downloads once when the API account is created).`);
  }
}

// Builds and signs the JWT "client assertion" Apple's OAuth token endpoint
// requires in place of a plain client secret (Dell's approach) — see
// "Implementing OAuth for the Apple School and Business Manager API".
async function signAppleClientAssertion(org, env) {
  // Deliberately NOT the same URL as the token endpoint the assertion
  // gets POSTed to (see the file-level note above) — Apple's audience
  // claim points at the v2 URL regardless of which version of the token
  // endpoint you actually call.
  const audience = env.APPLE_TOKEN_AUDIENCE || 'https://account.apple.com/auth/oauth2/v2/token';
  const header = { alg: 'ES256', kid: org.keyId, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: org.clientId,
    iss: org.clientId,
    aud: audience,
    iat: now,
    exp: now + 300, // short-lived assertion — Apple allows up to 180 days, but there's no reason to sign one that lives longer than this single request
    jti: crypto.randomUUID(),
  };
  const encHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;

  const key = await importApplePrivateKey(org.privateKey, org.name);
  // WebCrypto's ECDSA signatures are already raw r||s (IEEE P1363), which
  // is exactly what a JWS ES256 signature needs — no DER conversion.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(signature)}`;
}

async function getAppleToken(org, env) {
  const cached = appleTokenCache.get(org.clientId);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.value;
  }

  const tokenUrl = env.APPLE_TOKEN_URL || 'https://account.apple.com/auth/oauth2/token';
  const scope = env.APPLE_SCOPE || 'school.api';
  const assertion = await signAppleClientAssertion(org, env);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: org.clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
    scope,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new WarrantyError(502, `Apple authentication failed for "${org.name}" (${res.status}).`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new WarrantyError(502, `Apple authentication response for "${org.name}" was missing an access token.`);
  }
  const value = data.access_token;
  appleTokenCache.set(org.clientId, {
    value,
    expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : 55 * 60 * 1000),
  });
  return value;
}

// Pages through this org's *entire* orgDevices list and returns a
// SerialNumber -> { id, attributes } map — see the file-level note on
// why there's no per-serial filter to call instead. The list response
// already carries each device's model/order-date attributes, so those
// are kept here rather than discarded, avoiding a third fetch per
// lookup just to re-fetch what page already had. Cached per org.
async function getAppleOrgDeviceMap(org, env) {
  const cached = appleDeviceMapCache.get(org.clientId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.map;
  }

  const token = await getAppleToken(org, env);
  const host = getAppleHost(env);
  const map = new Map();
  let url = `${host}/v1/orgDevices?limit=100`;

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      appleTokenCache.delete(org.clientId);
      throw new WarrantyError(502, `Apple authentication expired mid-request for "${org.name}" — please try again.`);
    }
    if (!res.ok) {
      throw new WarrantyError(502, `Apple device list fetch failed for "${org.name}" (${res.status}).`);
    }
    const page = await res.json();
    for (const device of page.data || []) {
      const serial = device.attributes?.serialNumber;
      if (serial) map.set(serial.toUpperCase(), { id: device.id, attributes: device.attributes || {} });
    }
    url = page.links?.next || null;
  }

  appleDeviceMapCache.set(org.clientId, { map, expiresAt: Date.now() + APPLE_DEVICE_MAP_TTL_MS });
  return map;
}

// Looks a serial up in one org: null means "not in this org" (not an
// error — the caller tries the rest); a thrown WarrantyError means this
// org's own request genuinely failed (bad creds, Apple outage, etc.).
async function findAppleDeviceInOrg(serial, org, env) {
  const token = await getAppleToken(org, env);
  const host = getAppleHost(env);

  const deviceMap = await getAppleOrgDeviceMap(org, env);
  const device = deviceMap.get(serial.toUpperCase());
  if (!device) return null;

  const coverageRes = await fetch(`${host}/v1/orgDevices/${device.id}/appleCareCoverage`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (coverageRes.status === 401) {
    appleTokenCache.delete(org.clientId);
    throw new WarrantyError(502, `Apple authentication expired mid-request for "${org.name}" — please try again.`);
  }
  if (!coverageRes.ok) {
    throw new WarrantyError(502, `Apple coverage lookup failed for "${org.name}" (${coverageRes.status}).`);
  }
  const coverageData = await coverageRes.json();
  const coverage = Array.isArray(coverageData?.data) ? coverageData.data : [];

  return { device, coverage, orgName: org.name };
}

// Queries every configured org for one serial in parallel. If every org
// fails outright, the failure is surfaced (so a misconfigured org doesn't
// silently masquerade as "not found") — but if at least one org answered
// successfully, a clean "not found" wins over another org's error.
async function findAppleDeviceAcrossOrgs(serial, orgs, env) {
  const attempts = await Promise.allSettled(orgs.map((org) => findAppleDeviceInOrg(serial, org, env)));
  for (const attempt of attempts) {
    if (attempt.status === 'fulfilled' && attempt.value) return attempt.value;
  }
  if (attempts.length && attempts.every((a) => a.status === 'rejected')) {
    throw attempts[0].reason;
  }
  return null;
}

function normalizeAppleAsset(tag, found) {
  if (!found) {
    return { tag, valid: false, error: 'No matching device found.' };
  }
  const { device, coverage, orgName } = found;
  const attrs = device.attributes || {};

  const mapped = coverage.map((c) => {
    const a = c.attributes || {};
    return {
      serviceLevelDescription: a.description || a.status || 'Unknown coverage',
      serviceLevelCode: a.status || null,
      startDate: a.startDateTime ? a.startDateTime.slice(0, 10) : null,
      endDate: a.endDateTime ? a.endDateTime.slice(0, 10) : null,
    };
  });

  const endDates = mapped.map((e) => e.endDate).filter(Boolean).sort();
  const warrantyEndDate = endDates.length ? endDates[endDates.length - 1] : null;

  let status = 'unknown';
  let daysRemaining = null;
  if (warrantyEndDate) {
    const end = new Date(`${warrantyEndDate}T23:59:59Z`);
    daysRemaining = Math.ceil((end.getTime() - Date.now()) / 86_400_000);
    status = daysRemaining >= 0 ? 'active' : 'expired';
  }

  return {
    tag,
    valid: true,
    model: attrs.deviceModel || attrs.productType || 'Unknown model',
    shipDate: attrs.orderDateTime ? attrs.orderDateTime.slice(0, 10) : null,
    country: null,
    status,
    warrantyEndDate,
    daysRemaining,
    entitlements: mapped,
    orgName,
  };
}

function getAppleOrgs(env) {
  if (!env.APPLE_ORGS) return [];
  try {
    const parsed = JSON.parse(env.APPLE_ORGS);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function lookupApple(tags, env) {
  const orgs = getAppleOrgs(env);
  if (orgs === null) {
    throw new WarrantyError(500, 'Apple credentials are misconfigured on the server (APPLE_ORGS is not valid JSON).');
  }
  if (orgs.length === 0) {
    throw new WarrantyError(500, 'Apple credentials are not configured on the server.');
  }

  // Tags run sequentially (each trying every org in parallel) rather than
  // all-tags-all-orgs at once, to keep the burst of concurrent subrequests
  // against Apple's API bounded regardless of how many tags were pasted in.
  const results = [];
  for (const tag of tags) {
    const found = await findAppleDeviceAcrossOrgs(tag, orgs, env);
    results.push(normalizeAppleAsset(tag, found));
  }
  return results;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function handleWarrantyRequest(request, env, vendor) {
  const url = new URL(request.url);
  const rawTags = (url.searchParams.get('tags') || '')
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const tags = [...new Set(rawTags.map((t) => t.toUpperCase()))];

  if (tags.length === 0) {
    return jsonResponse({ error: 'Provide at least one service tag via ?tags=' }, 400);
  }
  if (tags.length > MAX_TAGS_PER_REQUEST) {
    return jsonResponse({ error: `Provide at most ${MAX_TAGS_PER_REQUEST} service tags per lookup.` }, 400);
  }
  const badTags = tags.filter((t) => !TAG_PATTERN.test(t));
  if (badTags.length) {
    return jsonResponse({ error: `These don't look like valid service tags: ${badTags.join(', ')}` }, 400);
  }

  if (vendor !== 'dell' && vendor !== 'apple') {
    return jsonResponse({ error: `${vendor} lookups aren't available yet.` }, 400);
  }

  try {
    const results = vendor === 'dell' ? await lookupDell(tags, env) : await lookupApple(tags, env);
    return jsonResponse({ results });
  } catch (err) {
    if (err instanceof WarrantyError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    return jsonResponse({ error: 'Unexpected error contacting the lookup service.' }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/warranty/')) {
      const vendor = url.pathname.slice('/api/warranty/'.length).replace(/\/$/, '');
      return handleWarrantyRequest(request, env, vendor);
    }

    // Any other request reaches the Worker only when it didn't already
    // match a static file (Workers serves assets first by default — see
    // wrangler.jsonc). Defer back to the assets binding so a typo'd path
    // gets the normal static-site 404 instead of a bare JSON error.
    return env.ASSETS.fetch(request);
  },
};
