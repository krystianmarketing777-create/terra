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

// Strażnicy dzikich ziem: neutralni, nie atakują, nie pobierają myta, bronią się w pojedynkach.
const NPC = {
  'npc:zielen': { name: 'Borowi', color: '#8a7a55', npc: true, lore: 'leśne duchy pilnujące zieleni' },
  'npc:handel': { name: 'Gildia Kramarzy', color: '#8a7a55', npc: true, lore: 'kupcy, którzy nie oddadzą straganu bez walki' },
  'npc:kultura': { name: 'Strażnicy Pamięci', color: '#8a7a55', npc: true, lore: 'opiekunowie zabytków i murów' },
  'npc:transport': { name: 'Bractwo Dróżników', color: '#8a7a55', npc: true, lore: 'trzymają przystanki i rozstaje' },
  'npc:zabudowa': { name: 'Domowiki', color: '#8a7a55', npc: true, lore: 'duszki podwórek i kamienic' },
};
// Avatar gracza: zwierzak, kolor terenu i nick. Kolory gracza są chłodne, botów ciepłe, żeby się nie myliły.
const AVATARS = ['🦊', '🐺', '🦉', '🐻', '🦌', '🐗', '🦔', '🐿️', '🐸', '🐢', '🦅', '🐝', '🐱', '🐶', '🦄', '🐉'];
const PLAYER_COLORS = ['#1971c2', '#364fc7', '#1098ad', '#0ca678', '#2b8a3e', '#495057'];
const DEFAULT_PROFILE = { name: 'Ty', emoji: '🦊', color: '#1971c2' };
const meInfo = () => ({ ...DEFAULT_PROFILE, ...(S.profile || {}), lvl: levelOf(scoreOf(ME)) });
// Symulowani gracze: wyglądają jak ludzie z okolicy.
const BOT_NAMES = ['kasia_biega', 'Marek_z_Bielan', 'spacerowiczka', 'Ola.z.psem', 'tomek.rower', 'Bartek88', 'Zuza_w_parku',
  'pan_Zdzisiek', 'Iga.run', 'Kuba_Nocny', 'MamaNaSpacerze', 'Rysiek_Kroki', 'Wiktoria.K', 'ProstoZPracy', 'Hania_i_Burek', 'Krokomierz'];
const BOT_COLORS = ['#e03131', '#7048e8', '#f08c00', '#c2255c', '#862e9c', '#d9480f', '#a61e4d', '#5f3dc4'];
function owner(id) {
  if (id === ME) return meInfo();
  if (S.bots[id]) return { ...S.bots[id], lvl: levelOf(scoreOf(id)) };
  return NPC[id] || { name: '?', color: '#495057' };
}

// ---------- Punkty i ranking ----------
// Punkty: 10 za posiadany heks, 15 za poziom budynku, 20 za km, 10 za szlak, 25 za wygrany pojedynek.
let scoreCache = { t: 0, map: {} };
function scores() {
  const now = Date.now();
  if (now - scoreCache.t < 1500) return scoreCache.map;
  const m = {}, add = (id, k, v) => { (m[id] ??= { hexes: 0, buildings: 0, km: 0, routes: 0, duels: 0, total: 0 })[k] += v; };
  for (const id of [ME, ...Object.keys(S.bots)]) add(id, 'total', 0);
  for (const h of Object.values(S.hexes)) {
    if (!h.owner || !m[h.owner]) continue;
    add(h.owner, 'hexes', 1);
    add(h.owner, 'buildings', (h.bs || []).reduce((a, b) => a + b.l, 0));
  }
  add(ME, 'km', S.stats.meters / 1000); add(ME, 'routes', S.stats.routes); add(ME, 'duels', S.stats.duelsWon);
  for (const [id, b] of Object.entries(S.bots)) { add(id, 'km', b.km || 0); add(id, 'routes', b.routes || 0); }
  for (const s of Object.values(m)) s.total = Math.round(s.hexes * 10 + s.buildings * 15 + s.km * 20 + s.routes * 10 + s.duels * 25);
  scoreCache = { t: now, map: m };
  return m;
}
const scoreOf = id => scores()[id]?.total || 0;
const levelOf = p => Math.floor(Math.sqrt(p / 40)) + 1;
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
// Budynki: 2 miejsca na heks, poziomy 1-3. Część rodzajów można postawić tylko na pasującym typie terenu.
const lvl3 = l => (l === 3 ? { slawa: 10 } : {});
const BUILD = {
  targ: { label: 'Targ', letter: 'T', desc: 'produkcja x(1+poziom), myto +2 za poziom',
    cost: l => ({ monety: 20 * l, towary: 10 * l, ...lvl3(l) }) },
  wieza: { label: 'Wieża', letter: 'W', desc: 'przejmowanie wolniejsze 1+poziom razy, garnizon +4 za poziom',
    cost: l => ({ monety: 20 * l, drewno: 15 * l, ...lvl3(l) }) },
  magazyn: { label: 'Magazyn', letter: 'M', desc: 'magazyn mieści 24 h x(1+poziom), zdobywca zabiera 25% mniej za poziom',
    cost: l => ({ monety: 15 * l, drewno: 10 * l, ...lvl3(l) }) },
  tartak: { label: 'Tartak', letter: 'Tr', only: 'zielen', desc: '+1 drewno/h za poziom',
    cost: l => ({ monety: 15 * l, drewno: 10 * l, ...lvl3(l) }) },
  kantor: { label: 'Kantor', letter: 'K', only: 'handel', desc: 'myto +3 za poziom',
    cost: l => ({ monety: 20 * l, towary: 10 * l, ...lvl3(l) }) },
  galeria: { label: 'Galeria', letter: 'G', only: 'kultura', desc: '+1 sława/h za poziom, wpływ zanika o połowę wolniej',
    cost: l => ({ monety: 20 * l, towary: 5 * l, ...lvl3(l) }) },
  stajnia: { label: 'Stajnia', letter: 'St', only: 'transport', desc: 'szlak zaczynający się lub kończący tu +25% za poziom',
    cost: l => ({ monety: 15 * l, drewno: 5 * l, wozy: 1 * l, ...lvl3(l) }) },
};
const SLOTS = 2;
const SEAT_SHIELD = 7 * DAY;   // Siedziba jest nietykalna tylko przez pierwszy tydzień
const SEAT_DESC = '+3 monety/h prosto do skarbca, mocniejsza obrona. Gdy ją stracisz, przenosi się na Twój najsilniejszy heks';
const STARTER = { monety: 60, drewno: 15, towary: 10, slawa: 0, wozy: 2 };

