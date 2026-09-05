/* ============================================================
   YOLO TPV — Service Worker (offline / PWA)
   ============================================================ */
const VER = 'yolo-tpv-v2';
const CORE = 'core-' + VER;
const IMGS = 'imgs-' + VER;

// Archivos base de la app (app shell). Las fotos de productos se cachean bajo demanda.
const CORE_FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/styles.css',
  'js/catalogo.js',
  'js/logo.js',
  'js/db.js',
  'js/sync.js',
  'js/app.js',
  'assets/logo.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CORE).then((c) => c.addAll(CORE_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CORE && k !== IMGS).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                         // POST (sync) va directo a la red
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // no interceptar Apps Script/externos

  // Fotos de productos: cache-first con guardado bajo demanda
  if (url.pathname.includes('/assets/productos/')) {
    e.respondWith(
      caches.open(IMGS).then((c) => c.match(req).then((hit) =>
        hit || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit)
      ))
    );
    return;
  }

  // App shell y demás: NETWORK-FIRST (para recibir siempre la versión nueva),
  // con respaldo a caché cuando no hay conexión.
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CORE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
