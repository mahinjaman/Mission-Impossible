// Service worker: makes the installed app work offline.
// Network-first, so a fresh deploy is picked up on the next launch; the cache
// is only the fallback. Bump VERSION when files are added or removed.
const VERSION = 'mission-impossible-v3';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'src/main.js', 'src/physics.js', 'src/player.js', 'src/level.js', 'src/traps.js', 'src/game.js',
  'src/gen.js', 'src/rng.js', 'src/theme.js', 'src/render.js', 'src/fx.js', 'src/hud.js', 'src/ui.js',
  'src/input.js', 'src/audio.js', 'src/storage.js', 'src/solver.js', 'src/install.js',
];

self.addEventListener('install', e => {
  // Cache files one by one so a single missing file can't break installation.
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.allSettled(FILES.map(f => c.add(f))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
