/* global maplibregl, h3 */
'use strict';

// ---------- Parametry gry ----------
const RES = 10;                 // H3: bok heksu ok. 66-75 m
const AREA_K = 10;              // promień wczytywanego obszaru w pierścieniach heksów (~1,2 km)
const KEY = 'terra.v1';
const H = 3600e3, DAY = 24 * H;
const ME = 'ty';
const CAPTURE = 10, KEEP = 5, MAX_INF = 100;
const M_PER_POINT = 5;          // 1 pkt wpływu za 5 m: neutralny heks zajmuje się po ok. 50 m, czyli zwykłym przejściem
const DECAY_PER_DAY = 0.95;     // wpływ zanika o 5% na dobę
const MAX_SPEED = 5.5;          // m/s (ok. 20 km/h), szybciej ruch nie jest liczony
const ROUTE_MAX_AGE = H, ROUTE_MIN_DIST = 300;
const DUEL_STAKE = 10, DUEL_SECONDS = 20;
const PROTECT = H;              // ochrona świeżo przejętego heksu
const DEFAULT_START = [52.2477, 21.0137]; // Warszawa, Plac Zamkowy
// Publiczne serwery Overpass bywają przeciążone (504), więc próbujemy kilku po kolei.
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://z.overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter', 'https://overpass-api.de/api/interpreter'];

// Strażnicy dzikich ziem: neutralni, nie atakują, nie pobierają myta, bronią się w pojedynkach.
const NPC = {
  'npc:zielen': { name: 'Borowi', color: '#8a7a55', npc: true, lore: 'leśne duchy pilnujące zieleni' },
  'npc:handel': { name: 'Gildia Kramarzy', color: '#8a7a55', npc: true, lore: 'kupcy, którzy nie oddadzą straganu bez walki' },
  'npc:kultura': { name: 'Strażnicy Pamięci', color: '#8a7a55', npc: true, lore: 'opiekunowie zabytków i murów' },
  'npc:transport': { name: 'Bractwo Dróżników', color: '#8a7a55', npc: true, lore: 'trzymają przystanki i rozstaje' },
  'npc:zabudowa': { name: 'Domowiki', color: '#8a7a55', npc: true, lore: 'duszki podwórek i kamienic' },
};
const ME_INFO = { name: 'Ty', color: '#1971c2' };
// Symulowani gracze: wyglądają jak ludzie z okolicy.
const BOT_NAMES = ['kasia_biega', 'Marek_z_Bielan', 'spacerowiczka', 'Ola.z.psem', 'tomek.rower', 'Bartek88', 'Zuza_w_parku',
  'pan_Zdzisiek', 'Iga.run', 'Kuba_Nocny', 'MamaNaSpacerze', 'Rysiek_Kroki', 'Wiktoria.K', 'ProstoZPracy', 'Hania_i_Burek', 'Krokomierz'];
const BOT_COLORS = ['#e03131', '#7048e8', '#f08c00', '#c2255c', '#5c940d', '#862e9c', '#d9480f', '#0b7285'];
function owner(id) {
  if (id === ME) return ME_INFO;
  return NPC[id] || S.bots[id] || { name: '?', color: '#495057' };
}
const isBot = id => !!(id && S.bots[id]);
const botIds = () => Object.keys(S.bots);
const TYPES = {
  zielen: { label: 'Zieleń', res: 'drewno', color: '#2b8a3e' },
  handel: { label: 'Handel', res: 'towary', color: '#e67700' },
  kultura: { label: 'Kultura', res: 'slawa', color: '#9c36b5' },
  transport: { label: 'Transport', res: 'wozy', color: '#0c8599' },
  zabudowa: { label: 'Zabudowa', res: 'monety', color: '#868e96' },
};
const RESOURCES = { monety: 'Monety', drewno: 'Drewno', towary: 'Towary', slawa: 'Sława', wozy: 'Wozy' };
const BUILD = {
  targ: { label: 'Targ', desc: 'produkcja x(1+poziom), myto +2/poziom',
    cost: l => ({ monety: 20 * l, towary: 10 * l, ...(l === 3 ? { slawa: 10 } : {}) }) },
  wieza: { label: 'Wieża', desc: 'wolniejsze przejmowanie, mocniejszy garnizon',
    cost: l => ({ monety: 20 * l, drewno: 15 * l, ...(l === 3 ? { slawa: 10 } : {}) }) },
};

// ---------- Stan ----------
function fresh() {
  return {
    v: 1, mode: null, pos: null, cur: null,
    inv: { monety: 30, drewno: 0, towary: 0, slawa: 0, wozy: 0 },
    hexes: {}, areas: [], cargo: null, bots: {},
    stats: { meters: 0, captured: 0, routes: 0, routeIncome: 0, tollPaid: 0, tollEarned: 0, duelsWon: 0, duelsLost: 0 },
    lastTick: Date.now(), log: [],
  };
}
function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 1 && s.bots) return s; } catch (e) { /* brak zapisu */ }
  return fresh();
}
let S = load();
// Migracja zapisów sprzed obniżenia progów: osłabiamy wpływ strażników i botów, Twój zostaje.
if (!S.tune) {
  for (const h of Object.values(S.hexes)) {
    for (const k in h.inf) if (k !== ME) h.inf[k] = Math.min(h.inf[k] * 0.5, k.startsWith('npc:') ? 18 : 40);
  }
  S.tune = 2;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* tryb prywatny */ } }, 300);
}