// Pierwsze zadania: prowadzą przez grę i dają nagrody, żeby już po pierwszym spacerze coś mieć.
const QUESTS = [
  { title: 'Zajmij pierwszy heks', hint: 'Przejdź ok. 50 m po dowolnym heksie. Stanie się Twoją Siedzibą.',
    prog: s => [s.stats.captured, 1], reward: { drewno: 10, towary: 10 } },
  { title: 'Postaw pierwszy budynek', hint: 'Dotknij swojego heksu i wybierz budynek. Możesz to zrobić także później, w domu.',
    prog: s => [s.stats.built, 1], reward: { monety: 30 } },
  { title: 'Zajmij 5 heksów', hint: 'Idź przed siebie: każde ok. 50 m to nowy heks.',
    prog: s => [s.stats.captured, 5], reward: { monety: 20, drewno: 15, towary: 10 } },
  { title: 'Poprowadź szlak handlowy', hint: 'Z Twojego heksu jednego typu do Twojego heksu innego typu, min. 300 m.',
    prog: s => [s.stats.routes, 1], reward: { wozy: 3, monety: 20 } },
  { title: 'Wygraj pojedynek', hint: 'Przejdź przez cudzy heks (zwiad), a wyzwanie rozegrasz nawet z domu.',
    prog: s => [s.stats.duelsWon, 1], reward: { slawa: 10, monety: 20 } },
  { title: 'Zajmij 15 heksów', hint: 'Większe imperium to więcej surowców i myta.',
    prog: s => [s.stats.captured, 15], reward: { monety: 50, slawa: 10 } },
];

// ---------- Stan ----------
function fresh() {
  return {
    v: 1, mode: null, pos: null, cur: null,
    inv: { ...STARTER },
    hexes: {}, areas: [], cargo: null, bots: {},
    stats: { meters: 0, captured: 0, routes: 0, routeIncome: 0, tollPaid: 0, tollEarned: 0, duelsWon: 0, duelsLost: 0, built: 0 },
    lastTick: Date.now(), log: [], tune: 6, seat: null, seatShield: 0, profile: null,
    settings: { vibe: true, voice: false }, q: 0, tasks: [], lastLost: null,
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
// Migracja na rozpoznawanie terenu z kafli mapy: wszystkie heksy klasyfikujemy od nowa (właściciel zostaje).
if (S.tune < 3) {
  for (const h of Object.values(S.hexes)) h.pending = true;
  S.tune = 3;
}
// Migracja na zadania, Siedzibę i pakiet startowy (gracze z pierwszych testów też go dostają).
if (S.tune < 4) {
  S.settings ??= { vibe: true, voice: false };
  S.q ??= 0; S.tasks ??= []; S.lastLost ??= null; S.stats.built ??= 0;
  for (const [k, v] of Object.entries(STARTER)) S.inv[k] = (S.inv[k] || 0) + v;
  const mine = Object.values(S.hexes).filter(h => h.owner === 'ty').sort((a, b) => (b.inf.ty || 0) - (a.inf.ty || 0));
  if (mine.length && !mine.some(h => h.b?.t === 'siedziba')) mine[0].b = { t: 'siedziba', l: 1 };
  S.log.unshift({ t: Date.now(), msg: 'Pakiet startowy: surowce na pierwszy budynek' + (mine.length ? ', a Twój najmocniejszy heks jest teraz Siedzibą' : '') });
  S.tune = 4;
}
// Migracja na avatary i punkty: boty dostają zwierzaka, kilometry i ciepły kolor.
function migrateBots() {
  Object.values(S.bots).forEach((b, i) => {
    b.emoji ??= AVATARS[Math.floor(Math.random() * AVATARS.length)];
    b.km ??= 0.5 + Math.random() * 10;
    b.routes ??= Math.floor(Math.random() * 4);
    if (!BOT_COLORS.includes(b.color)) b.color = BOT_COLORS[i % BOT_COLORS.length];
    delete b.lvl;
  });
}
// Migracja na 2 miejsca budowy i Siedzibę jako oznaczenie heksu (z tygodniową ochroną).
if (S.tune < 5) {
  for (const [id, h] of Object.entries(S.hexes)) {
    if (h.b?.t === 'siedziba') { S.seat = id; S.seatShield = Date.now() + SEAT_SHIELD; }
    h.bs = h.b && h.b.t !== 'siedziba' ? [h.b] : [];
    delete h.b;
  }
  S.tune = 5;
}
if (S.tune < 6) { migrateBots(); S.profile ??= null; S.tune = 6; }
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

// ---------- Dane OSM (z kafli mapy OpenFreeMap) ----------
// Typ terenu czytamy z kafli wektorowych, które mapa i tak pobiera. Nie zależymy od przeciążonych serwerów Overpass.
function ensureArea(lat, lng) {
  if (S.areas.some(a => dist(a, [lat, lng]) < 700)) return;
  const mid = h3.latLngToCell(lat, lng, RES);
  const created = h3.gridDisk(mid, AREA_K).filter(c => !S.hexes[c]);
  for (const c of created) S.hexes[c] = { inf: {}, owner: null, bs: [], store: 0, type: 'zabudowa', blocked: false, pending: true };
  S.areas.push([lat, lng]);
  seedBots(created, mid);
  save(); render();
  classifyVisible();
}

const SRC = 'openmaptiles';
const GREEN_LANDCOVER = /^(grass|wood|farmland|wetland)$/;
const GREEN_LANDUSE = /^(park|cemetery|grass|recreation_ground|garden|playground|pitch|allotments|village_green)$/;
const SHOP_POI = /^(shop|grocery|convenience|supermarket|restaurant|cafe|fast_food|bar|pub|beer|ice_cream|bakery|butcher|clothing_store|hairdresser|pharmacy|bank|marketplace|alcohol_shop|jewelry|furniture|hardware|mobile_phone|books|gift|florist|shoes|optician|deli|confectionery|cosmetics|electronics|sports|toys|pet|stationery|wine|department_store|mall|beauty|chemist|kiosk)$/;
const CULTURE_POI = /^(museum|art_gallery|attraction|monument|memorial|castle|place_of_worship|theatre|library|cinema|historic|archaeological_site|ruins|fort|town_hall|viewpoint|religious|arts_centre)$/;
const TRANSPORT_POI = /^(bus|railway|tram|subway|ferry_terminal|bus_station|tram_stop|station|halt)$/;
const WATER = /^(river|lake|pond|basin|reservoir|ocean|sea|water)$/;

function bboxOf(geom) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = a => { if (typeof a[0] === 'number') { w = Math.min(w, a[0]); e = Math.max(e, a[0]); s = Math.min(s, a[1]); n = Math.max(n, a[1]); } else a.forEach(walk); };
  walk(geom.coordinates);
  return [w, s, e, n];
}
// Punkt w wielokącie GeoJSON (z dziurami), współrzędne [lng, lat].
function inRings(lng, lat, rings) {
  let inside = false;
  rings.forEach((ring, i) => {
    let hit = false;
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, ya] = ring[a], [xb, yb] = ring[b];
      if ((ya > lat) !== (yb > lat) && lng < (xb - xa) * (lat - ya) / (yb - ya) + xa) hit = !hit;
    }
    if (i === 0) inside = hit; else if (hit) inside = false;
  });
  return inside;
}
function areas(features) {
  const out = [];
  for (const f of features) {
    const g = f.geometry;
    if (g.type === 'Polygon') out.push({ bb: bboxOf(g), polys: [g.coordinates] });
    else if (g.type === 'MultiPolygon') out.push({ bb: bboxOf(g), polys: g.coordinates });
  }
  return out;
}
function covered(lng, lat, list) {
  for (const a of list) {
    if (lng < a.bb[0] || lng > a.bb[2] || lat < a.bb[1] || lat > a.bb[3]) continue;
    if (a.polys.some(p => inRings(lng, lat, p))) return true;
  }
  return false;
}
// 7 punktów próbkowania: środek i 6 punktów w połowie drogi do wierzchołków.
function samples(id) {
  const [la, ln] = center(id);
  return [[ln, la], ...boundary(id).slice(0, 6).map(([x, y]) => [ln + (x - ln) * 0.6, la + (y - la) * 0.6])];
}

