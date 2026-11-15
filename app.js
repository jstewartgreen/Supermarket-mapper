/* Supermarket Mapper — find and map specific grocery stores using OpenStreetMap data. */
(() => {
  'use strict';

  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const GROCERY_SHOPS = ['supermarket', 'grocery', 'wholesale'];
  const SMALL_SHOPS = ['convenience', 'greengrocer', 'health_food', 'butcher', 'bakery', 'deli', 'farm', 'organic'];
  const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b',
                   '#e377c2', '#17becf', '#bcbd22', '#393b79', '#637939', '#7f7f7f'];
  const ALL = '*';

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('search'), stores: $('stores'), area: $('area'), radius: $('radius'),
    small: $('includeSmall'), go: $('go'), locate: $('locate'), status: $('status'),
    legend: $('legend'), results: $('results'), exports: $('exports'),
  };

  const map = L.map('map', { zoomControl: true }).setView([39.5, -98.35], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  let markersLayer = L.layerGroup().addTo(map);
  let searchCircle = null;
  let groups = [];      // [{ key, label, color, stores: [], visible }]
  let lastCenter = null;

  // ---------- helpers ----------
  const normalize = (s) => (s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  const tokens = (s) => normalize(s).split(' ').filter(Boolean);

  // "Trader Joe's" -> "trader.{0,3}joe.{0,3}s" (tolerates apostrophes, hyphens, spacing)
  const termRegex = (term) => tokens(term).join('.{0,3}');

  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const setStatus = (msg, isError = false) => {
    els.status.textContent = msg;
    els.status.classList.toggle('error', isError);
  };

  const parseTerms = (raw) => {
    const terms = raw.split(',').map((t) => t.trim()).filter(Boolean);
    if (terms.includes(ALL)) return [ALL];
    // de-duplicate by normalized form
    const seen = new Set();
    return terms.filter((t) => {
      const n = normalize(t);
      if (!n || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  };

  const distanceKm = (a, b) => {
    const R = 6371, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const formatAddress = (t) => {
    const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
    const city = [t['addr:city'], t['addr:state'], t['addr:postcode']].filter(Boolean).join(', ');
    return [street, city].filter(Boolean).join(', ') || t['addr:full'] || '';
  };

  // ---------- data ----------
  async function geocode(query) {
    const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Location lookup failed (${res.status})`);
    const data = await res.json();
    if (!data.length) throw new Error(`Couldn't find "${query}". Try a city name or ZIP code.`);
    return { lat: +data[0].lat, lon: +data[0].lon, label: data[0].display_name };
  }

  function buildQuery(terms, center, radiusM, includeSmall) {
    const shops = includeSmall ? GROCERY_SHOPS.concat(SMALL_SHOPS) : GROCERY_SHOPS;
    const shopFilter = `["shop"~"^(${shops.join('|')})$"]`;
    const around = `(around:${Math.round(radiusM)},${center.lat},${center.lon})`;
    let body;
    if (terms[0] === ALL) {
      body = `nwr${shopFilter}${around};`;
    } else {
      body = terms.flatMap((t) => {
        const rx = termRegex(t);
        return ['name', 'brand', 'operator'].map((k) => `nwr${shopFilter}["${k}"~"${rx}",i]${around};`);
      }).join('\n  ');
    }
    return `[out:json][timeout:60];\n(\n  ${body}\n);\nout center tags;`;
  }

  async function overpass(query) {
    let lastErr;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (!res.ok) throw new Error(`Overpass error ${res.status}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Store search failed: ${lastErr?.message || 'network error'}. Try a smaller radius or retry shortly.`);
  }

  function toStores(elements, center) {
    return elements.map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) return null;
      const t = el.tags || {};
      return {
        id: `${el.type}/${el.id}`,
        name: t.name || t.brand || 'Unnamed store',
        brand: t.brand || '',
        shop: t.shop || '',
        lat, lon,
        address: formatAddress(t),
        hours: t.opening_hours || '',
        phone: t.phone || t['contact:phone'] || '',
        website: t.website || t['contact:website'] || '',
        distanceKm: distanceKm(center, { lat, lon }),
        tags: t,
      };
    }).filter(Boolean);
  }

  function groupStores(stores, terms) {
    const byKey = new Map();
    const add = (key, label, store) => {
      if (!byKey.has(key)) byKey.set(key, { key, label, stores: [] });
      byKey.get(key).stores.push(store);
    };

    if (terms[0] === ALL) {
      for (const s of stores) {
        const label = s.brand || s.name;
        add(normalize(label) || 'unnamed', label, s);
      }
      // Big chains first; collapse long tail into "Other" so colors stay distinguishable.
      let list = [...byKey.values()].sort((a, b) => b.stores.length - a.stores.length);
      if (list.length > PALETTE.length) {
        const head = list.slice(0, PALETTE.length - 1);
        const other = { key: 'other', label: 'Other stores', stores: list.slice(PALETTE.length - 1).flatMap((g) => g.stores) };
        list = head.concat(other);
      }
      return list;
    }

    const termNorms = terms.map((t) => ({ term: t, rx: new RegExp(tokens(t).join('.{0,3}')) }));
    for (const s of stores) {
      const hay = [s.name, s.brand, s.tags.operator].map(normalize);
      const match = termNorms.find(({ rx }) => hay.some((h) => rx.test(h)));
      if (match) add(normalize(match.term), match.term, s);
    }
    // keep the user's ordering, and include zero-result terms so they see "0"
    return terms.map((t) => byKey.get(normalize(t)) || { key: normalize(t), label: t, stores: [] });
  }

  // ---------- render ----------
  function render() {
    markersLayer.clearLayers();
    els.legend.innerHTML = '';
    els.results.innerHTML = '';

    for (const g of groups) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (g.visible ? '' : ' off');
      chip.innerHTML = `<span class="dot" style="background:${g.color}"></span>${escapeHtml(g.label)} <b>${g.stores.length}</b>`;
      chip.title = 'Click to show/hide';
      chip.onclick = () => { g.visible = !g.visible; render(); };
      els.legend.appendChild(chip);
    }

    const visible = groups.filter((g) => g.visible)
      .flatMap((g) => g.stores.map((s) => ({ s, g })))
      .sort((a, b) => a.s.distanceKm - b.s.distanceKm);

    for (const { s, g } of visible) {
      const marker = L.circleMarker([s.lat, s.lon], {
        radius: 8, color: '#fff', weight: 2, fillColor: g.color, fillOpacity: 0.95,
      }).bindPopup(popupHtml(s));
      markersLayer.addLayer(marker);

      const li = document.createElement('li');
      li.innerHTML = `<span class="dot" style="background:${g.color}"></span>
        <strong>${escapeHtml(s.name)}</strong>
        <span class="addr">${escapeHtml(s.address || 'Address not listed')}</span>
        <span class="meta">${s.distanceKm.toFixed(1)} km away${s.hours ? ' · ' + escapeHtml(s.hours) : ''}</span>`;
      li.onclick = () => { map.setView([s.lat, s.lon], 16); marker.openPopup(); };
      els.results.appendChild(li);
    }
    els.exports.hidden = groups.every((g) => !g.stores.length);
  }

  function popupHtml(s) {
    const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;
    const osm = `https://www.openstreetmap.org/${s.id}`;
    let site = '';
    if (/^https?:\/\//i.test(s.website)) site = `<br><a href="${escapeHtml(s.website)}" target="_blank" rel="noopener">Website</a>`;
    return `<strong>${escapeHtml(s.name)}</strong>${s.brand && normalize(s.brand) !== normalize(s.name) ? `<br><em>${escapeHtml(s.brand)}</em>` : ''}
      ${s.address ? `<br>${escapeHtml(s.address)}` : ''}
      ${s.hours ? `<br>🕒 ${escapeHtml(s.hours)}` : ''}
      ${s.phone ? `<br>📞 ${escapeHtml(s.phone)}` : ''}${site}
      <br><a href="${gmaps}" target="_blank" rel="noopener">Directions</a> ·
      <a href="${osm}" target="_blank" rel="noopener">View on OSM</a>`;
  }

  // ---------- search flow ----------
  async function runSearch(centerOverride) {
    const terms = parseTerms(els.stores.value || ALL);
    if (!terms.length) { setStatus('Enter at least one store name.', true); return; }
    const radiusKm = Math.min(50, Math.max(1, +els.radius.value || 10));

    els.go.disabled = true;
    try {
      let center = centerOverride;
      if (!center) {
        const area = els.area.value.trim();
        if (area) {
          setStatus(`Finding ${area}…`);
          center = await geocode(area);
        } else {
          const c = map.getCenter();
          center = { lat: c.lat, lon: c.lng, label: 'current map view' };
        }
      }
      lastCenter = center;

      setStatus(`Searching for ${terms[0] === ALL ? 'all grocery stores' : terms.join(', ')} within ${radiusKm} km…`);
      const data = await overpass(buildQuery(terms, center, radiusKm * 1000, els.small.checked));
      const stores = toStores(data.elements || [], center);
      groups = groupStores(stores, terms).map((g, i) => ({ ...g, color: PALETTE[i % PALETTE.length], visible: true }));

      if (searchCircle) map.removeLayer(searchCircle);
      searchCircle = L.circle([center.lat, center.lon], {
        radius: radiusKm * 1000, color: '#1f7a4d', weight: 1, fillOpacity: 0.04, interactive: false,
      }).addTo(map);

      const total = groups.reduce((n, g) => n + g.stores.length, 0);
      render();
      if (total) {
        map.fitBounds(L.featureGroup(markersLayer.getLayers()).getBounds().pad(0.15), { maxZoom: 15 });
      } else {
        map.fitBounds(searchCircle.getBounds());
      }
      setStatus(total
        ? `Found ${total} store${total === 1 ? '' : 's'} near ${center.label.split(',').slice(0, 2).join(',')}.`
        : 'No matching stores found here. Try a larger radius or a different spelling.');
      updateUrl();
    } catch (e) {
      console.error(e);
      setStatus(e.message || String(e), true);
    } finally {
      els.go.disabled = false;
    }
  }

  function updateUrl() {
    const p = new URLSearchParams();
    if (els.stores.value) p.set('stores', els.stores.value);
    if (els.area.value) p.set('area', els.area.value);
    else if (lastCenter) p.set('at', `${lastCenter.lat.toFixed(5)},${lastCenter.lon.toFixed(5)}`);
    p.set('r', els.radius.value);
    if (els.small.checked) p.set('small', '1');
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }

  // ---------- exports ----------
  function allVisibleStores() {
    return groups.filter((g) => g.visible).flatMap((g) => g.stores.map((s) => ({ ...s, group: g.label })));
  }

  function download(filename, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('csv').onclick = () => {
    const cols = ['group', 'name', 'brand', 'shop', 'address', 'lat', 'lon', 'distanceKm', 'hours', 'phone', 'website', 'id'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = allVisibleStores().map((s) => cols.map((c) => q(c === 'distanceKm' ? s[c].toFixed(2) : s[c])).join(','));
    download('stores.csv', [cols.join(','), ...rows].join('\n'), 'text/csv');
  };

  $('geojson').onclick = () => {
    const fc = {
      type: 'FeatureCollection',
      features: allVisibleStores().map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: { group: s.group, name: s.name, brand: s.brand, shop: s.shop, address: s.address,
                      hours: s.hours, phone: s.phone, website: s.website, osm_id: s.id },
      })),
    };
    download('stores.geojson', JSON.stringify(fc, null, 2), 'application/geo+json');
  };

  $('share').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); setStatus('Link copied.'); }
    catch { setStatus(location.href); }
  };

  // ---------- events ----------
  els.form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });

  els.locate.onclick = () => {
    if (!navigator.geolocation) { setStatus('Geolocation is not available in this browser.', true); return; }
    setStatus('Getting your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        els.area.value = '';
        runSearch({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'your location' });
      },
      (err) => setStatus(`Couldn't get your location: ${err.message}`, true),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  };

  // Restore a shared search from the URL, e.g. ?stores=Aldi,Lidl&area=Chicago&r=15
  const params = new URLSearchParams(location.search);
  if (params.has('stores')) els.stores.value = params.get('stores');
  if (params.has('area')) els.area.value = params.get('area');
  if (params.has('r')) els.radius.value = params.get('r');
  if (params.get('small') === '1') els.small.checked = true;
  if (params.has('stores') && (params.has('area') || params.has('at'))) {
    const at = params.get('at');
    if (!params.has('area') && at) {
      const [lat, lon] = at.split(',').map(Number);
      runSearch({ lat, lon, label: 'shared location' });
    } else {
      runSearch();
    }
  }

  // exposed for tests
  window.__mapper = { normalize, termRegex, buildQuery, groupStores, toStores };
})();
