/* いいづか のりものナビ — Service Worker(オフライン対応) */
const CACHE = "norimono-2026-07-18-v12";
const ASSETS = [
  "./", "./index.html", "./analysis.html", "./future.html", "./style.css", "./future.css",
  "./data.js", "./app.js", "./killer_map.html",
  "./future.js", "./towns.geojson", "./wagon-scenarios.json",
  "./manifest.webmanifest", "./icon-192.png", "./icon-512.png",
  "./apple-touch-icon.png", "./favicon-32.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先・オフライン時はキャッシュ(バスの時刻を圏外でも確認できる)
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("./index.html")))
  );
});