// ---------- Geometria ----------
function dist(a, b) {
  const R = 6371e3, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function inPoly(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const boundaryCache = new Map();
function boundary(id) {
  let b = boundaryCache.get(id);
  if (!b) { b = h3.cellToBoundary(id, true); boundaryCache.set(id, b); }
  return b;
}
const center = id => h3.cellToLatLng(id);

// ---------- Dane OSM ----------
let loading = false, lastFail = 0;
async function ensureArea(lat, lng) {
  if (loading || Date.now() - lastFail < 20e3) return;
  const here = S.hexes[h3.latLngToCell(lat, lng, RES)];
  if (S.areas.some(a => dist(a, [lat, lng]) < 700) && !(here && here.pending)) return;
  loading = true;
  setStatus('Wczytuję okolicę z OpenStreetMap…');
  const mid = h3.latLngToCell(lat, lng, RES);
  const cells = h3.gridDisk(mid, AREA_K).filter(c => !S.hexes[c] || S.hexes[c].pending);
  const created = cells.filter(c => !S.hexes[c]);
  let s = 90, w = 180, n = -90, e = -180;
  for (const c of cells) for (const [la, ln] of h3.cellToBoundary(c)) {
    s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln);
  }
  let osm = null;
  try { osm = await fetchOverpass(s, w, n, e); } catch (err) {
    lastFail = Date.now();
    toast('Serwer danych OSM jest przeciążony. Typy terenu chwilowo uproszczone, ponowię za 20 s.');
  }
  classify(cells, osm);
  if (osm) S.areas.push([lat, lng]);
  seedBots(created, mid);
  loading = false;
  setStatus('');
  save(); render();
}

async function fetchOverpass(s, w, n, e) {
  const bb = [s, w, n, e].map(v => v.toFixed(5)).join(',');
  const q = `[out:json][timeout:25][bbox:${bb}];
(way["leisure"~"^(park|garden|nature_reserve|playground|dog_park)$"];
 way["landuse"~"^(forest|grass|meadow|recreation_ground|village_green|allotments)$"];
 way["natural"~"^(wood|scrub|water)$"];
 way["waterway"="riverbank"];);
out geom;
(node["shop"];
 node["amenity"~"^(restaurant|cafe|bar|pub|fast_food|pharmacy|bank|marketplace|ice_cream)$"];
 node["tourism"~"^(attraction|museum|viewpoint|artwork|gallery)$"];
 node["historic"];
 node["amenity"~"^(place_of_worship|theatre|library|arts_centre|cinema)$"];
 node["highway"="bus_stop"];
 node["railway"~"^(station|tram_stop|halt|subway_entrance)$"];);
out;
(way["highway"~"^(motorway|motorway_link)$"]["tunnel"!="yes"];
 way["railway"="rail"]["tunnel"!="yes"]["bridge"!="yes"];);
out geom;`;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (r.ok) return await r.json();
    } catch (err) { /* następny serwer */ }
  }
  throw new Error('overpass');
}

const CULTURE = /^(place_of_worship|theatre|library|arts_centre|cinema)$/;
function classify(cells, osm) {
  const cellSet = new Set(cells), score = {}, blocked = new Set();
  const add = (c, t, v) => { if (!cellSet.has(c)) return; (score[c] ??= {})[t] = (score[c][t] || 0) + v; };
  const centers = cells.map(c => [c, center(c)]);
  for (const el of (osm?.elements || [])) {
    const t = el.tags || {};
    if (el.type === 'node') {
      const c = h3.latLngToCell(el.lat, el.lon, RES);
      if (t.highway === 'bus_stop' || t.railway) add(c, 'transport', 2);
      else if (t.tourism || t.historic || CULTURE.test(t.amenity || '')) add(c, 'kultura', 2);
      else if (t.shop || t.amenity) add(c, 'handel', 1);
    } else if (el.type === 'way' && el.geometry) {
      const g = el.geometry.map(p => [p.lat, p.lon]);
      if (t.highway || t.railway) { markLine(g, blocked, cellSet); continue; }
      const closed = g.length > 3 && g[0][0] === g[g.length - 1][0] && g[0][1] === g[g.length - 1][1];
      if (!closed) continue;
      const water = t.natural === 'water' || t.waterway === 'riverbank';
      let s = 90, n = -90, w = 180, e = -180;
      for (const [a, b] of g) { s = Math.min(s, a); n = Math.max(n, a); w = Math.min(w, b); e = Math.max(e, b); }
      for (const [c, [la, ln]] of centers) {
        if (la < s || la > n || ln < w || ln > e || !inPoly(la, ln, g)) continue;
        if (water) blocked.add(c); else add(c, 'zielen', 3);
      }
    }
  }
  for (const c of cells) {
    let type = 'zabudowa', best = 1;
    for (const [k, v] of Object.entries(score[c] || {})) if (v > best) { best = v; type = k; }
    const h = S.hexes[c] || (S.hexes[c] = { inf: {}, owner: null, b: null, store: 0 });
    h.type = type;
    // Strażnik dzikiej ziemi zawsze odpowiada typowi terenu (ważne po ponownym wczytaniu danych OSM).
    const npc = 'npc:' + type;
    if (NPC[h.owner] && h.owner !== npc) { h.inf[npc] = h.inf[h.owner]; delete h.inf[h.owner]; h.owner = npc; }
    h.blocked = blocked.has(c);
    h.pending = !osm;
    if (h.blocked) { h.owner = null; h.inf = {}; h.b = null; }
  }
}
function markLine(g, blocked, cellSet) {
  for (let i = 1; i < g.length; i++) {
    const a = g[i - 1], b = g[i], steps = Math.max(1, Math.ceil(dist(a, b) / 20));
    for (let k = 0; k <= steps; k++) {
      const c = h3.latLngToCell(a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps, RES);
      if (cellSet.has(c)) blocked.add(c);
    }
  }
}

function newBot() {
  const used = new Set(Object.values(S.bots).map(b => b.name));
  const free = BOT_NAMES.filter(n => !used.has(n));
  if (!free.length) return null;
  const id = 'bot' + Object.keys(S.bots).length;
  S.bots[id] = { name: free[Math.floor(Math.random() * free.length)], color: BOT_COLORS[Object.keys(S.bots).length % BOT_COLORS.length],
    lvl: 3 + Math.floor(Math.random() * 22) };
  return id;
}

