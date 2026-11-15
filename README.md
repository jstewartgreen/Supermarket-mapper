# Supermarket Mapper

Map specific grocery stores — e.g. every Trader Joe's, Aldi and Whole Foods within 10 km of a city — on an interactive map.

## Use it

Open `index.html` in a browser (or serve the folder: `python3 -m http.server` → http://localhost:8000). No build step or API key.

1. **Stores to map** — comma-separated chain/store names (`Trader Joe's, Aldi, Whole Foods`), or `*` for every grocery store.
2. **Area** — a city, neighborhood or ZIP code (or click **Near me**). Leave blank to search around the current map view.
3. **Radius** — 1–50 km.

Each chain gets its own color. Click a legend chip to show/hide a chain, click a list item to zoom to it, and the popup links to directions. Results can be downloaded as CSV or GeoJSON, and **Copy link** gives a shareable URL that reruns the search, e.g.

```
index.html?stores=Aldi,Lidl&area=Chicago&r=15
```

## How it works

- Location lookup: OpenStreetMap **Nominatim**.
- Store data: OpenStreetMap via the **Overpass API** — `shop=supermarket|grocery|wholesale` (plus convenience/specialty shops when the checkbox is on) whose `name`, `brand` or `operator` matches each term. Matching ignores case, apostrophes and punctuation, so `trader joes` finds "Trader Joe's".
- Map: Leaflet with OpenStreetMap tiles.

Coverage depends on OpenStreetMap; a store missing there won't appear here.
