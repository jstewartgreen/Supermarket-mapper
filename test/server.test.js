'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server.js');
const { fakeKroger } = require('./fake-kroger.js');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function setup(creds = { clientId: 'id', clientSecret: 'secret' }) {
  const fake = fakeKroger();
  const apiBase = await listen(fake.server);
  const app = createApp({ ...creds, apiBase });
  const base = await listen(app);
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { fake, get, base, close: () => { app.close(); fake.server.close(); } };
}

test('locations: looks up stores by ZIP and trims the response', async () => {
  const t = await setup();
  const { status, body } = await t.get('/api/kroger/locations?zip=45202');
  assert.equal(status, 200);
  assert.deepEqual(body.stores[0], {
    id: '01400943', name: 'Kroger - Test Plaza', chain: 'KROGER',
    address: '100 Main St, Cincinnati, OH, 45202', lat: 39.1, lon: -84.5, phone: '5135550100',
  });
  t.close();
});

test('products: returns aisle locations, reuses the token and caches repeats', async () => {
  const t = await setup();
  const first = await t.get('/api/kroger/products?locationId=01400943&term=pasta');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.products[0].aisles, [{ number: '7', description: 'AISLE 7', side: 'R', bay: '2', shelf: '2' }]);
  assert.equal(first.body.products[0].price, 3.49);
  await t.get('/api/kroger/products?locationId=01400943&term=pasta');
  await t.get('/api/kroger/products?locationId=01400943&term=cereal');
  assert.equal(t.fake.calls.token, 1);
  assert.equal(t.fake.calls.products, 2);
  t.close();
});

test('products: a product with no aisle comes back with an empty list', async () => {
  const t = await setup();
  const { body } = await t.get('/api/kroger/products?locationId=01400943&term=cereal');
  assert.deepEqual(body.products[1].aisles, []);
  t.close();
});

test('refreshes the token once when Kroger says it expired', async () => {
  const t = await setup();
  await t.get('/api/kroger/products?locationId=01400943&term=milk');
  t.fake.expireToken();
  const { status } = await t.get('/api/kroger/products?locationId=01400943&term=pasta');
  assert.equal(status, 200);
  assert.equal(t.fake.calls.token, 2);
  t.close();
});

test('rejects bad input without calling Kroger', async () => {
  const t = await setup();
  assert.equal((await t.get('/api/kroger/locations?zip=abc')).status, 400);
  assert.equal((await t.get('/api/kroger/products?locationId=../../x&term=milk')).status, 400);
  assert.equal((await t.get('/api/kroger/products?locationId=01400943&term=a')).status, 400);
  assert.equal(t.fake.calls.token, 0);
  t.close();
});

test('missing or wrong keys give a clear error', async () => {
  const none = await setup({});
  assert.deepEqual((await none.get('/api/kroger/status')).body, { configured: false });
  assert.equal((await none.get('/api/kroger/locations?zip=45202')).status, 503);
  none.close();
  const bad = await setup({ clientId: 'id', clientSecret: 'wrong' });
  const r = await bad.get('/api/kroger/locations?zip=45202');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /rejected the API keys/);
  bad.close();
});

test('static files: serves the app, nothing else', async () => {
  const t = await setup();
  assert.equal((await fetch(t.base + '/aisles.html')).status, 200);
  assert.equal((await fetch(t.base + '/')).status, 200);
  assert.equal((await fetch(t.base + '/.env')).status, 404);
  assert.equal((await fetch(t.base + '/server.js')).status, 404);
  assert.equal((await fetch(t.base + '/..%2f..%2fetc/passwd')).status, 404);
  t.close();
});

test('CORS header is sent only when an allowed origin is configured', async () => {
  const off = await setup();
  assert.equal((await fetch(off.base + '/api/kroger/status')).headers.get('access-control-allow-origin'), null);
  off.close();
  const on = await setup({ clientId: 'id', clientSecret: 'secret', allowedOrigin: 'https://example.github.io' });
  assert.equal((await fetch(on.base + '/api/kroger/status')).headers.get('access-control-allow-origin'), 'https://example.github.io');
  on.close();
});