// Zaludnienie mapy: dzikie ziemie ze strażnikami i skupiska terenu symulowanych graczy.
function seedBots(created, mid) {
  const ok = created.filter(c => {
    if (S.hexes[c].blocked) return false;
    try { return h3.gridDistance(c, mid) >= 2; } catch (e) { return false; }
  });
  for (const c of ok) {
    if (Math.random() > 0.35) continue;
    const h = S.hexes[c], npc = 'npc:' + (h.type || 'zabudowa');
    h.inf[npc] = 8 + Math.random() * 10;
    h.owner = npc;
    h.store = 3 + Math.random() * 12;
  }
  const far = ok.filter(c => { try { return h3.gridDistance(c, mid) >= 4; } catch (e) { return false; } });
  const local = [];
  for (let i = 0; i < 3; i++) { const b = newBot(); if (b) local.push(b); }
  if (!local.length) local.push(...botIds());
  const seeds = Math.round(far.length * 0.03);
  for (let i = 0; i < seeds && local.length; i++) {
    const seed = far[Math.floor(Math.random() * far.length)], bot = local[i % local.length];
    for (const c of h3.gridDisk(seed, Math.random() < 0.5 ? 1 : 2)) {
      const h = S.hexes[c];
      if (!h || h.blocked || isBot(h.owner) || Math.random() < 0.2) continue;
      h.inf = { [bot]: 15 + Math.random() * 25 };
      h.owner = bot;
      h.store = Math.random() * 10;
      if (Math.random() < 0.25) h.b = { t: Math.random() < 0.5 ? 'targ' : 'wieza', l: Math.random() < 0.3 ? 2 : 1 };
    }
  }
}

// ---------- Ekonomia ----------
const resOf = h => TYPES[h.type || 'zabudowa'].res;
const lvl = (h, t) => (h.b && h.b.t === t ? h.b.l : 0);
const prodRate = h => (h.type === 'zabudowa' ? 1 : 2) * (1 + lvl(h, 'targ'));
const tollOf = h => 2 + 2 * lvl(h, 'targ');
const garrison = h => (NPC[h.owner] ? 8 : 12) +4 * lvl(h, 'wieza') + Math.floor(Math.random() * 5);
const afford = cost => Object.entries(cost).every(([k, v]) => S.inv[k] >= v);
const costText = cost => Object.entries(cost).map(([k, v]) => `${v} ${RESOURCES[k].toLowerCase()}`).join(', ');

function updateOwner(id, h, cause) {
  let best = null, bv = 0;
  for (const [k, v] of Object.entries(h.inf)) if (v > bv) { bv = v; best = k; }
  const cur = h.owner, cv = cur ? (h.inf[cur] || 0) : 0;
  let next = cur;
  if (best && best !== cur && bv >= CAPTURE && bv > cv) next = best;
  else if (cur && cv < KEEP) next = best && bv >= CAPTURE ? best : null;
  if (next !== cur) changeOwner(id, h, cur, next, cause);
}

// Zmiana właściciela: budynek przechodzi o poziom niżej, zdobywca bierze magazyn jako łup.
function changeOwner(id, h, from, to, cause) {
  const now = Date.now();
  let buildingNote = '';
  if (h.b) {
    h.b.l -= 1;
    if (h.b.l <= 0) { buildingNote = `, ${BUILD[h.b.t].label} zburzony`; h.b = null; }
    else buildingNote = `, przejęty budynek: ${BUILD[h.b.t].label} poz. ${h.b.l}`;
  }
  const loot = Math.floor(h.store || 0);
  h.store = 0;
  h.owner = to;
  h.protect = to ? now + PROTECT : 0;
  if (to === ME) {
    S.inv[resOf(h)] += loot;
    S.stats.captured++;
    log(`Heks zdobyty (${TYPES[h.type].label})${loot ? `, łup +${loot} ${RESOURCES[resOf(h)].toLowerCase()}` : ''}${buildingNote}`);
    if (id === S.cur) route(id, h, now);
  } else if (from === ME) {
    log(`Heks utracony: ${to ? 'przejmuje go ' + owner(to).name : 'opuszczony, wpływ wygasł'}${buildingNote}`, cause !== 'walk');
  }
}

function tick() {
  const now = Date.now(), dt = Math.min(now - S.lastTick, 7 * DAY);
  if (dt < 1000) return;
  S.lastTick = now;
  const hours = dt / H, f = Math.pow(DECAY_PER_DAY, dt / DAY);
  for (const [id, h] of Object.entries(S.hexes)) {
    if (h.blocked) continue;
    for (const k in h.inf) { h.inf[k] *= f; if (h.inf[k] < 0.5) delete h.inf[k]; }
    if (h.owner) h.store = Math.min(prodRate(h) * 24, (h.store || 0) + prodRate(h) * hours);
    updateOwner(id, h, 'decay');
  }
  botActivity(hours);
  if (S.pos && S.cur && S.hexes[S.cur]?.pending) ensureArea(...S.pos);
  save(); render();
}

function neighborBot(id) {
  for (const c of h3.gridDisk(id, 1)) { const o = S.hexes[c]?.owner; if (isBot(o)) return o; }
  return null;
}

function botActivity(hours) {
  const ids = Object.keys(S.hexes), h0 = Math.min(hours, 48), now = Date.now();
  let tollIn = 0, lost = 0;
  for (const id of ids) {
    const h = S.hexes[id];
    if (h.blocked || !h.owner) continue;
    if (NPC[h.owner]) { h.inf[h.owner] = Math.min(20, (h.inf[h.owner] || 0) + h0); continue; }
    if (h.owner !== ME) { h.inf[h.owner] = Math.min(MAX_INF, (h.inf[h.owner] || 0) + 3 * h0); continue; }
    // Przechodnie płacą myto na Twoich heksach.
    if (Math.random() < 1 - Math.exp(-0.15 * h0)) { const t = tollOf(h); S.inv.monety += t; S.stats.tollEarned += t; tollIn += t; }
    // Rywale naciskają na heksy przy swojej granicy.
    if (now < (h.protect || 0)) continue;
    const enemy = neighborBot(id);
    if (!enemy) continue;
    const g = 0.6 * h0 / (1 + lvl(h, 'wieza'));
    h.inf[ME] = Math.max(0, (h.inf[ME] || 0) - g);
    h.inf[enemy] = (h.inf[enemy] || 0) + g;
    const before = h.owner;
    updateOwner(id, h, 'bot');
    if (h.owner !== before) lost++;
  }
  for (const bot of botIds()) {
    const n = Math.floor(h0 * 0.3 + Math.random());
    for (let i = 0; i < n; i++) {
      const own = ids.filter(id => S.hexes[id].owner === bot);
      if (!own.length) break;
      const from = own[Math.floor(Math.random() * own.length)];
      const nb = h3.gridDisk(from, 1).filter(c => S.hexes[c] && !S.hexes[c].blocked && (!S.hexes[c].owner || NPC[S.hexes[c].owner]));
      if (!nb.length) continue;
      const c = nb[Math.floor(Math.random() * nb.length)];
      S.hexes[c].inf[bot] = (S.hexes[c].inf[bot] || 0) + 12;
      updateOwner(c, S.hexes[c], 'bot');
    }
  }
  if (tollIn) log(`Myto od przechodniów: +${tollIn} monet`, hours > 0.25);
  if (lost && hours > 0.25) toast(`Pod Twoją nieobecność utracono heksy: ${lost}`);
}

