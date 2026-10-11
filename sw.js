// Service worker: zawsze najpierw świeża wersja z sieci (z pominięciem 10-minutowej pamięci GitHub Pages),
// zapisana kopia tylko jako zapas offline.
const CACHE = 'terra-v20';
const SHELL = ['./', 'index.html', 'style.css?v=20', 'app.js?v=20', 'icon.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Żądanie nawigacji nie przyjmuje dodatkowych opcji, więc budujemy nowe z samego adresu.
  const fresh = e.request.mode === 'navigate' ? new Request(url.href, { cache: 'no-cache' }) : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(fresh)
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
