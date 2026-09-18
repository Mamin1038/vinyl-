/**
 * sw.js
 * -------------------------------------------------------------
 * 앱 셸(HTML/CSS/JS/아이콘)을 캐싱해서 오프라인에서도 앱이 열리도록 한다.
 * 실제 음악 데이터는 IndexedDB/OPFS에 저장되며 이 서비스워커와 무관하다.
 * -------------------------------------------------------------
 */

const CACHE_VERSION = 'vinyl-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './storage.js',
  './player.js',
  './metadata.js',
  './lyrics.js',
  './manifest.webmanifest',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-152.png',
  './assets/icon-167.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch((err) => console.error('[sw] 프리캐시 실패:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부 요청은 건드리지 않음 (오프라인 전용 원칙)

  // 네비게이션 요청: 캐시 우선, 실패 시 index.html로 폴백 (오프라인에서도 앱이 열리도록)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