// ---------- Symulowani gracze w ruchu ----------
// Widać ich świeży ślad z opóźnieniem, tak jak docelowo u prawdziwych graczy (prywatność: nigdy pozycja na żywo).
const walkers = [];
const TRAIL_DELAY = 45e3, TRAIL_LEN = 10 * 60e3;
let lastFeed = 0;
function randomNear(p, min, max) {
  const d = min + Math.random() * (max - min), a = Math.random() * 2 * Math.PI;
  return [p[0] + d * Math.cos(a) / 111320, p[1] + d * Math.sin(a) / (111320 * Math.cos(p[0] * Math.PI / 180))];
}
function spawnWalkers() {
  if (!S.pos) return;
  for (let i = walkers.length - 1; i >= 0; i--) {
    if (Date.now() > walkers[i].until || dist(walkers[i].pos, S.pos) > 2500) walkers.splice(i, 1);
  }
  const free = botIds().filter(b => !walkers.some(w => w.bot === b));
  while (walkers.length < 3 && free.length) {
    const bot = free.splice(Math.floor(Math.random() * free.length), 1)[0];
    const start = randomNear(S.pos, 250, 900);
    // Ślad startuje "w przeszłości", żeby od razu było widać, że ktoś tu chodził.
    walkers.push({ bot, pos: start, target: randomNear(start, 200, 700), cur: null, tolled: {},
      trail: [[Date.now() - TRAIL_DELAY, ...start]], until: Date.now() + (8 + Math.random() * 20) * 60e3 });
  }
}
function stepWalkers() {
  if (!S.pos || !Object.keys(S.hexes).length) return;
  spawnWalkers();
  const speed = S.mode === 'test' ? 7 : 1.4, now = Date.now();
  for (const w of walkers) {
    let d = dist(w.pos, w.target);
    if (d < 5) { w.target = randomNear(w.pos, 150, 600); d = dist(w.pos, w.target); }
    const step = Math.min(d, speed), f = step / d;
    w.pos = [w.pos[0] + (w.target[0] - w.pos[0]) * f, w.pos[1] + (w.target[1] - w.pos[1]) * f];
    w.trail.push([now, ...w.pos]);
    while (w.trail.length && now - w.trail[0][0] > TRAIL_LEN) w.trail.shift();
    const c = h3.latLngToCell(w.pos[0], w.pos[1], RES), h = S.hexes[c];
    if (!h || h.blocked) { if (h) w.target = randomNear(w.pos, 150, 600); continue; }
    if (c !== w.cur) {
      w.cur = c;
      if (h.owner === ME && !w.tolled[c]) {
        w.tolled[c] = 1;
        const t = tollOf(h);
        S.inv.monety += t; S.stats.tollEarned += t; dirty = true;
        feed(`${owner(w.bot).name} przechodzi przez Twój teren: myto +${t} monet`, true);
      }
    }
    const before = h.owner;
    botGain(c, h, w.bot, step / M_PER_POINT / 2);
    if (h.owner !== before) dirty = true;
  }
  if (dirty) { dirty = false; save(); render(); } else renderWalkers();
}
let dirty = false;
function renderWalkers() {
  if (!mapReady) return;
  const cut = Date.now() - TRAIL_DELAY, lines = [], heads = [];
  for (const w of walkers) {
    const pts = w.trail.filter(p => p[0] <= cut).map(p => [p[2], p[1]]);
    if (!pts.length) continue;
    const o = owner(w.bot);
    if (pts.length > 1) lines.push({ type: 'Feature', properties: { color: o.color }, geometry: { type: 'LineString', coordinates: pts } });
    heads.push({ type: 'Feature', properties: { color: o.color, label: `${o.name} · poz. ${o.lvl}` },
      geometry: { type: 'Point', coordinates: pts[pts.length - 1] } });
  }
  map.getSource('walkers').setData({ type: 'FeatureCollection', features: lines });
  map.getSource('walker-heads').setData({ type: 'FeatureCollection', features: heads });
}
function botGain(id, h, bot, g) {
  if (h.owner === bot) { h.inf[bot] = Math.min(MAX_INF, (h.inf[bot] || 0) + g); return; }
  if (h.owner && Date.now() < (h.protect || 0)) return;
  // Na Twoim terenie boty wypierają wolniej, żeby nacisk był odczuwalny, ale nie przytłaczający.
  const k = h.owner === ME ? 0.5 : 1;
  if (h.owner) h.inf[h.owner] = Math.max(0, (h.inf[h.owner] || 0) - k * g / (1 + lvl(h, 'wieza')));
  h.inf[bot] = Math.min(MAX_INF, (h.inf[bot] || 0) + k * g);
  const before = h.owner;
  updateOwner(id, h, 'bot');
  if (h.owner === bot && before !== bot && S.pos) {
    const m = Math.round(dist(center(id), S.pos) / 50) * 50;
    if (m <= 800) feed(`${owner(bot).name} zajmuje heks ${TYPES[h.type].label.toLowerCase()}, ${m} m od Ciebie`);
  }
}
function feed(msg, force) {
  const now = Date.now();
  const show = force || now - lastFeed > 40e3;
  if (show) lastFeed = now;
  log(msg, show);
}

// ---------- Ruch ----------
function moveTo(lat, lng, meters) {
  S.pos = [lat, lng];
  const c = h3.latLngToCell(lat, lng, RES);
  ensureArea(lat, lng);
  const h = S.hexes[c];
  if (meters > 0) { S.stats.meters += meters; if (S.cargo) S.cargo.m += meters; }
  if (c !== S.cur) { S.cur = c; if (h) onEnter(c, h); }
  if (h && meters > 0 && !h.blocked) gain(c, h, meters / M_PER_POINT);
  save(); render(); follow();
}

