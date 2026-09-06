// service-worker.js
//
// Bump CACHE_VERSION on every deploy. With no build step there is no content
// hashing, so a stale cached module will otherwise outlive several edits and
// you will spend an evening debugging a bug you already fixed.
const CACHE_VERSION = 'v2';
const SHELL = `rl-shell-${CACHE_VERSION}`;
const TILES = 'rl-tiles-v1';
const TILE_LIMIT = 1500;

const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4';

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/geo.js',
  './js/lenses.js',
  './js/milestones.js',
  './js/route.js',
  './js/storage.js',
  './js/alerts.js',
  './js/tracker.js',
  './js/simulator.js',
  './lenses/solar-system.json',
  './lenses/hydrogen-atom.json',
  './lenses/blood-cell.json',
  './lenses/ocean-depth.json',
  './lenses/earth-history.json',
  './lenses/atmosphere.json',
  './lenses/everest.json',
  './lenses/apollo-11.json',
  './lenses/mount-doom.json',
  './lenses/marathon.json',
  `${LEAFLET}/leaflet.min.js`,
  `${LEAFLET}/leaflet.min.css`,
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, so one 404 (a lens not yet written) cannot fail the install.
    await Promise.all(SHELL_ASSETS.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('rl-shell-') && k !== SHELL)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isTile = (url) => /tile\.openstreetmap\.org/.test(url.hostname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache routing or geocoding — they carry the API key and change.
  if (url.hostname === 'api.openrouteservice.org') return;

  // Map tiles: serve from cache, refresh in the background, cap the store.
  if (isTile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(request);
      const network = fetch(request).then(async (res) => {
        if (res.ok) {
          await cache.put(request, res.clone());
          trimCache(cache, TILE_LIMIT);
        }
        return res;
      }).catch(() => hit);
      return hit || network;
    })());
    return;
  }

  // The page itself is network-first, so a deploy is picked up immediately.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html')),
    );
    return;
  }

  // Everything else: cache-first, falling back to the network.
  event.respondWith((async () => {
    const hit = await caches.match(request);
    if (hit) return hit;
    try {
      return await fetch(request);
    } catch {
      return new Response('Offline and not cached.', { status: 504, statusText: 'Offline' });
    }
  })());
});

async function trimCache(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  for (const key of keys.slice(0, keys.length - limit)) await cache.delete(key);
}
