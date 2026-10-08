/* Noor service worker: works offline after the first visit. The app shell is cached up front;
   everything else from this site (Qur'an text, hadith books, fonts) is cached the first time it loads. */
const VERSION = 'noor-3.28.1-web5';
const SHELL = ['./', 'index.html', 'web/bridge.js', 'web/desktop.css', 'web/desktop.js', 'web/web.js', 'lib/adhan.min.js', 'data/adhans.js', 'data/cities.js', 'data/adhkar.js',
  'hadith/bukhari.meta.js', 'hadith/muslim.meta.js', 'cards.json', 'reciters.json', 'times.json', 'quran/meta.json',
  'fonts/inter.woff2', 'fonts/amiri-quran.woff2', 'manifest.webmanifest', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('noor-3') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {   // fresh page when online, cached page when not
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put('index.html', c)); return r; }).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok) { const c = r.clone(); caches.open(VERSION).then(x => x.put(e.request, c)); }
    return r;
  })));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) { c.postMessage({ tab }); return c.focus(); }
    return self.clients.openWindow('./' + (tab ? '?tab=' + tab : ''));
  }));
});