// Ile metrów trzeba przejść po heksie, żeby go zająć (uwzględnia wypieranie właściciela i Wieżę).
function metersToCapture(h) {
  const mine = h.inf[ME] || 0;
  let pts = Math.max(0, CAPTURE - mine);
  if (h.owner && h.owner !== ME) {
    const other = h.inf[h.owner] || 0, k = 1 + 1 / (1 + lvl(h, 'wieza'));
    pts = Math.max(pts, (other - mine) / k + 0.5);
  }
  return Math.max(5, Math.ceil(pts * M_PER_POINT / 5) * 5);
}

function gain(id, h, g) {
  if (h.owner && h.owner !== ME) {
    if (Date.now() < (h.protect || 0)) return;
    h.inf[h.owner] = Math.max(0, (h.inf[h.owner] || 0) - g / (1 + lvl(h, 'wieza')));
  }
  h.inf[ME] = Math.min(MAX_INF, (h.inf[ME] || 0) + g);
  updateOwner(id, h, 'walk');
}

function onEnter(id, h) {
  const now = Date.now();
  if (h.blocked) { toast('Teren wyłączony z gry (woda, tory, autostrada).'); return; }
  if (h.owner === ME) {
    const amt = Math.floor(h.store || 0);
    if (amt > 0) { S.inv[resOf(h)] += amt; h.store -= amt; toast(`Zebrano +${amt} ${RESOURCES[resOf(h)].toLowerCase()}`); }
    route(id, h, now);
  } else if (isBot(h.owner) && (!h.tollAt || now - h.tollAt > DAY)) {
    const paid = Math.min(S.inv.monety, tollOf(h));
    S.inv.monety -= paid; S.stats.tollPaid += paid; h.tollAt = now;
    if (paid > 0) toast(`Myto dla: ${owner(h.owner).name}, -${paid} monet`);
  }
}

// Szlak handlowy: ładunek z heksu jednego typu, dostawa do własnego heksu innego typu.
function route(id, h, now) {
  if (h.type === 'zabudowa') return;
  const res = resOf(h), c = S.cargo;
  if (c && now - c.since <= ROUTE_MAX_AGE && c.res !== res) {
    const straight = dist(center(c.from), center(id));
    if (straight >= ROUTE_MIN_DIST) {
      let pay = Math.round(c.m / 1000 * 30 + straight / 1000 * 20), bonus = '';
      if (S.inv.wozy >= 1) { S.inv.wozy--; pay = Math.round(pay * 1.5); bonus = ' (wóz x1,5)'; }
      S.inv.monety += pay; S.stats.routes++; S.stats.routeIncome += pay;
      log(`Szlak handlowy ${RESOURCES[c.res]} → ${RESOURCES[res]}: ${Math.round(c.m)} m, +${pay} monet${bonus}`);
      S.cargo = { from: id, res, since: now, m: 0 };
      return;
    }
  }
  if (!c || now - c.since > ROUTE_MAX_AGE) {
    S.cargo = { from: id, res, since: now, m: 0 };
    toast(`Karawana załadowana (${RESOURCES[res].toLowerCase()}). Zanieś do swojego heksu innego typu, min. 300 m dalej, w 60 min.`);
  }
}