function classifyVisible() {
  if (!mapReady || map.getZoom() < 14) return;
  const b = map.getBounds();
  const cells = Object.keys(S.hexes).filter(c => {
    if (!S.hexes[c].pending) return false;
    const [la, ln] = center(c);
    return b.contains([ln, la]);
  });
  if (!cells.length) return;
  const q = l => map.querySourceFeatures(SRC, { sourceLayer: l });
  const poi = q('poi');
  if (!map.areTilesLoaded()) return; // kafle jeszcze się wczytują, spróbujemy przy następnym 'idle'
  const green = areas([
    ...q('landcover').filter(f => GREEN_LANDCOVER.test(f.properties.class)),
    ...q('landuse').filter(f => GREEN_LANDUSE.test(f.properties.class)),
    ...q('park'),
  ]);
  const water = areas(q('water').filter(f => WATER.test(f.properties.class || 'water')));
  const cellSet = new Set(cells), score = {}, blocked = new Set();
  const add = (c, t, v) => { if (!cellSet.has(c)) return; (score[c] ??= {})[t] = (score[c][t] || 0) + v; };
  const seen = new Set();
  for (const f of poi) {
    if (f.geometry.type !== 'Point') continue;
    const [ln, la] = f.geometry.coordinates, cls = f.properties.class || '', sub = f.properties.subclass || '';
    const key = `${cls}/${sub}/${ln.toFixed(5)}/${la.toFixed(5)}`;
    if (seen.has(key)) continue; // ten sam punkt bywa w kilku kaflach
    seen.add(key);
    const c = h3.latLngToCell(la, ln, RES);
    if (TRANSPORT_POI.test(cls) || /^(bus_stop|tram_stop|station|halt|subway_entrance)$/.test(sub)) add(c, 'transport', 2);
    else if (CULTURE_POI.test(cls)) add(c, 'kultura', sub === 'artwork' ? 0.5 : 2.5);
    else if (SHOP_POI.test(cls)) add(c, 'handel', 1);
  }
  for (const f of q('transportation')) {
    const p = f.properties;
    if (p.brunnel === 'tunnel' || p.brunnel === 'bridge') continue;
    if (!(p.class === 'motorway' || (p.class === 'rail' && (!p.subclass || p.subclass === 'rail')))) continue;
    const g = f.geometry, lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) markLine(line.map(([x, y]) => [y, x]), blocked, cellSet);
  }
  for (const c of cells) {
    const pts = samples(c);
    const g = pts.filter(([x, y]) => covered(x, y, green)).length;
    if (g >= 3) add(c, 'zielen', 1 + g / 2);
    const w = pts.filter(([x, y]) => covered(x, y, water)).length;
    if (w >= 5) blocked.add(c);
    let type = 'zabudowa', best = 1;
    for (const [k, v] of Object.entries(score[c] || {})) if (v > best) { best = v; type = k; }
    const h = S.hexes[c];
    h.type = type;
    // Strażnik dzikiej ziemi zawsze odpowiada typowi terenu.
    const npc = 'npc:' + type;
    if (NPC[h.owner] && h.owner !== npc) { h.inf[npc] = h.inf[h.owner]; delete h.inf[h.owner]; h.owner = npc; }
    h.blocked = blocked.has(c);
    h.pending = false;
    if (h.blocked) { h.owner = null; h.inf = {}; h.bs = []; }
  }
  save(); render();
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
    emoji: AVATARS[Math.floor(Math.random() * AVATARS.length)], km: 0.5 + Math.random() * 10, routes: Math.floor(Math.random() * 4) };
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
      if (Math.random() < 0.25) h.bs = [{ t: Math.random() < 0.5 ? 'targ' : 'wieza', l: Math.random() < 0.3 ? 2 : 1 }];
    }
  }
}

// ---------- Ekonomia ----------
const resOf = h => TYPES[h.type || 'zabudowa'].res;
const lvl = (h, t) => (h.bs || []).find(b => b.t === t)?.l || 0;
const seatActive = () => !!S.seat && S.hexes[S.seat]?.owner === ME;
const isSeat = h => !!S.seat && S.hexes[S.seat] === h;
const seatShielded = h => isSeat(h) && Date.now() < (S.seatShield || 0);
const defense = h => 1 + lvl(h, 'wieza') + (isSeat(h) ? 2 : 0);
const boosted = h => Date.now() < (h.boost || 0);
const prodRate = h => ((h.type === 'zabudowa' ? 1 : 2) + lvl(h, 'tartak') + lvl(h, 'galeria')) * (1 + lvl(h, 'targ')) * (boosted(h) ? 2 : 1);
const storeCap = h => prodRate(h) * 24 * (1 + lvl(h, 'magazyn'));
const tollOf = h => 2 + 2 * lvl(h, 'targ') + 3 * lvl(h, 'kantor');
const garrison = h => (NPC[h.owner] ? 8 : 12) + 4 * lvl(h, 'wieza') + (isSeat(h) ? 8 : 0) + Math.floor(Math.random() * 5);
const bldText = h => (h.bs || []).map(b => `${BUILD[b.t].label} ${b.l}`).join(', ');
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
  if (h.bs?.length) {
    for (const b of h.bs) b.l -= 1;
    const gone = h.bs.filter(b => b.l <= 0).map(b => BUILD[b.t].label);
    h.bs = h.bs.filter(b => b.l > 0);
    buildingNote = (h.bs.length ? `, przejęte budynki: ${bldText(h)}` : '') + (gone.length ? `, zburzone: ${gone.join(', ')}` : '');
  }
  const loot = Math.floor((h.store || 0) * Math.max(0, 1 - 0.25 * lvl(h, 'magazyn')));
  h.store = 0;
  h.owner = to;
  h.protect = to ? now + PROTECT : 0;
  if (to === ME) {
    S.inv[resOf(h)] += loot;
    S.stats.captured++;
    walk.captured++;
    const label = TYPES[h.type].label;
    if (!seatActive()) {
      S.seat = id;
      if (!S.seatShield) S.seatShield = now + SEAT_SHIELD;
      buildingNote = `, to Twoja Siedziba${now < S.seatShield ? ` (nietykalna do ${fmtDay(S.seatShield)})` : ''}`;
      flash('Twoja Siedziba!', label);
    } else flash('Heks zdobyty!', label);
    buzz('capture');
    say(`Heks zdobyty. ${label}.`);
    log(`Heks zdobyty (${label})${loot ? `, łup +${loot} ${RESOURCES[resOf(h)].toLowerCase()}` : ''}${buildingNote}`);
    if (S.lastLost?.id === id) S.lastLost = null;
    maybeTask(id, h);
    if (id === S.cur) route(id, h, now);
  } else if (from === ME) {
    if (S.seat === id) relocateSeat();
    const d = direction(id);
    const where = d ? `: ${d.arrow} ${d.m} m, ${d.name}` : '';
    S.lastLost = { id, t: now };
    buzz('lost');
    notify('Heks utracony', `${to ? owner(to).name + ' przejmuje Twój teren' : 'Wpływ wygasł'}${d ? `: ${d.m} m, ${d.name}` : ''}`);
    say(`Utracono heks${to ? ' na rzecz ' + owner(to).name : ''}. ${d ? d.m + ' metrów, ' + d.name : ''}.`);
    log(`Heks utracony${to ? ', przejmuje go ' + owner(to).name : ', wpływ wygasł'}${where}${buildingNote}`, true);
  }
}

