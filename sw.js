// Service worker: guarda la app en el teléfono para que abra sin internet.
// Con señal siempre pide la versión más reciente (y la guarda); sin señal, o si
// la red no responde a tiempo, usa la copia guardada. Así no se mezclan versiones.
// Al publicar cambios, subir la versión de CACHE.
const CACHE = 'wps-reportes-v0.7.0';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './sync.js',
  './app.js',
  './pdf.js',
  './jspdf.umd.min.js',
  './manifest.webmanifest',
  './icons/logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];
const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const key = req.mode === 'navigate' ? './index.html' : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([
        fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), NETWORK_TIMEOUT)),
      ]);
      if (res.ok) {
        cache.put(key, res.clone());
        return res;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const cached = await cache.match(key, { ignoreSearch: true });
      return cached || Response.error();
    }
  })());
});