// GPS
let watchId = null, lastFix = null;
function setMode(m) {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  clearInterval(walkTimer);
  S.mode = m;
  if (m === 'gps') {
    if (!navigator.geolocation) { toast('Ta przeglądarka nie udostępnia GPS.'); S.mode = 'test'; }
    else {
      lastFix = null;
      setStatus('Szukam sygnału GPS…');
      watchId = navigator.geolocation.watchPosition(onFix, err => setStatus('GPS: ' + err.message),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    }
  }
  if (S.mode === 'test' && !S.pos) teleport(...DEFAULT_START);
  save(); render();
}
// Diagnostyka GPS widoczna w menu, bo stan gry istnieje tylko na telefonie.
const diag = { fixes: 0, badAcc: 0, jitter: 0, tooFast: 0, counted: 0, meters: 0, acc: null, speed: null, last: null };
function onFix(p) {
  const { latitude: lat, longitude: lng, accuracy: acc } = p.coords, t = p.timestamp;
  diag.fixes++; diag.acc = acc; diag.last = Date.now();
  if (acc > 50 && S.pos && lastFix) { diag.badAcc++; setStatus(`Słaby sygnał GPS (±${Math.round(acc)} m), ruch wstrzymany`); renderGps(); return; }
  setStatus('');
  if (!lastFix || !S.pos) { lastFix = { lat, lng, t }; followOn = true; moveTo(lat, lng, 0); renderGps(); return; }
  const d = dist([lastFix.lat, lastFix.lng], [lat, lng]);
  // Drgania GPS: przesunięcie mniejsze niż dokładność odczytu (min. 10 m) czekamy, aż się zsumuje.
  if (d < Math.max(10, acc * 1.2)) { diag.jitter++; renderGps(); return; }
  const v = d / Math.max((t - lastFix.t) / 1000, 1);
  diag.speed = v;
  lastFix = { lat, lng, t };
  if (v > MAX_SPEED) {
    diag.tooFast++;
    setStatus('Za szybko (ponad 20 km/h): ten odcinek nie jest liczony');
    S.pos = [lat, lng]; S.cur = h3.latLngToCell(lat, lng, RES); ensureArea(lat, lng); render(); follow(); renderGps();
    return;
  }
  diag.counted++; diag.meters += d;
  moveTo(lat, lng, d);
  renderGps();
}
function renderGps() {
  const el = $('gps');
  if (S.mode !== 'gps') { el.hidden = true; return; }
  el.hidden = false;
  const age = diag.last ? Math.round((Date.now() - diag.last) / 1000) : null;
  el.textContent = diag.acc == null ? 'GPS: szukam…'
    : `GPS ±${Math.round(diag.acc)} m · ${diag.speed == null ? '-' : (diag.speed * 3.6).toFixed(1)} km/h${age > 15 ? ` · brak odczytu ${age} s` : ''}`;
}
function diagHtml() {
  return `<dl class="kv"><dt>Odczyty GPS</dt><dd>${diag.fixes}</dd><dt>Zaliczone odcinki</dt><dd>${diag.counted} (${Math.round(diag.meters)} m)</dd>
    <dt>Odrzucone: słaby sygnał</dt><dd>${diag.badAcc}</dd><dt>Odrzucone: drgania &lt;4 m</dt><dd>${diag.jitter}</dd>
    <dt>Odrzucone: za szybko</dt><dd>${diag.tooFast}</dd><dt>Ostatnia dokładność</dt><dd>${diag.acc == null ? '-' : '±' + Math.round(diag.acc) + ' m'}</dd></dl>`;
}

// Tryb testowy: chodzenie po kliknięciu.
let walkTimer = null;
function walkTo(lat, lng) {
  clearInterval(walkTimer);
  followOn = true;
  walkTimer = setInterval(() => {
    const d = dist(S.pos, [lat, lng]);
    if (d < 1) { clearInterval(walkTimer); walkTimer = null; return; }
    const step = Math.min(d, 8), f = step / d;
    moveTo(S.pos[0] + (lat - S.pos[0]) * f, S.pos[1] + (lng - S.pos[1]) * f, step);
  }, 100);
}
function teleport(lat, lng) {
  S.pos = [lat, lng]; S.cur = h3.latLngToCell(lat, lng, RES); S.cargo = null;
  followOn = true; ensureArea(lat, lng); save(); render(); follow(true);
}

// ---------- Budowa ----------
function build(t) {
  const h = S.hexes[S.cur];
  if (!h || h.owner !== ME || (h.b && h.b.t !== t)) return;
  const l = (h.b ? h.b.l : 0) + 1;
  if (l > 3) return;
  const cost = BUILD[t].cost(l);
  if (!afford(cost)) { toast('Brakuje surowców: ' + costText(cost)); return; }
  for (const [k, v] of Object.entries(cost)) S.inv[k] -= v;
  h.b = { t, l };
  log(`Zbudowano: ${BUILD[t].label} poz. ${l}`);
  save(); render();
}

// ---------- Pojedynek ----------
const duel = { id: null, score: 0, ghost: 0, end: 0, timer: null, hop: null };
const $ = id => document.getElementById(id);
function openDuel() {
  const id = S.cur, h = S.hexes[id], now = Date.now();
  if (!h || !h.owner || h.owner === ME) return;
  if (now < (h.protect || 0)) { toast('Heks jest pod ochroną po niedawnym przejęciu.'); return; }
  if (now < (h.duelCd || 0)) { toast('Ten heks możesz wyzwać ponownie za ' + Math.ceil((h.duelCd - now) / 60e3) + ' min.'); return; }
  if (S.inv.monety < DUEL_STAKE) { toast('Na stawkę potrzeba 10 monet.'); return; }
  duel.id = id; duel.ghost = garrison(h); duel.score = 0;
  $('dGhost').textContent = duel.ghost; $('dScore').textContent = 0; $('dTime').textContent = DUEL_SECONDS;
  $('dIntro').hidden = false; $('target').style.display = 'none';
  $('duel').hidden = false;
}
function startDuel() {
  S.inv.monety -= DUEL_STAKE;
  $('dIntro').hidden = true;
  duel.end = Date.now() + DUEL_SECONDS * 1000;
  hopTarget();
  duel.timer = setInterval(() => {
    const left = Math.max(0, Math.ceil((duel.end - Date.now()) / 1000));
    $('dTime').textContent = left;
    if (left <= 0) finishDuel();
  }, 100);
}
function hopTarget() {
  clearTimeout(duel.hop);
  const a = $('arena').getBoundingClientRect(), t = $('target');
  t.style.display = 'block';
  t.style.left = Math.random() * Math.max(0, a.width - 58) + 'px';
  t.style.top = Math.random() * Math.max(0, a.height - 58) + 'px';
  const elapsed = 1 - (duel.end - Date.now()) / (DUEL_SECONDS * 1000);
  duel.hop = setTimeout(hopTarget, 900 - 350 * elapsed);
}
function finishDuel() {
  clearInterval(duel.timer); clearTimeout(duel.hop);
  $('target').style.display = 'none';
  const h = S.hexes[duel.id], defender = h.owner, now = Date.now();
  if (duel.score > duel.ghost && defender && defender !== ME) {
    h.inf[ME] = Math.min(MAX_INF, Math.max(h.inf[ME] || 0, (h.inf[defender] || 0) + 10));
    h.inf[defender] = (h.inf[defender] || 0) * 0.4;
    S.inv.monety += DUEL_STAKE * 2; S.stats.duelsWon++;
    log(`Pojedynek wygrany ${duel.score}:${duel.ghost} z: ${owner(defender).name}, +${DUEL_STAKE} monet`);
    updateOwner(duel.id, h, 'duel');
  } else {
    h.duelCd = now + H; S.stats.duelsLost++;
    log(`Pojedynek przegrany ${duel.score}:${duel.ghost}, stawka przepada`);
  }
  $('duel').hidden = true;
  save(); render();
}

// ---------- Interfejs ----------
let map, mapReady = false, followOn = true, sel = null;
function setStatus(t) { const el = $('status'); el.textContent = t; el.hidden = !t; }
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
}
function log(msg, show = true) {
  S.log.unshift({ t: Date.now(), msg });
  S.log.length = Math.min(S.log.length, 60);
  if (show) toast(msg);
}
const fmtTime = t => new Date(t).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

function renderInv() {
  $('inv').innerHTML = Object.entries(RESOURCES)
    .map(([k, label]) => `<span class="chip">${label} <b>${Math.floor(S.inv[k])}</b></span>`).join('');
}

function renderCargo() {
  const c = S.cargo, el = $('cargo');
  if (!c || Date.now() - c.since > ROUTE_MAX_AGE) { el.hidden = true; return; }
  const left = Math.ceil((ROUTE_MAX_AGE - (Date.now() - c.since)) / 60e3);
  const from = S.pos ? Math.round(dist(center(c.from), S.pos)) : 0;
  el.hidden = false;
  el.textContent = `Karawana: ${RESOURCES[c.res].toLowerCase()}, przebyte ${Math.round(c.m)} m, ${from} m od startu, zostało ${left} min. Dostarcz do swojego heksu innego typu.`;
}

