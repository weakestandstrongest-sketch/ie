// オフラインでも画面を開けるよう、アプリ本体だけをキャッシュする
const CACHE = 'ie-v10';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './timeshift.js',
  './dia.js',
  './drive.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 同じサイトのファイルはネット優先・失敗時にキャッシュ
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  // 毎回サーバーに新しい版があるか確かめる（ない時は 304 で速い）。古いファイルを使い続けないように
  const req = e.request.mode === 'navigate' ? fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(
    req
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          const key = e.request.mode === 'navigate' ? './' : e.request;
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
