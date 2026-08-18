// Backend for /api/warranty/*. Every other request falls through to the
// static assets (index.html/css/js) via env.ASSETS — see the default
// export below. This exists specifically because Dell's warranty API
// needs a server-held OAuth client secret and doesn't allow browser CORS,
// so the lookup can't be done from js/app.js directly the way the rest of
// this app's UI logic can.
//
// Requires two Worker secrets, set via `wrangler secret put`:
//   DELL_CLIENT_ID
//   DELL_CLIENT_SECRET
// from a Dell TechDirect API (apidp.dell.com) registration. See README.md.

const MAX_TAGS_PER_REQUEST = 20;
const TAG_PATTERN = /^[A-Za-z0-9]{4,10}$/;

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
    return { tag, valid: false, error: 'No warranty information found for this service tag.' };
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

  if (vendor !== 'dell') {
    return jsonResponse({ error: `${vendor} lookups aren't available yet.` }, 400);
  }

  try {
    const results = await lookupDell(tags, env);
    return jsonResponse({ results });
  } catch (err) {
    if (err instanceof WarrantyError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    return jsonResponse({ error: 'Unexpected error contacting the warranty service.' }, 500);
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