function infRows(h) {
  const rows = Object.entries(h.inf).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!rows.length) return '<span class="muted">brak</span>';
  return rows.map(([k, v]) => `<div>${owner(k).name}: ${Math.round(v)}<div class="bar"><i style="width:${Math.min(100, v)}%;background:${owner(k).color}"></i></div></div>`).join('');
}

function renderCard() {
  const id = sel || S.cur, h = id && S.hexes[id], el = $('card');
  if (!h) { el.innerHTML = `<p class="muted">${S.pos ? 'Wczytuję okolicę…' : 'Wybierz tryb w menu, żeby zacząć.'}</p>`; return; }
  const here = id === S.cur, now = Date.now(), t = TYPES[h.type || 'zabudowa'];
  const own = h.owner ? owner(h.owner) : null;
  const ownLabel = !own ? 'neutralny'
    : `<span class="dot" style="background:${own.color}"></span> ${own.name}${own.lvl ? ` <span class="muted">poz. ${own.lvl}</span>` : ''}${own.npc ? `<br><span class="muted">Dzikie ziemie: ${own.lore}</span>` : ''}`;
  let html = `<div class="card-title"><span class="dot" style="background:${t.color}"></span>${h.blocked ? 'Teren wyłączony' : t.label}
    <span class="muted">${here ? '· tu jesteś' : '· podgląd'}</span></div>`;
  if (h.blocked) {
    html += '<p class="muted">Woda, tory albo autostrada. Tu nie da się zajmować terenu.</p>';
  } else {
    html += `<dl class="kv">
      <dt>Właściciel</dt><dd>${ownLabel}</dd>
      <dt>Produkuje</dt><dd>${prodRate(h)}/h ${RESOURCES[t.res].toLowerCase()}${h.owner ? `, w magazynie ${Math.floor(h.store || 0)}` : ' (gdy ma właściciela)'}</dd>
      <dt>Budynek</dt><dd>${h.b ? `${BUILD[h.b.t].label} poz. ${h.b.l}` : 'brak'}</dd>
      <dt>Myto</dt><dd>${h.owner && !own.npc ? tollOf(h) + ' monet' : 'brak'}</dd>
      ${now < (h.protect || 0) ? `<dt>Ochrona</dt><dd>do ${fmtTime(h.protect)}</dd>` : ''}
      <dt>Wpływ</dt><dd>${infRows(h)}</dd>
    </dl>`;
  }
  if (here && !h.blocked && h.owner !== ME) {
    const left = metersToCapture(h);
    html += now < (h.protect || 0) && h.owner
      ? `<div class="progress">Heks jest pod ochroną do ${fmtTime(h.protect)}. Teraz nie da się go wypierać.</div>`
      : `<div class="progress">Do zajęcia zostało ok. <b>${left} m</b> chodzenia po tym heksie${h.owner ? ' albo wygrany pojedynek' : ''}.</div>`;
  }
  const acts = [];
  if (!here && S.mode === 'test' && !h.blocked) acts.push('<button class="btn primary" data-act="walk">Idź tutaj</button>');
  if (here && h.owner === ME) {
    for (const [k, b] of Object.entries(BUILD)) {
      if (h.b && h.b.t !== k) continue;
      const l = (h.b ? h.b.l : 0) + 1;
      if (l > 3) continue;
      const cost = b.cost(l);
      acts.push(`<button class="btn" data-act="build" data-t="${k}" ${afford(cost) ? '' : 'disabled'} title="${b.desc}">
        ${h.b ? 'Ulepsz' : 'Zbuduj'} ${b.label} ${l} (${costText(cost)})</button>`);
    }
  }
  if (here && h.owner && h.owner !== ME && !h.blocked) {
    acts.push(`<button class="btn primary" data-act="duel">Wyzwij na pojedynek (stawka ${DUEL_STAKE})</button>`);
  }
  if (!here) acts.push('<button class="btn" data-act="back">Pokaż mój heks</button>');
  if (here && h.owner === ME) html += `<p class="muted">Targ: ${BUILD.targ.desc}. Wieża: ${BUILD.wieza.desc}.</p>`;
  if (here && h.owner && h.owner !== ME) html += '<p class="muted">Chodząc tu, powoli wypierasz właściciela. Pojedynek przejmuje heks od razu.</p>';
  // Podmieniamy kartę tylko przy zmianie treści, żeby przycisk nie znikał spod palca.
  const next = html + `<div class="actions">${acts.join('')}</div>`;
  if (el.dataset.html !== next) { el.innerHTML = next; el.dataset.html = next; }
}

function renderMenu() {
  $('modeGps').classList.toggle('on', S.mode === 'gps');
  $('modeTest').classList.toggle('on', S.mode === 'test');
  const st = S.stats, mine = Object.values(S.hexes).filter(h => h.owner === ME).length;
  $('stats').innerHTML = `<dl class="kv">
    <dt>Twoje heksy</dt><dd>${mine}</dd><dt>Przebyty dystans</dt><dd>${(st.meters / 1000).toFixed(2)} km</dd>
    <dt>Zdobyte łącznie</dt><dd>${st.captured}</dd><dt>Szlaki handlowe</dt><dd>${st.routes} (+${st.routeIncome} monet)</dd>
    <dt>Myto zapłacone</dt><dd>${st.tollPaid}</dd><dt>Myto zarobione</dt><dd>${st.tollEarned}</dd>
    <dt>Pojedynki</dt><dd>${st.duelsWon} wygrane, ${st.duelsLost} przegrane</dd></dl>`;
  $('diag').innerHTML = diagHtml();
  $('log').innerHTML =S.log.slice(0, 30).map(e => `<li><span class="muted">${fmtTime(e.t)}</span> ${e.msg}</li>`).join('') || '<li class="muted">pusto</li>';
}

let mapQueued = false;
function render() {
  renderInv(); renderCargo(); renderCard(); renderGps();
  if (!$('menu').hidden) renderMenu();
  if (mapReady && !mapQueued) { mapQueued = true; requestAnimationFrame(() => { mapQueued = false; renderMap(); }); }
}

