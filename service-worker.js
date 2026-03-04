const CACHE_NAME = "gst-quote-v4";
const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./purchase-order.html",
  "./delivery-challan.html",
  "./product-master.html",
  "./folio-master.html",
  "./party-master.html",
  "./item-master.html",
  "./styles.css",
  "./app.js",
  "./purchase-order.js",
  "./delivery-challan.js",
  "./product-master.js",
  "./folio-master.js",
  "./item-master.js",
  "./sync.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(FILES_TO_CACHE))
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const { request } = event;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          return (await caches.match(request)) || caches.match("./index.html");
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return response;
      });
    })
  );
});
