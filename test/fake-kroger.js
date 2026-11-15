'use strict';
/* Test double for api.kroger.com: just enough of the OAuth, Locations and Products
 * endpoints to exercise server.js. Used only by the test suite. */
const http = require('node:http');

const CATALOG = {
  milk: [['Kroger 2% Milk', 'Dairy', '0', 'DAIRY', 'L', '3'], ['Silk Almond Milk', 'Dairy', '0', 'DAIRY', 'L', '4']],
  pasta: [['Barilla Spaghetti', 'Pantry', '7', 'AISLE 7', 'R', '2'], ['Kroger Penne', 'Pantry', '7', 'AISLE 7', 'R', '5']],
  cereal: [['Cheerios', 'Breakfast', '12', 'AISLE 12', 'L', '1'], ['Mystery Flakes', 'Breakfast', null]],
};

function fakeKroger({ clientId = 'id', clientSecret = 'secret' } = {}) {
  const calls = { token: 0, products: 0, locations: 0 };
  let expireNextCall = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/v1/connect/oauth2/token') {
      calls.token++;
      const expected = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      if (req.headers.authorization !== expected) return json(401, { error: 'invalid_client' });
      return json(200, { access_token: `tok${calls.token}`, expires_in: 1800, token_type: 'bearer' });
    }
    if (!/^Bearer tok\d+$/.test(req.headers.authorization || '')) return json(401, { error: 'unauthorized' });
    if (expireNextCall) { expireNextCall = false; return json(401, { error: 'expired' }); }
    if (url.pathname === '/v1/locations') {
      calls.locations++;
      return json(200, { data: [{
        locationId: '01400943', chain: 'KROGER', name: 'Kroger - Test Plaza', phone: '5135550100',
        address: { addressLine1: '100 Main St', city: 'Cincinnati', state: 'OH', zipCode: url.searchParams.get('filter.zipCode.near') },
        geolocation: { latitude: 39.1, longitude: -84.5 },
      }] });
    }
    if (url.pathname === '/v1/products') {
      calls.products++;
      const rows = CATALOG[url.searchParams.get('filter.term')] || [];
      return json(200, { data: rows.map(([description, category, number, aisle, side, bay], i) => ({
        productId: `${url.searchParams.get('filter.term')}-${i}`, description, brand: description.split(' ')[0],
        categories: [category], items: [{ size: '16 oz', price: { regular: 3.49, promo: 0 } }],
        aisleLocations: number == null ? [] : [{ number, description: aisle, side, bayNumber: bay, shelfNumber: '2' }],
      })) });
    }
    json(404, {});
  });
  return { server, calls, expireToken: () => { expireNextCall = true; } };
}

module.exports = { fakeKroger };