function renderMap() {
  const hexes = [], buildings = [];
  for (const [id, h] of Object.entries(S.hexes)) {
    const t = TYPES[h.type || 'zabudowa'];
    let fill = '#000000', op = 0;
    if (h.blocked) { fill = '#495057'; op = 0.3; }
    else if (h.owner) { fill = owner(h.owner).color; op = 0.18 + 0.4 * Math.min(1, (h.inf[h.owner] || 0) / MAX_INF); }
    else if (h.type !== 'zabudowa') { fill = t.color; op = 0.14; }
    hexes.push({ type: 'Feature', properties: { id, fill, op, line: h.blocked ? '#495057' : t.color, w: h.owner === ME ? 2.4 : 0.7 },
      geometry: { type: 'Polygon', coordinates: [boundary(id)] } });
    if (h.b) {
      const [la, ln] = center(id);
      buildings.push({ type: 'Feature', properties: { label: (h.b.t === 'targ' ? 'T' : 'W') + h.b.l, color: owner(h.owner).color || '#495057' },
        geometry: { type: 'Point', coordinates: [ln, la] } });
    }
  }
  map.getSource('hexes').setData({ type: 'FeatureCollection', features: hexes });
  map.getSource('buildings').setData({ type: 'FeatureCollection', features: buildings });
  const pts = [], lines = [];
  if (S.pos) pts.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [S.pos[1], S.pos[0]] } });
  if (S.cargo && S.pos && Date.now() - S.cargo.since <= ROUTE_MAX_AGE) {
    const [la, ln] = center(S.cargo.from);
    lines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[ln, la], [S.pos[1], S.pos[0]]] } });
  }
  map.getSource('me').setData({ type: 'FeatureCollection', features: pts });
  map.getSource('cargo').setData({ type: 'FeatureCollection', features: lines });
  map.setFilter('hex-sel', ['==', ['get', 'id'], sel || S.cur || '']);
  renderWalkers();
}

let lastFollow = 0;
function follow(force) {
  if (!mapReady || !S.pos || !followOn) return;
  const now = Date.now();
  if (!force && now - lastFollow < 700) return;
  lastFollow = now;
  map.easeTo({ center: [S.pos[1], S.pos[0]], duration: force ? 0 : 600 });
}

function initMap() {
  const start = S.pos || DEFAULT_START;
  map = new maplibregl.Map({
    container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [start[1], start[0]], zoom: 16, attributionControl: { compact: true },
  });
  map.on('load', () => {
    const empty = { type: 'FeatureCollection', features: [] };
    for (const s of ['hexes', 'buildings', 'me', 'cargo', 'walkers', 'walker-heads']) map.addSource(s, { type: 'geojson', data: empty });
    map.addLayer({ id: 'hex-fill', type: 'fill', source: 'hexes', paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['get', 'op'] } });
    map.addLayer({ id: 'hex-line', type: 'line', source: 'hexes', paint: { 'line-color': ['get', 'line'], 'line-width': ['get', 'w'], 'line-opacity': 0.7 } });
    map.addLayer({ id: 'hex-sel', type: 'line', source: 'hexes', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#111', 'line-width': 3 } });
    map.addLayer({ id: 'cargo-line', type: 'line', source: 'cargo', paint: { 'line-color': '#e67700', 'line-width': 3, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'bld', type: 'circle', source: 'buildings', paint: { 'circle-radius': 10, 'circle-color': '#fff', 'circle-stroke-width': 3, 'circle-stroke-color': ['get', 'color'] } });
    map.addLayer({ id: 'bld-label', type: 'symbol', source: 'buildings', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-allow-overlap': true } });
    map.addLayer({ id: 'walker-line', type: 'line', source: 'walkers', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.75, 'line-dasharray': [1, 1.5] } });
    map.addLayer({ id: 'walker-dot', type: 'circle', source: 'walker-heads', paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
    map.addLayer({ id: 'walker-label', type: 'symbol', source: 'walker-heads', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top' },
      paint: { 'text-color': '#1d2129', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
    map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 8, 'circle-color': ME_INFO.color, 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
    mapReady = true;
    render(); follow(true);
  });
  map.on('click', e => {
    const id = h3.latLngToCell(e.lngLat.lat, e.lngLat.lng, RES);
    sel = S.hexes[id] && id !== S.cur ? id : null;
    render();
  });
  map.on('dragstart', () => { followOn = false; });
}

function bindUi() {
  $('card').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'walk') { const [la, ln] = center(sel); sel = null; walkTo(la, ln); }
    else if (act === 'back') { sel = null; followOn = true; follow(true); render(); }
    else if (act === 'build') build(b.dataset.t);
    else if (act === 'duel') openDuel();
  });
  $('recenter').onclick = () => { followOn = true; sel = null; follow(true); render(); };
  $('menuBtn').onclick = () => { $('menu').hidden = false; renderMenu(); };
  $('menuClose').onclick = () => { $('menu').hidden = true; };
  $('modeGps').onclick = () => { setMode('gps'); renderMenu(); };
  $('modeTest').onclick = () => { setMode('test'); renderMenu(); };
  $('reset').onclick = () => {
    if (!confirm('Usunąć cały postęp na tym urządzeniu?')) return;
    try { localStorage.removeItem(KEY); } catch (e) { /* nic */ }
    location.reload();
  };
  $('startGps').onclick = () => { $('start').hidden = true; setMode('gps'); };
  $('startTest').onclick = () => { $('start').hidden = true; setMode('test'); };
  $('dGo').onclick = startDuel;
  $('dCancel').onclick = () => { $('duel').hidden = true; };
  $('target').addEventListener('pointerdown', e => {
    e.stopPropagation();
    duel.score++; $('dScore').textContent = duel.score; hopTarget();
  });
  $('arena').addEventListener('pointerdown', () => {
    if (!duel.end || Date.now() > duel.end || !$('dIntro').hidden) return;
    duel.score = Math.max(0, duel.score - 1); $('dScore').textContent = duel.score;
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

function main() {
  bindUi();
  initMap();
  tick();
  if (!S.mode) $('start').hidden = false;
  else setMode(S.mode);
  setInterval(tick, 30e3);
  setInterval(stepWalkers, 1000);
  setInterval(renderCargo, 15e3);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
main();
