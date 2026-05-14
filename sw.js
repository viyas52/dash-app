const CACHE = 'finance-v9.9';
const ASSETS = ['./index.html', './manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    // Cache Google Fonts responses for offline use
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
        e.respondWith(
            caches.open(CACHE).then(cache =>
                cache.match(e.request).then(cached => {
                    const fetched = fetch(e.request).then(resp => {
                        if (resp.ok) cache.put(e.request, resp.clone());
                        return resp;
                    }).catch(() => cached);
                    return cached || fetched;
                })
            )
        );
        return;
    }
    // Network-first for everything else, fallback to cache
    e.respondWith(
        fetch(e.request).then(resp => {
            // Cache successful navigation requests
            if (resp.ok && e.request.method === 'GET' && url.origin === self.location.origin) {
                caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
            }
            return resp;
        }).catch(() => caches.match(e.request))
    );
});
