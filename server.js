#!/usr/bin/env node
/* Supermarket Mapper server: serves the static app and proxies the Kroger API
 * so the client secret never reaches the browser. No dependencies (Node 20+). */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const STATIC_FILES = new Set(['index.html', 'app.js', 'style.css', 'aisles.html', 'aisles.js', 'aisles.css']);
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 5000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp({ clientId, clientSecret, apiBase = 'https://api.kroger.com', root = __dirname } = {}) {
  let token = null; // { value, expiresAt }
  let tokenPromise = null;
  const cache = new Map(); // url -> { at, body }

  async function getToken() {
    if (!clientId || !clientSecret) {
      throw new HttpError(503, 'Kroger API keys are not configured. Set KROGER_CLIENT_ID and KROGER_CLIENT_SECRET (see README).');
    }
    if (token && Date.now() < token.expiresAt) return token.value;
    tokenPromise ??= (async () => {
      const res = await fetch(`${apiBase}/v1/connect/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials&scope=product.compact',
      });
      if (!res.ok) {
        throw new HttpError(502, res.status === 401 || res.status === 400
          ? 'Kroger rejected the API keys. Check KROGER_CLIENT_ID / KROGER_CLIENT_SECRET and that the app has the Products API enabled.'
          : `Kroger sign-in failed (HTTP ${res.status}).`);
      }
      const data = await res.json();
      token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) - 60) * 1000 };
      return token.value;
    })().finally(() => { tokenPromise = null; });
    return tokenPromise;
  }

  async function kroger(pathAndQuery) {
    const hit = cache.get(pathAndQuery);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;
    for (let attempt = 0; ; attempt++) {
      const bearer = await getToken();
      const res = await fetch(apiBase + pathAndQuery, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
      });
      if (res.status === 401 && attempt === 0) { token = null; continue; } // expired early: refresh once
      if (res.status === 429) throw new HttpError(429, 'Kroger rate limit reached. Wait a bit and try again.');
      if (!res.ok) throw new HttpError(502, `Kroger API error (HTTP ${res.status}).`);
      const body = await res.json();
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(pathAndQuery, { at: Date.now(), body });
      return body;
    }
  }

  const slimLocation = (l) => ({
    id: l.locationId,
    name: l.name,
    chain: l.chain,
    address: [l.address?.addressLine1, l.address?.city, l.address?.state, l.address?.zipCode].filter(Boolean).join(', '),
    lat: l.geolocation?.latitude ?? null,
    lon: l.geolocation?.longitude ?? null,
    phone: l.phone || '',
  });

  const slimProduct = (p) => {
    const item = p.items?.[0];
    return {
      id: p.productId,
      description: p.description || '',
      brand: p.brand || '',
      categories: p.categories || [],
      size: item?.size || '',
      price: item?.price?.promo || item?.price?.regular || null,
      aisles: (p.aisleLocations || []).map((a) => ({
        number: a.number ?? '',
        description: a.description ?? '',
        side: a.side ?? '',
        bay: a.bayNumber ?? '',
        shelf: a.shelfNumber ?? '',
      })),
    };
  };

  async function api(url) {
    const q = url.searchParams;
    if (url.pathname === '/api/kroger/status') {
      return { configured: Boolean(clientId && clientSecret) };
    }
    if (url.pathname === '/api/kroger/locations') {
      const zip = (q.get('zip') || '').trim();
      if (!/^\d{5}$/.test(zip)) throw new HttpError(400, 'Enter a 5-digit ZIP code.');
      const radius = Math.min(100, Math.max(1, parseInt(q.get('radius'), 10) || 10));
      const data = await kroger(`/v1/locations?filter.zipCode.near=${zip}&filter.radiusInMiles=${radius}&filter.limit=25`);
      return { stores: (data.data || []).map(slimLocation) };
    }
    if (url.pathname === '/api/kroger/products') {
      const locationId = q.get('locationId') || '';
      const term = (q.get('term') || '').trim();
      if (!/^[0-9A-Za-z]{8}$/.test(locationId)) throw new HttpError(400, 'Invalid store id.');
      if (term.length < 3 || term.length > 60) throw new HttpError(400, 'Search for at least 3 characters.');
      const data = await kroger(`/v1/products?filter.term=${encodeURIComponent(term)}&filter.locationId=${locationId}&filter.limit=50`);
      return { products: (data.data || []).map(slimProduct) };
    }
    throw new HttpError(404, 'Not found');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }

    if (url.pathname.startsWith('/api/')) {
      try {
        const body = await api(url);
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 502;
        const message = e instanceof HttpError ? e.message : `Couldn't reach Kroger: ${e.cause?.code || e.message}`;
        if (!(e instanceof HttpError)) console.error(e);
        res.writeHead(status, { 'Content-Type': MIME['.json'] }).end(JSON.stringify({ error: message }));
      }
      return;
    }

    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!STATIC_FILES.has(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    fs.readFile(path.join(root, name), (err, buf) => {
      if (err) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream' }).end(buf);
    });
  });
}

module.exports = { createApp };

if (require.main === module) {
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }
  const port = Number(process.env.PORT) || 8000;
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp({
    clientId: process.env.KROGER_CLIENT_ID,
    clientSecret: process.env.KROGER_CLIENT_SECRET,
    apiBase: process.env.KROGER_API_BASE || undefined,
  });
  app.listen(port, host, () => {
    console.log(`Supermarket Mapper running at http://${host}:${port}`);
    if (!process.env.KROGER_CLIENT_ID || !process.env.KROGER_CLIENT_SECRET) {
      console.log('Kroger aisle maps are disabled: KROGER_CLIENT_ID / KROGER_CLIENT_SECRET not set (see README).');
    }
  });
}