// Siedziba po utracie przenosi się na Twój najsilniejszy heks (bez nowej ochrony), a gdy nie masz żadnego, upada.
function relocateSeat() {
  const old = S.seat;
  const next = Object.keys(S.hexes).filter(k => k !== old && S.hexes[k].owner === ME)
    .sort((a, b) => (S.hexes[b].inf[ME] || 0) - (S.hexes[a].inf[ME] || 0))[0];
  S.seat = next || null;
  if (next) log(`Siedziba przeniesiona na Twój najsilniejszy heks (${TYPES[S.hexes[next].type].label})`, true);
  else log('Siedziba upadła. Następny zdobyty heks stanie się nową Siedzibą.', true);
}
const fmtDay = t => new Date(t).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

// ---------- Kierunek ----------
const DIRS = [['↑', 'północ'], ['↗', 'północny wschód'], ['→', 'wschód'], ['↘', 'południowy wschód'],
  ['↓', 'południe'], ['↙', 'południowy zachód'], ['←', 'zachód'], ['↖', 'północny zachód']];
function bearing(a, b) {
  const r = Math.PI / 180, dl = (b[1] - a[1]) * r;
  const y = Math.sin(dl) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function direction(id) {
  if (!S.pos) return null;
  const c = center(id), [arrow, name] = DIRS[Math.round(bearing(S.pos, c) / 45) % 8];
  return { arrow, name, m: Math.round(dist(S.pos, c) / 10) * 10 };
}

// ---------- Odczucia: wibracja, głos, błysk ----------
const BUZZ = { capture: [70, 50, 70, 50, 160], lost: [450, 120, 450], toll: [35], route: [100, 60, 100, 60, 100], quest: [60, 40, 60, 40, 60, 40, 250], task: [40, 40, 40] };
function buzz(kind) {
  if (!S.settings?.vibe) return;
  try { navigator.vibrate?.(BUZZ[kind]); } catch (e) { /* brak wibracji */ }
}
function say(text) {
  if (!S.settings?.voice || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pl-PL';
  speechSynthesis.speak(u);
}
let flashTimer = null;
function flash(title, sub) {
  const el = $('flash');
  el.innerHTML = `<b>${title}</b>${sub ? `<span>${sub}</span>` : ''}`;
  el.hidden = false;
  el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 1800);
  pocketEvent(title + (sub ? ' · ' + sub : ''));
  notify(title, sub);
}

// ---------- Zadania ----------
function checkQuests() {
  let q = QUESTS[S.q];
  while (q) {
    const [have, need] = q.prog(S);
    if (have < need) break;
    for (const [k, v] of Object.entries(q.reward)) S.inv[k] = (S.inv[k] || 0) + v;
    S.q++;
    buzz('quest');
    flash('Zadanie wykonane!', q.title);
    say(`Zadanie wykonane: ${q.title}.`);
    log(`Zadanie wykonane: ${q.title}. Nagroda: ${costText(q.reward)}`, false);
    q = QUESTS[S.q];
  }
}

// Zadania dodatkowe: zdjęcie miejsca i udostępnienie. Nieobowiązkowe, ważne 24 h, można je zrobić w domu.
function maybeTask(id, h) {
  const now = Date.now();
  S.tasks = (S.tasks || []).filter(t => now < t.until && S.hexes[t.id]?.owner === ME);
  if (h.type === 'zabudowa' || S.tasks.length >= 3 || now - (S.lastTaskAt || 0) < 15 * 60e3 || Math.random() > 0.4) return;
  S.tasks.push({ id, until: now + DAY });
  S.lastTaskAt = now;
  buzz('task');
  log(`Zadanie dodatkowe: zdjęcie tego miejsca (${TYPES[h.type].label}) da produkcję x2 przez 24 h. Możesz je zrobić później.`, true);
}
let photoFor = null;
function startPhoto(id) { photoFor = id; $('photoInput').value = ''; $('photoInput').click(); }
async function onPhoto(file) {
  const id = photoFor, h = S.hexes[id];
  if (!file || !h) return;
  const text = `Ten kawałek okolicy (${TYPES[h.type].label.toLowerCase()}) jest mój w grze Terra. Dołącz i odbij go!`;
  const url = location.origin + location.pathname;
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Terra', text, url });
    else if (navigator.share) await navigator.share({ title: 'Terra', text, url });
  } catch (e) {
    if (e.name === 'AbortError') { toast('Udostępnianie anulowane. Zadanie czeka do jutra.'); return; }
  }
  h.boost = Date.now() + DAY;
  h.inf[ME] = Math.min(MAX_INF, (h.inf[ME] || 0) + 20);
  S.tasks = S.tasks.filter(t => t.id !== id);
  buzz('quest');
  flash('Dzięki za zdjęcie!', 'Produkcja x2 przez 24 h');
  log(`Zadanie wykonane: zdjęcie (${TYPES[h.type].label}). Produkcja x2 do ${fmtTime(h.boost)} jutro, +20 wpływu`, false);
  save(); render();
}

function tick() {
  const now = Date.now(), dt = Math.min(now - S.lastTick, 7 * DAY);
  if (dt < 1000) return;
  S.lastTick = now;
  const hours = dt / H, f = Math.pow(DECAY_PER_DAY, dt / DAY);
  for (const [id, h] of Object.entries(S.hexes)) {
    if (h.blocked) continue;
    const fh = lvl(h, 'galeria') ? Math.sqrt(f) : f;
    for (const k in h.inf) { h.inf[k] *= fh; if (h.inf[k] < 0.5) delete h.inf[k]; }
    if (isSeat(h) && h.owner === ME) { if (seatShielded(h)) h.inf[ME] = Math.max(h.inf[ME] || 0, 30); S.inv.monety += 3 * hours; }
    if (h.owner) h.store = Math.min(storeCap(h), (h.store || 0) + prodRate(h) * hours);
    updateOwner(id, h, 'decay');
  }
  botActivity(hours);
  classifyVisible();
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
    // Rywale naciskają na heksy przy swojej granicy (poza Siedzibą).
    if (now < (h.protect || 0) || seatShielded(h)) continue;
    const enemy = neighborBot(id);
    if (!enemy) continue;
    const g = 0.6 * h0 / defense(h);
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
    if (S.bots[w.bot]) S.bots[w.bot].km = (S.bots[w.bot].km || 0) + step / 1000;
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
  if (h.owner === ME && seatShielded(h)) return;
  // Na Twoim terenie boty wypierają wolniej, żeby nacisk był odczuwalny, ale nie przytłaczający.
  const k = h.owner === ME ? 0.5 : 1;
  if (h.owner) h.inf[h.owner] = Math.max(0, (h.inf[h.owner] || 0) - k * g / defense(h));
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
  if (meters > 0) { S.stats.meters += meters; walk.meters += meters; if (S.cargo) S.cargo.m += meters; }
  if (c !== S.cur) { S.cur = c; if (h) onEnter(c, h); }
  if (h && meters > 0 && !h.blocked) gain(c, h, meters / M_PER_POINT);
  save(); render(); follow();
}

