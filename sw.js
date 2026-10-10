/* Noor service worker: works offline after the first visit. The app shell is cached up front;
   everything else from this site (Qur'an text, hadith books, fonts) is cached the first time it loads. */
const VERSION = 'noor-3.28.1-web6';
const SHELL = ['./', 'index.html', 'web/bridge.js', 'web/desktop.css', 'web/desktop.js', 'web/web.js', 'lib/adhan.min.js', 'data/adhans.js', 'data/cities.js', 'data/adhkar.js',
  'hadith/bukhari.meta.js', 'hadith/muslim.meta.js', 'cards.json', 'reciters.json', 'times.json', 'quran/meta.json',
  'fonts/inter.woff2', 'fonts/amiri-quran.woff2', 'manifest.webmanifest', 'icons/icon-192.png', 'widgets/prayers.json', 'widgets/verse.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('noor-3') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()).then(renderAll));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.endsWith('/widgets/data.json')) { e.respondWith(widgetData().then(d => new Response(d, { headers: { 'Content-Type': 'application/json' } }))); return; }
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

/* Windows 11 widgets (Widgets board, Noor installed from Edge). The page leaves a week of prayer times and
   verses in the 'noor-widget' cache; each refresh picks today's and works out the next prayer. */
const PN = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
async function widgetData() {
  let f = null;
  try { const r = await (await caches.open('noor-widget')).match('widgets/feed.json'); if (r) f = await r.json(); } catch (e) {}
  const now = Date.now(), day = Math.floor((now - new Date(now).getTimezoneOffset() * 60000) / 864e5);
  const verses = (f && f.verses) || [], v = verses.find(x => x.day === day) || verses[verses.length - 1] || {};
  const d = { date: new Intl.DateTimeFormat('en-US', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now)), hijri: v.day === day ? v.hijri || '' : '',
    setup: true, next: '', prayers: [], place: (f && f.place) || '', hasPlace: !!(f && f.place),
    ar: (v.ar || '').replace(/\s*\u06DD[\u0660-\u0669]*/g, '') || 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ', en: v.en || 'Open Noor once to see the verse of the day here.', ref: v.ref || '' };
  const days = (f && f.days) || [];
  if (days.length && f.tz) {
    let ymd = ''; try { ymd = new Intl.DateTimeFormat('en-CA', { timeZone: f.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)); } catch (e) {}
    const i = days.findIndex(x => x.ymd === ymd);
    if (i >= 0) {
      const t = days[i].t; let n = t.findIndex(x => x != null && x > now), label;
      if (n >= 0) label = PN[n] + ' at ' + days[i].f[n];
      else if (days[i + 1]) label = 'Fajr at ' + days[i + 1].f[0] + ' tomorrow';
      d.setup = false; d.next = label || '';
      d.prayers = PN.map((name, k) => ({ name, time: days[i].f[k], w: k === n ? 'Bolder' : 'Default', c: k === n ? 'Accent' : 'Default' }));
    }
  }
  return JSON.stringify(d);
}
async function renderWidget(w) {
  const def = w.definition || {}, tpl = await (await fetch(def.msAcTemplate || ('widgets/' + (def.tag === 'noor-verse' ? 'verse' : 'prayers') + '.json'))).text();
  await self.widgets.updateByInstanceId(w.instanceId, { template: tpl, data: await widgetData() });
}
async function renderAll() {
  if (!self.widgets) return;
  for (const tag of ['noor-prayers', 'noor-verse']) {
    try { const ws = await self.widgets.matchAll({ tag }); for (const w of ws || []) await renderWidget(w); } catch (e) {}
  }
}
self.addEventListener('widgetinstall', e => e.waitUntil((async () => {
  const def = e.widget.definition || {};
  try { if (self.registration.periodicSync && def.update) await self.registration.periodicSync.register(def.tag, { minInterval: def.update * 1000 }); } catch (err) {}
  await renderWidget(e.widget);
})()));
self.addEventListener('widgetresume', e => e.waitUntil(renderWidget(e.widget)));
self.addEventListener('widgetuninstall', e => e.waitUntil((async () => {
  const tag = e.widget.definition && e.widget.definition.tag;
  try { if (tag && e.widget.instances && e.widget.instances.length <= 1 && self.registration.periodicSync) await self.registration.periodicSync.unregister(tag); } catch (err) {}
})()));
self.addEventListener('widgetclick', e => {
  const tab = e.action === 'verse' ? 'today' : 'salah';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) { c.postMessage({ tab }); return c.focus(); }
    return self.clients.openWindow('./?tab=' + tab);
  }));
});
self.addEventListener('periodicsync', e => { if (e.tag === 'noor-prayers' || e.tag === 'noor-verse') e.waitUntil(renderAll()); });
self.addEventListener('message', e => { if (e.data && e.data.widgets === 'refresh') e.waitUntil(renderAll()); });
