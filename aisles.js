/* Kroger Aisle Mapper — builds an aisle directory for one store from the Kroger Products API. */
(() => {
  'use strict';

  // Common grocery searches used to discover what each aisle holds.
  const SEED_TERMS = [
    'milk', 'eggs', 'butter', 'cheese', 'yogurt', 'bread', 'tortillas', 'bagels', 'cereal', 'oatmeal',
    'coffee', 'tea', 'juice', 'soda', 'water', 'sports drink', 'beer', 'wine', 'pasta', 'pasta sauce',
    'rice', 'beans', 'canned soup', 'canned vegetables', 'canned tuna', 'broth', 'flour', 'sugar',
    'baking mix', 'spices', 'cooking oil', 'vinegar', 'ketchup', 'mustard', 'mayonnaise', 'salad dressing',
    'peanut butter', 'jelly', 'honey', 'syrup', 'crackers', 'cookies', 'chips', 'popcorn', 'nuts', 'candy',
    'granola bars', 'salsa', 'soy sauce', 'taco shells', 'frozen pizza', 'ice cream', 'frozen vegetables',
    'frozen meals', 'chicken', 'ground beef', 'bacon', 'sausage', 'lunch meat', 'seafood', 'apples',
    'bananas', 'lettuce', 'tomatoes', 'potatoes', 'onions', 'baby food', 'diapers', 'pet food', 'cat litter',
    'paper towels', 'toilet paper', 'trash bags', 'laundry detergent', 'dish soap', 'cleaning spray',
    'shampoo', 'toothpaste', 'deodorant', 'vitamins', 'pain reliever', 'greeting cards',
  ];
  const CONCURRENCY = 3;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

  let currentStore = null;
  let scanId = 0;                 // bumps when a new store is picked, cancelling the old scan
  let products = new Map();       // productId -> product (with .loc = primary aisle location)
  let hits = null;                // Set of productIds from the last "Where is" search, or null
  let selectedAisle = null;

  async function api(path) {
    const res = await fetch(path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
    return body;
  }

  // ---------- aisle model ----------
  // Numbered aisles key on their number; everything else (Produce, Deli, …) keys on its description.
  function aisleKey(loc) {
    const n = parseInt(loc.number, 10);
    if (Number.isFinite(n) && n > 0 && n < 200) return { key: `a${n}`, number: n, label: `Aisle ${n}` };
    const d = (loc.description || '').trim();
    if (!d) return null;
    return { key: `d:${d.toUpperCase()}`, number: null, label: titleCase(d) };
  }

  function addProducts(list) {
    for (const p of list) {
      const located = p.aisles.map((a) => ({ a, k: aisleKey(a) })).find((x) => x.k);
      products.set(p.id, { ...p, loc: located ? { ...located.a, ...located.k } : null });
    }
  }

  function buildAisles() {
    const aisles = new Map();
    for (const p of products.values()) {
      if (!p.loc) continue;
      let a = aisles.get(p.loc.key);
      if (!a) aisles.set(p.loc.key, a = { key: p.loc.key, number: p.loc.number, label: p.loc.label, products: [], cats: new Map() });
      a.products.push(p);
      for (const c of p.categories) a.cats.set(c, (a.cats.get(c) || 0) + 1);
    }
    for (const a of aisles.values()) {
      a.topCats = [...a.cats.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([c]) => c);
      a.hitCount = hits ? a.products.filter((p) => hits.has(p.id)).length : 0;
    }
    const all = [...aisles.values()];
    return {
      numbered: all.filter((a) => a.number != null).sort((x, y) => x.number - y.number),
      depts: all.filter((a) => a.number == null).sort((x, y) => y.products.length - x.products.length),
    };
  }

  // ---------- render ----------
  function tile(a) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile' + (a.number == null ? ' dept' : '') +
      (a.key === selectedAisle ? ' sel' : '') + (hits ? (a.hitCount ? ' hit' : ' dim') : '');
    const head = a.number != null ? `<small>Aisle</small>${a.number}` : esc(a.label);
    const count = hits && a.hitCount
      ? `${a.hitCount} match${a.hitCount === 1 ? '' : 'es'}`
      : `${a.products.length} item${a.products.length === 1 ? '' : 's'} sampled`;
    b.innerHTML = `<span class="num">${head}</span><span class="cats">${esc(a.topCats.join(' · '))}</span><span class="count">${count}</span>`;
    b.onclick = () => { selectedAisle = a.key; render(); $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
    return b;
  }

  function render() {
    const { numbered, depts } = buildAisles();
    $('aisleGrid').replaceChildren(...numbered.map(tile));
    if (!numbered.length) $('aisleGrid').innerHTML = '<p class="sub">No numbered aisles found yet.</p>';
    $('deptGrid').replaceChildren(...depts.map(tile));
    $('deptSection').hidden = !depts.length;

    const sel = numbered.concat(depts).find((a) => a.key === selectedAisle);
    $('detail').hidden = !sel;
    if (sel) renderDetail(sel);
  }

  const SIDES = { L: 'Left side', R: 'Right side' };
  function renderDetail(a) {
    $('detailTitle').textContent = `${a.label} — ${a.products.length} sampled item${a.products.length === 1 ? '' : 's'}`;
    const bySide = new Map();
    for (const p of a.products) {
      const side = SIDES[String(p.loc.side).toUpperCase()] || '';
      if (!bySide.has(side)) bySide.set(side, []);
      bySide.get(side).push(p);
    }
    const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 1e9; };
    let html = '';
    for (const [side, list] of [...bySide.entries()].sort()) {
      list.sort((x, y) => (hits ? hits.has(y.id) - hits.has(x.id) : 0) || num(x.loc.bay) - num(y.loc.bay) || num(x.loc.shelf) - num(y.loc.shelf));
      if (side) html += `<h4>${side}</h4>`;
      html += '<table><thead><tr><th>Item</th><th>Category</th><th>Bay</th><th>Shelf</th><th>Price</th></tr></thead><tbody>' +
        list.map((p) => `<tr class="${hits?.has(p.id) ? 'hit' : ''}">
          <td>${esc(p.description)}${p.size ? ` <span class="sub">(${esc(p.size)})</span>` : ''}</td>
          <td class="n">${esc(p.categories[0] || '')}</td>
          <td class="n">${esc(p.loc.bay || '–')}</td><td class="n">${esc(p.loc.shelf || '–')}</td>
          <td class="n">${p.price != null ? '$' + Number(p.price).toFixed(2) : ''}</td></tr>`).join('') +
        '</tbody></table>';
    }
    $('detailBody').innerHTML = html;
  }

  // ---------- store list ----------
  function setStatus(msg, isError = false) {
    $('status').textContent = msg;
    $('status').classList.toggle('error', isError);
  }

  function showSetup() {
    $('status').innerHTML = `<div class="setup"><strong>Kroger API keys needed.</strong><br>
      1. Create a free app at <a href="https://developer.kroger.com" target="_blank" rel="noopener">developer.kroger.com</a> with the <em>Products</em> API.<br>
      2. Copy <code>.env.example</code> to <code>.env</code> and fill in the client ID and secret.<br>
      3. Restart with <code>npm start</code>.</div>`;
  }

  $('findStores').addEventListener('submit', async (e) => {
    e.preventDefault();
    const zip = $('zip').value.trim();
    setStatus('Finding stores…');
    $('stores').innerHTML = '';
    try {
      const { stores } = await api(`/api/kroger/locations?zip=${encodeURIComponent(zip)}&radius=${encodeURIComponent($('radius').value)}`);
      setStatus(stores.length ? `${stores.length} store${stores.length === 1 ? '' : 's'} found. Pick one:` : 'No Kroger-family stores found near that ZIP.');
      for (const s of stores) {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${esc(s.name)}</strong><span>${esc(s.address)}</span>`;
        li.onclick = () => {
          document.querySelectorAll('#stores li.sel').forEach((n) => n.classList.remove('sel'));
          li.classList.add('sel');
          openStore(s);
        };
        $('stores').appendChild(li);
      }
      history.replaceState(null, '', `?zip=${encodeURIComponent(zip)}`);
    } catch (err) {
      if (err.status === 503) showSetup(); else setStatus(err.message, true);
    }
  });

  // ---------- store scan ----------
  async function openStore(store) {
    const myScan = ++scanId;
    currentStore = store;
    products = new Map();
    hits = null;
    selectedAisle = null;
    $('empty').hidden = true;
    $('storeView').hidden = false;
    $('storeName').textContent = store.name;
    $('storeAddr').textContent = store.address;
    $('findStatus').textContent = '';
    $('clear').hidden = true;
    $('term').value = '';
    render();

    const queue = SEED_TERMS.slice();
    let done = 0, failed = 0, lastError = '';
    $('progressWrap').hidden = false;
    $('progress').max = queue.length;
    const tick = () => {
      $('progress').value = done;
      $('progressText').textContent = `Mapping aisles… ${done}/${SEED_TERMS.length} product searches`;
    };
    tick();

    const worker = async () => {
      while (queue.length && myScan === scanId) {
        const term = queue.shift();
        try {
          const { products: list } = await api(`/api/kroger/products?locationId=${store.id}&term=${encodeURIComponent(term)}`);
          if (myScan !== scanId) return;
          addProducts(list);
        } catch (err) {
          failed++; lastError = err.message;
          if (err.status === 429 || err.status === 503) queue.length = 0; // no point hammering on
        }
        done++;
        if (myScan === scanId) { tick(); render(); }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (myScan !== scanId) return;

    $('progressWrap').hidden = true;
    const located = [...products.values()].filter((p) => p.loc).length;
    const { numbered, depts } = buildAisles();
    $('findStatus').textContent = failed && !products.size
      ? `Couldn't map this store: ${lastError}`
      : `Mapped ${numbered.length} aisles and ${depts.length} other areas from ${located} located products` +
        (products.size - located ? ` (${products.size - located} more had no aisle listed)` : '') +
        (failed ? `. ${failed} searches failed: ${lastError}` : '.');
    $('findStatus').classList.toggle('error', Boolean(failed && !products.size));
  }

  // ---------- "where is…" ----------
  $('find').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentStore) return;
    const term = $('term').value.trim();
    const store = currentStore;
    $('findStatus').classList.remove('error');
    $('findStatus').textContent = `Looking for ${term}…`;
    try {
      const { products: list } = await api(`/api/kroger/products?locationId=${store.id}&term=${encodeURIComponent(term)}`);
      if (store !== currentStore) return;
      addProducts(list);
      hits = new Set(list.map((p) => p.id));
      const { numbered, depts } = buildAisles();
      const where = numbered.concat(depts).filter((a) => a.hitCount).sort((x, y) => y.hitCount - x.hitCount);
      const unlocated = list.filter((p) => !products.get(p.id).loc).length;
      $('findStatus').textContent = !list.length ? `Nothing found for "${term}" at this store.`
        : !where.length ? `Found ${list.length} products for "${term}", but Kroger lists no aisle for them at this store.`
        : `"${term}" is mostly in ${where[0].label}` +
          (where.length > 1 ? `; also ${where.slice(1, 4).map((a) => a.label).join(', ')}` : '') +
          (unlocated ? ` (${unlocated} of ${list.length} matches have no aisle listed)` : '') + '.';
      selectedAisle = where[0]?.key ?? selectedAisle;
      $('clear').hidden = false;
      render();
    } catch (err) {
      $('findStatus').textContent = err.message;
      $('findStatus').classList.add('error');
    }
  });

  $('clear').onclick = () => {
    hits = null;
    $('clear').hidden = true;
    $('term').value = '';
    $('findStatus').textContent = '';
    render();
  };

  // ---------- init ----------
  api('/api/kroger/status').then((s) => { if (!s.configured) showSetup(); })
    .catch(() => setStatus('This page needs the app server: run "npm start" and open http://localhost:8000/aisles.html', true));
  const zip = new URLSearchParams(location.search).get('zip');
  if (zip && /^\d{5}$/.test(zip)) { $('zip').value = zip; $('findStores').requestSubmit(); }
})();