// Ile metrów trzeba przejść po heksie, żeby go zająć (uwzględnia wypieranie właściciela i Wieżę).
function metersToCapture(h) {
  const mine = h.inf[ME] || 0;
  let pts = Math.max(0, CAPTURE - mine);
  if (h.owner && h.owner !== ME) {
    const other = h.inf[h.owner] || 0, k = 1 + 1 / defense(h);
    pts = Math.max(pts, (other - mine) / k + 0.5);
  }
  return Math.max(5, Math.ceil(pts * M_PER_POINT / 5) * 5);
}

function gain(id, h, g) {
  if (h.owner && h.owner !== ME) {
    if (Date.now() < (h.protect || 0)) return;
    h.inf[h.owner] = Math.max(0, (h.inf[h.owner] || 0) - g / defense(h));
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
    return;
  }
  // Zwiad: po przejściu przez cudzy heks możesz go wyzwać na pojedynek przez 12 h, także z domu.
  if (h.owner) h.scout = now + 12 * H;
  if (isBot(h.owner) && (!h.tollAt || now - h.tollAt > DAY)) {
    const paid = Math.min(S.inv.monety, tollOf(h));
    S.inv.monety -= paid; S.stats.tollPaid += paid; h.tollAt = now;
    if (paid > 0) { buzz('toll'); toast(`Myto dla: ${owner(h.owner).name}, -${paid} monet`); }
  }
}

// Zbieranie z daleka: połowa magazynu, reszta przepada. Wejście na heks daje całość.
function collectRemote(id) {
  const h = S.hexes[id];
  if (!h || h.owner !== ME) return;
  const amt = Math.floor((h.store || 0) / 2);
  if (amt < 1) return;
  S.inv[resOf(h)] += amt; h.store = 0;
  toast(`Zebrano zdalnie +${amt} ${RESOURCES[resOf(h)].toLowerCase()} (połowa magazynu)`);
  save(); render();
}

// Szlak handlowy: ładunek z heksu jednego typu, dostawa do własnego heksu innego typu.
function route(id, h, now) {
  if (h.type === 'zabudowa') return;
  const res = resOf(h), c = S.cargo;
  if (c && now - c.since <= ROUTE_MAX_AGE && c.res !== res) {
    const straight = dist(center(c.from), center(id));
    if (straight >= ROUTE_MIN_DIST) {
      const stable = lvl(S.hexes[c.from] || {}, 'stajnia') + lvl(h, 'stajnia');
      let pay = Math.round((c.m / 1000 * 30 + straight / 1000 * 20) * (1 + 0.25 * stable)), bonus = stable ? ` (stajnia +${25 * stable}%)` : '';
      if (S.inv.wozy >= 1) { S.inv.wozy--; pay = Math.round(pay * 1.5); bonus = ' (wóz x1,5)'; }
      S.inv.monety += pay; S.stats.routes++; S.stats.routeIncome += pay;
      log(`Szlak handlowy ${RESOURCES[c.res]} → ${RESOURCES[res]}: ${Math.round(c.m)} m, +${pay} monet${bonus}`, false);
      buzz('route');
      flash(`Szlak handlowy +${pay}`, `${RESOURCES[c.res]} → ${RESOURCES[res]}`);
      say(`Szlak handlowy. Plus ${pay} monet.`);
      S.cargo = { from: id, res, since: now, m: 0 };
      return;
    }
  }
  if (!c || now - c.since > ROUTE_MAX_AGE) {
    S.cargo = { from: id, res, since: now, m: 0 };
    toast(`Karawana załadowana (${RESOURCES[res].toLowerCase()}). Zanieś do swojego heksu innego typu, min. 300 m dalej, w 60 min.`);
  }
}

// ---------- Aplikacja Android (Capacitor) ----------
// W aplikacji GPS działa przez wtyczkę w tle: spacer liczy się przy wygaszonym ekranie, a Android pokazuje stałe powiadomienie.
const CAP = window.Capacitor;
const NATIVE = !!CAP?.isNativePlatform?.();
let bgWatcher = null;
async function nativeStartGps() {
  try { await CAP.nativePromise('LocalNotifications', 'requestPermissions', {}); } catch (e) { /* bez powiadomień też zadziała */ }
  bgWatcher = CAP.nativeCallback('BackgroundGeolocation', 'addWatcher', {
    backgroundTitle: 'Terra: spacer w toku',
    backgroundMessage: 'Liczę Twój spacer i zajmuję teren. Dotknij, żeby wrócić do gry.',
    requestPermissions: true, stale: false, distanceFilter: 5,
  }, (loc, err) => {
    if (err) {
      setStatus(err.code === 'NOT_AUTHORIZED' ? 'Brak zgody na lokalizację. Włącz ją w ustawieniach aplikacji Terra.' : 'GPS: ' + (err.message || err));
      return;
    }
    if (!loc) return;
    onFix({ coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy ?? 20 }, timestamp: loc.time || Date.now() });
  });
}
function nativeStopGps() {
  if (bgWatcher) { CAP.nativePromise('BackgroundGeolocation', 'removeWatcher', { id: bgWatcher }).catch(() => {}); bgWatcher = null; }
}
let notifId = 1;
// Powiadomienie systemowe, gdy aplikacja jest w tle (ekran wygaszony albo inna aplikacja na wierzchu).
function notify(title, body) {
  if (!NATIVE || !document.hidden) return;
  CAP.nativePromise('LocalNotifications', 'schedule', { notifications: [{ id: notifId++, title, body: body || '' }] }).catch(() => {});
}

