# Supermarket Mapper

Two tools:

- **Store map** (`index.html`) — map specific grocery stores, e.g. every Trader Joe's, Aldi and Whole Foods within 10 km of a city.
- **Kroger aisle maps** (`aisles.html`) — an aisle-by-aisle directory of a single Kroger-family store (Kroger, Ralphs, Fred Meyer, King Soopers, Harris Teeter, …), with a "where is X?" search.

## Store map

Open `index.html` in a browser (or serve the folder: `python3 -m http.server` → http://localhost:8000). No build step or API key.

1. **Stores to map** — comma-separated chain/store names (`Trader Joe's, Aldi, Whole Foods`), or `*` for every grocery store.
2. **Area** — a city, neighborhood or ZIP code (or click **Near me**). Leave blank to search around the current map view.
3. **Radius** — 1–50 km.

Each chain gets its own color. Click a legend chip to show/hide a chain, click a list item to zoom to it, and the popup links to directions. Results can be downloaded as CSV or GeoJSON, and **Copy link** gives a shareable URL that reruns the search, e.g.

```
index.html?stores=Aldi,Lidl&area=Chicago&r=15
```

### How it works

- Location lookup: OpenStreetMap **Nominatim**.
- Store data: OpenStreetMap via the **Overpass API** — `shop=supermarket|grocery|wholesale` (plus convenience/specialty shops when the checkbox is on) whose `name`, `brand` or `operator` matches each term. Matching ignores case, apostrophes and punctuation, so `trader joes` finds "Trader Joe's".
- Map: Leaflet with OpenStreetMap tiles.

Coverage depends on OpenStreetMap; a store missing there won't appear here.

## Kroger aisle maps

Needs Node 20.12+ and free Kroger API keys; there are no npm dependencies.

1. Create an app at <https://developer.kroger.com> with the **Products** API (Production environment) and note its client ID and secret.
2. `cp .env.example .env` and fill in `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET`.
3. `npm start`, then open <http://localhost:8000/aisles.html>.

Enter a ZIP code and pick a store. The app runs about 80 common grocery searches (milk, pasta, diapers, …) against that store and groups the results by the aisle Kroger reports for each product, giving a tile per aisle with what it holds. Click a tile for the items with side, bay, shelf and price. The search box finds any other product and highlights its aisle.

### Limits

- Kroger has no "list the aisles" endpoint, so the directory is built from sampled products. An aisle with nothing in the sample won't appear until a search lands a product there.
- It is a directory in aisle-number order, not a floor plan: the API gives aisle, side, bay and shelf, but no positions within the building.
- Some products have no aisle listed for a given store.
- Mapping a store uses about 80 API calls; results are cached in memory for 6 hours. Kroger's free tier allows 10,000 product calls a day.

### How it works

`server.js` serves the pages and proxies three endpoints (`/api/kroger/status`, `/locations`, `/products`) to `api.kroger.com` using the OAuth client-credentials flow, so the secret stays on the server. It listens on `127.0.0.1` only; set `HOST`/`PORT` to change that.

### GitHub Pages

GitHub Pages serves static files only. The store map works there as is. The aisle mapper needs `server.js` running on a Node host (Render, Fly.io, Railway, a VPS, …):

1. Deploy this repo there with start command `npm start` and environment variables `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `HOST=0.0.0.0` and `ALLOWED_ORIGIN=https://<user>.github.io`.
2. Set `window.AISLES_API_BASE` in `config.js` to that server's URL and push.

`npm test` runs the server tests against a local stand-in for the Kroger API (`test/fake-kroger.js`).