// GPS
let watchId = null, lastFix = null;
function setMode(m) {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (NATIVE) nativeStopGps();
  clearInterval(walkTimer);
  S.mode = m;
  if (m === 'gps' && NATIVE) {
    lastFix = null;
    setStatus('Szukam sygnału GPS…');
    nativeStartGps();
  } else if (m === 'gps') {
    if (!navigator.geolocation) { toast('Ta przeglądarka nie udostępnia GPS.'); S.mode = 'test'; }
    else {
      lastFix = null;
      setStatus('Szukam sygnału GPS…');
      watchId = navigator.geolocation.watchPosition(onFix, err => setStatus('GPS: ' + err.message),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
      keepAwake(true); // w przeglądarce GPS działa tylko przy włączonym ekranie
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
// Budować można na każdym swoim heksie, także z domu.
function canBuild(h, t) {
  const B = BUILD[t];
  if (!h || h.owner !== ME || !B || (B.only && B.only !== h.type)) return null;
  const ex = (h.bs || []).find(b => b.t === t);
  if (!ex && (h.bs || []).length >= SLOTS) return null;
  const l = (ex ? ex.l : 0) + 1;
  return l > 3 ? null : { l, ex, cost: B.cost(l) };
}
function build(t, id) {
  const h = S.hexes[id], c = canBuild(h, t);
  if (!c) return;
  if (!afford(c.cost)) { toast('Brakuje surowców: ' + costText(c.cost)); return; }
  for (const [k, v] of Object.entries(c.cost)) S.inv[k] -= v;
  const l = c.l;
  if (c.ex) c.ex.l = l; else (h.bs ??= []).push({ t, l });
  S.stats.built++;
  buzz('capture');
  flash(`${BUILD[t].label} poz. ${l}`, 'zbudowano');
  log(`Zbudowano: ${BUILD[t].label} poz. ${l}`, false);
  save(); render();
}

// ---------- Pojedynek ----------
const duel = { id: null, score: 0, ghost: 0, end: 0, timer: null, hop: null };
const $ = id => document.getElementById(id);
const canDuel = (id, h) => !!(h && h.owner && h.owner !== ME && !h.blocked && (id === S.cur || Date.now() < (h.scout || 0)));
function openDuel(id) {
  const h = S.hexes[id], now = Date.now();
  if (!canDuel(id, h)) return;
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
    log(`Pojedynek wygrany ${duel.score}:${duel.ghost} z: ${owner(defender).name}, +${DUEL_STAKE} monet`, false);
    updateOwner(duel.id, h, 'duel');
  } else {
    h.duelCd = now + H; S.stats.duelsLost++;
    log(`Pojedynek przegrany ${duel.score}:${duel.ghost}, stawka przepada`);
  }
  $('duel').hidden = true;
  save(); render();
}

// ---------- Interfejs ----------
let map, mapReady = false, followOn = true, sel = null, meMarker = null;
// Znacznik gracza na mapie: zwierzak w kółku w kolorze terenu i nick z poziomem.
function avatarEl() {
  const el = document.createElement('div');
  el.className = 'avatar-pin';
  el.innerHTML = '<span class="face"></span><span class="tag"></span>';
  updateAvatarEl(el);
  return el;
}
function updateAvatarEl(el) {
  const p = meInfo(), key = `${p.emoji}|${p.color}|${p.name}|${p.lvl}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.querySelector('.face').textContent = p.emoji;
  el.querySelector('.face').style.borderColor = p.color;
  el.querySelector('.tag').textContent = `${p.name} · ${p.lvl}`;
}
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
  const p = scoreOf(ME);
  const html = `<span class="chip pts" data-open="rank">★ <b>${p}</b> pkt · poz. ${levelOf(p)}</span>` + Object.entries(RESOURCES)
    .map(([k, label]) => `<span class="chip">${label} <b>${Math.floor(S.inv[k])}</b></span>`).join('');
  if ($('inv').dataset.html !== html) { $('inv').innerHTML = html; $('inv').dataset.html = html; }
}

// ---------- Avatar ----------
let avDraft = null;
function openAvatar() {
  avDraft = { ...DEFAULT_PROFILE, ...(S.profile || {}) };
  if (!S.profile) avDraft.name = '';
  $('avName').value = avDraft.name;
  $('avEmojis').innerHTML = AVATARS.map(e => `<button data-emoji="${e}">${e}</button>`).join('');
  $('avColors').innerHTML = PLAYER_COLORS.map(c => `<button data-color="${c}" style="background:${c}" aria-label="kolor"></button>`).join('');
  renderAvatarPreview();
  $('avatar').hidden = false;
}
function renderAvatarPreview() {
  $('avPrev').textContent = avDraft.emoji;
  $('avPrev').style.borderColor = avDraft.color;
  $('avPrevName').textContent = avDraft.name || 'Twój nick';
  for (const b of $('avEmojis').children) b.classList.toggle('on', b.dataset.emoji === avDraft.emoji);
  for (const b of $('avColors').children) b.classList.toggle('on', b.dataset.color === avDraft.color);
}
function saveAvatar() {
  const name = $('avName').value.trim().replace(/\s+/g, '_').slice(0, 16);
  if (name.length < 3) { toast('Nick musi mieć co najmniej 3 znaki.'); return; }
  if (Object.values(S.bots).some(b => b.name.toLowerCase() === name.toLowerCase())) { toast('Ten nick jest już zajęty w Twojej okolicy.'); return; }
  S.profile = { name, emoji: avDraft.emoji, color: avDraft.color };
  scoreCache.t = 0;
  $('avatar').hidden = true;
  buzz('quest');
  flash(`${avDraft.emoji} ${name}`, 'gotowy do gry');
  save(); render();
}

// ---------- Ranking okolicy ----------
function renderRank() {
  const sc = scores();
  const rows = Object.entries(sc).map(([id, v]) => ({ id, ...v, o: owner(id) })).sort((a, b) => b.total - a.total);
  $('rankList').innerHTML = rows.map((r, i) => `<li class="${r.id === ME ? 'me' : ''}">
    <span class="pos">${i + 1}</span><span class="face" style="border-color:${r.o.color}">${r.o.emoji || '🙂'}</span>
    <span class="who"><b>${r.o.name}${r.id === ME ? ' (Ty)' : ''}</b><span>poz. ${levelOf(r.total)} · ${r.hexes} heksów · ${r.km.toFixed(1)} km</span></span>
    <span class="pts">${r.total}</span></li>`).join('');
  const m = sc[ME], pos = rows.findIndex(r => r.id === ME) + 1;
  $('myPoints').innerHTML = `<p>Miejsce <b>${pos}</b> z ${rows.length}.${pos > 1 ? ` Do miejsca wyżej brakuje <b>${rows[pos - 2].total - m.total + 1}</b> pkt.` : ' Prowadzisz w okolicy!'}</p>
    <dl class="kv"><dt>Heksy</dt><dd>${m.hexes} x 10 = ${m.hexes * 10}</dd><dt>Budynki</dt><dd>${m.buildings} poz. x 15 = ${m.buildings * 15}</dd>
    <dt>Spacer</dt><dd>${m.km.toFixed(2)} km x 20 = ${Math.round(m.km * 20)}</dd><dt>Szlaki</dt><dd>${m.routes} x 10 = ${m.routes * 10}</dd>
    <dt>Pojedynki</dt><dd>${m.duels} x 25 = ${m.duels * 25}</dd></dl>
    <p class="muted">Na razie inni gracze w rankingu są symulowani. Prawdziwy ranking ruszy razem z serwerem gry.</p>`;
}
function openRank() { scoreCache.t = 0; renderRank(); $('rank').hidden = false; }

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
  let html = `<div class="card-title"><span class="dot" style="background:${t.color}"></span>${h.blocked ? 'Teren wyłączony' : h.pending ? 'Rozpoznaję teren z mapy…' : t.label}
    <span class="muted">${here ? '· tu jesteś' : '· podgląd'}</span></div>`;
  if (h.blocked) {
    html += '<p class="muted">Woda, tory albo autostrada. Tu nie da się zajmować terenu.</p>';
  } else {
    html += `<dl class="kv">
      <dt>Właściciel</dt><dd>${ownLabel}</dd>
      <dt>Produkuje</dt><dd>${prodRate(h)}/h ${RESOURCES[t.res].toLowerCase()}${h.owner ? `, w magazynie ${Math.floor(h.store || 0)}` : ' (gdy ma właściciela)'}</dd>
      <dt>Budynki</dt><dd>${bldText(h) || 'brak'} <span class="muted">(${(h.bs || []).length}/${SLOTS} miejsc)</span></dd>
      ${isSeat(h) ? `<dt>Siedziba</dt><dd>${seatShielded(h) ? `nietykalna do ${fmtDay(S.seatShield)}` : 'bez ochrony, broni się mocniej'}</dd>` : ''}
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
  const task = (S.tasks || []).find(x => x.id === id && now < x.until);
  if (task && h.owner === ME) {
    html += `<div class="progress task">Zadanie dodatkowe: zrób zdjęcie tego miejsca i udostępnij je. Nagroda: produkcja x2 przez 24 h i +20 wpływu. Ważne do ${fmtTime(task.until)} jutro.
      <div class="actions"><button class="btn primary" data-act="photo">Zrób zdjęcie i udostępnij</button></div></div>`;
  }
  if (boosted(h)) html += `<p class="muted">Produkcja x2 do ${fmtTime(h.boost)}.</p>`;
  const acts = [];
  if (!here && S.mode === 'test' && !h.blocked) acts.push('<button class="btn primary" data-act="walk">Idź tutaj</button>');
  if (h.owner === ME) {
    const rows = [];
    for (const [k, b] of Object.entries(BUILD)) {
      const c = canBuild(h, k);
      if (!c) continue;
      rows.push(`<div class="brow"><div><b>${c.ex ? 'Ulepsz' : 'Zbuduj'}: ${b.label} ${c.l}</b><span class="muted">${b.desc}${b.only ? ` (tylko ${TYPES[b.only].label.toLowerCase()})` : ''}</span></div>
        <button class="btn" data-act="build" data-t="${k}" ${afford(c.cost) ? '' : 'disabled'}>${costText(c.cost)}</button></div>`);
    }
    if (rows.length) html += `<h4 class="bhead">Budowa <span class="muted">(możesz też z domu)</span></h4><div class="blist">${rows.join('')}</div>`;
    else html += '<p class="muted">Oba miejsca zajęte, a budynki mają maksymalny poziom.</p>';
    if (!here && Math.floor((h.store || 0) / 2) >= 1) acts.push(`<button class="btn" data-act="collect">Zbierz zdalnie ${Math.floor(h.store / 2)} (połowa)</button>`);
  }
  if (canDuel(id, h)) {
    acts.push(`<button class="btn primary" data-act="duel">Wyzwij na pojedynek (stawka ${DUEL_STAKE})</button>`);
  }
  if (!here) acts.push('<button class="btn" data-act="back">Pokaż mój heks</button>');
  if (h.owner === ME && isSeat(h)) html += `<p class="muted">Siedziba: ${SEAT_DESC}.</p>`;
  if (here && h.owner && h.owner !== ME) html += '<p class="muted">Chodząc tu, powoli wypierasz właściciela. Przejście daje też zwiad: przez 12 h wyzwiesz ten heks na pojedynek nawet z domu.</p>';
  if (!here && h.owner && h.owner !== ME && !canDuel(id, h)) html += '<p class="muted">Przejdź przez ten heks, żeby zdobyć zwiad i móc go wyzwać.</p>';
  // Podmieniamy kartę tylko przy zmianie treści, żeby przycisk nie znikał spod palca.
  const next = html + `<div class="actions">${acts.join('')}</div>`;
  if (el.dataset.html !== next) { el.innerHTML = next; el.dataset.html = next; }
}

function renderMenu() {
  $('modeGps').classList.toggle('on', S.mode === 'gps');
  $('modeTest').classList.toggle('on', S.mode === 'test');
  $('setVibe').checked = !!S.settings.vibe;
  $('setVoice').checked = !!S.settings.voice;
  const st = S.stats, mine = Object.values(S.hexes).filter(h => h.owner === ME).length;
  $('stats').innerHTML = `<dl class="kv">
    <dt>Twoje heksy</dt><dd>${mine}</dd><dt>Przebyty dystans</dt><dd>${(st.meters / 1000).toFixed(2)} km</dd>
    <dt>Zdobyte łącznie</dt><dd>${st.captured}</dd><dt>Szlaki handlowe</dt><dd>${st.routes} (+${st.routeIncome} monet)</dd>
    <dt>Myto zapłacone</dt><dd>${st.tollPaid}</dd><dt>Myto zarobione</dt><dd>${st.tollEarned}</dd>
    <dt>Pojedynki</dt><dd>${st.duelsWon} wygrane, ${st.duelsLost} przegrane</dd><dt>Budynki postawione</dt><dd>${st.built}</dd></dl>`;
  $('diag').innerHTML = diagHtml();
  $('log').innerHTML =S.log.slice(0, 30).map(e => `<li><span class="muted">${fmtTime(e.t)}</span> ${e.msg}</li>`).join('') || '<li class="muted">pusto</li>';
}

function renderChips() {
  const out = [], now = Date.now(), q = QUESTS[S.q];
  if (q) {
    const [have, need] = q.prog(S);
    out.push(`<button class="qchip" data-chip="quest"><b>Zadanie:</b> ${q.title} (${Math.min(have, need)}/${need})</button>`);
  }
  const L = S.lastLost;
  if (L && (now - L.t > 2 * H || !S.hexes[L.id] || S.hexes[L.id].owner === ME)) S.lastLost = null;
  if (S.lastLost) {
    const d = direction(S.lastLost.id);
    if (d) out.push(`<button class="qchip lost" data-chip="lost">${d.arrow} Odbij heks: ${d.m} m, ${d.name}</button>`);
  }
  const tasks = (S.tasks || []).filter(t => now < t.until && S.hexes[t.id]?.owner === ME);
  if (tasks.length) out.push(`<button class="qchip task" data-chip="task">Zadania ze zdjęciem: ${tasks.length}</button>`);
  const html = out.join(''), el = $('chips');
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  el.style.top = Math.round($('top').getBoundingClientRect().bottom + 2) + 'px';
}
function showHex(id) {
  if (!id || !S.hexes[id]) return;
  sel = id === S.cur ? null : id;
  followOn = false;
  const [la, ln] = center(id);
  if (mapReady) map.easeTo({ center: [ln, la], duration: 500 });
  render();
}

// ---------- Tryb kieszonkowy ----------
// Telefon w kieszeni: ciemny ekran (oszczędza baterię), ekran nie gaśnie, więc GPS działa. Wibracja i głos informują o zdarzeniach.
const walk = { meters: 0, captured: 0, events: [] };
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* przeglądarka odmówiła */ }
}
function pocketEvent(t) {
  walk.events.unshift(`${fmtTime(Date.now())} ${t}`);
  walk.events.length = Math.min(walk.events.length, 4);
}
function renderPocket() {
  if ($('pocket').hidden) return;
  $('pStats').innerHTML = `<div><b>${walk.captured}</b><span>heksy na tym spacerze</span></div>
    <div><b>${(walk.meters / 1000).toFixed(2)} km</b><span>dystans</span></div>
    <div><b>${Math.floor(S.inv.monety)}</b><span>monety</span></div>`;
  $('pEvents').innerHTML = walk.events.map(e => `<li>${e}</li>`).join('') || '<li>Idź przed siebie. Wibracja da znać o każdej zdobyczy.</li>';
  const q = QUESTS[S.q], p = q && q.prog(S);
  $('pQuest').textContent = q ? `Zadanie: ${q.title} (${Math.min(p[0], p[1])}/${p[1]})` : '';
  $('pGps').textContent = S.mode === 'gps' ? $('gps').textContent : 'Tryb testowy';
}

let mapQueued = false;
function render() {
  checkQuests();
  renderInv(); renderCargo(); renderCard(); renderGps(); renderChips(); renderPocket();
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
    if (h.bs?.length || isSeat(h)) {
      const [la, ln] = center(id);
      const label = [isSeat(h) ? 'S' : '', ...(h.bs || []).map(b => BUILD[b.t].letter + b.l)].filter(Boolean).join(' ');
      buildings.push({ type: 'Feature', properties: { label, color: h.owner ? owner(h.owner).color : '#495057' },
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
  if (meMarker && S.pos) { updateAvatarEl(meMarker.getElement()); meMarker.setLngLat([S.pos[1], S.pos[0]]).addTo(map); }
  map.getSource('cargo').setData({ type: 'FeatureCollection', features: lines });
  map.setFilter('hex-sel', ['==', ['get', 'id'], sel || S.cur || '']);
  map.setFilter('hex-lost', ['==', ['get', 'id'], S.lastLost?.id || '']);
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
    map.addLayer({ id: 'hex-lost', type: 'line', source: 'hexes', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#e03131', 'line-width': 4, 'line-dasharray': [1.5, 1] } });
    map.addLayer({ id: 'hex-sel', type: 'line', source: 'hexes', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#111', 'line-width': 3 } });
    map.addLayer({ id: 'cargo-line', type: 'line', source: 'cargo', paint: { 'line-color': '#e67700', 'line-width': 3, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'bld-label', type: 'symbol', source: 'buildings', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-allow-overlap': true },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#fff', 'text-halo-width': 2.5 } });
    map.addLayer({ id: 'walker-line', type: 'line', source: 'walkers', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.75, 'line-dasharray': [1, 1.5] } });
    map.addLayer({ id: 'walker-dot', type: 'circle', source: 'walker-heads', paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
    map.addLayer({ id: 'walker-label', type: 'symbol', source: 'walker-heads', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top' },
      paint: { 'text-color': '#1d2129', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
    meMarker = new maplibregl.Marker({ element: avatarEl(), anchor: 'center' });
    mapReady = true;
    render(); follow(true);
  });
  map.on('click', e => {
    const id = h3.latLngToCell(e.lngLat.lat, e.lngLat.lng, RES);
    sel = S.hexes[id] && id !== S.cur ? id : null;
    render();
  });
  map.on('dragstart', () => { followOn = false; });
  map.on('idle', classifyVisible);
}

function bindUi() {
  $('card').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'walk') { const [la, ln] = center(sel); sel = null; walkTo(la, ln); }
    else if (act === 'back') { sel = null; followOn = true; follow(true); render(); }
    else if (act === 'build') build(b.dataset.t, sel || S.cur);
    else if (act === 'duel') openDuel(sel || S.cur);
    else if (act === 'collect') collectRemote(sel || S.cur);
    else if (act === 'photo') startPhoto(sel || S.cur);
  });
  $('recenter').onclick = () => { followOn = true; sel = null; follow(true); render(); };
  $('chips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const c = b.dataset.chip;
    if (c === 'quest') { const q = QUESTS[S.q]; if (q) toast(q.hint); }
    else if (c === 'lost') showHex(S.lastLost?.id);
    else if (c === 'task') showHex((S.tasks || []).find(t => Date.now() < t.until && S.hexes[t.id]?.owner === ME)?.id);
  });
  $('rankBtn').onclick = openRank;
  $('rankClose').onclick = () => { $('rank').hidden = true; };
  $('inv').addEventListener('click', e => { if (e.target.closest('[data-open="rank"]')) openRank(); });
  $('avatarBtn').onclick = () => { $('menu').hidden = true; openAvatar(); };
  $('avEmojis').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { avDraft.emoji = b.dataset.emoji; renderAvatarPreview(); } });
  $('avColors').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { avDraft.color = b.dataset.color; renderAvatarPreview(); } });
  $('avName').addEventListener('input', e => { avDraft.name = e.target.value.trim(); renderAvatarPreview(); });
  $('avSave').onclick = saveAvatar;
  $('pocketBtn').onclick = () => { $('pocket').hidden = false; keepAwake(true); renderPocket(); };
  $('pocket').addEventListener('dblclick', () => { $('pocket').hidden = true; });
  $('photoInput').addEventListener('change', e => onPhoto(e.target.files[0]));
  $('setVibe').onchange = e => { S.settings.vibe = e.target.checked; save(); buzz('capture'); };
  $('setVoice').onchange = e => { S.settings.voice = e.target.checked; save(); say('Komunikaty głosowe włączone.'); };
  $('menuBtn').onclick = () => { $('menu').hidden = false; renderMenu(); };
  $('menuClose').onclick = () => { $('menu').hidden = true; };
  $('modeGps').onclick = () => { setMode('gps'); renderMenu(); };
  $('modeTest').onclick = () => { setMode('test'); renderMenu(); };
  $('reset').onclick = () => {
    if (!confirm('Usunąć cały postęp na tym urządzeniu?')) return;
    try { localStorage.removeItem(KEY); } catch (e) { /* nic */ }
    location.reload();
  };
  $('startGps').onclick = () => { $('start').hidden = true; setMode('gps'); if (!S.profile) openAvatar(); };
  $('startTest').onclick = () => { $('start').hidden = true; setMode('test'); if (!S.profile) openAvatar(); };
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
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    tick();
    if (S.mode === 'gps') keepAwake(true);
  });
}

function main() {
  bindUi();
  initMap();
  tick();
  if (!S.mode) $('start').hidden = false;
  else { setMode(S.mode); if (!S.profile) openAvatar(); }
  setInterval(tick, 30e3);
  setInterval(stepWalkers, 1000);
  setInterval(renderCargo, 15e3);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
main();
