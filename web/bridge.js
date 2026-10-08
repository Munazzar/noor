/* Noor for the web: a browser implementation of the Android app's native bridge (window.Noor).
   The page (index.html) is the same UI the Android app shows in its WebView; every call it makes into
   Java is implemented here with web APIs, following the app's own logic (Store, Sync, Quran, Heard,
   Daily, HadithSearch, AudioPlan/AudioService, Notify, Prayer). State lives in localStorage, downloads
   in the Cache API and IndexedDB. */
(function () {
  'use strict';
  const LS = 'noor:';
  const ls = (k, d = null) => { try { const v = localStorage.getItem(LS + k); return v === null ? d : v; } catch (e) { return d; } };
  const put = (k, v) => { try { localStorage.setItem(LS + k, v); } catch (e) {} };
  const del = k => { try { localStorage.removeItem(LS + k); } catch (e) {} };
  const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
  const lsJ = (k, d) => J(ls(k), d);
  const call = (name, ...a) => setTimeout(() => { try { window[name] && window[name](...a); } catch (e) { console.error(e); } }, 0);
  const syncGet = url => { const r = new XMLHttpRequest(); r.open('GET', url, false); r.send(); return r.status === 200 || r.status === 0 ? r.responseText : ''; };
  const TOTAL = 6236;
  const isOffline = e => !navigator.onLine || (e && e.name === 'TypeError');
  async function getJson(url, ms = 15000) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
    try { const r = await fetch(url, { signal: c.signal, headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(t); }
  }

  /* ---------- time + Java-compatible helpers ---------- */
  const today = () => { const n = Date.now(); return Math.floor((n - new Date(n).getTimezoneOffset() * 60000) / 864e5); };
  const ymdStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const jHash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; };
  /* java.util.Random, so the "of the day" picks match the Android app */
  function JRandom(seed) {
    const M = (1n << 48n) - 1n; let s = (BigInt.asUintN(64, BigInt(seed)) ^ 0x5DEECE66Dn) & M;
    const next = bits => { s = (s * 0x5DEECE66Dn + 0xBn) & M; return Number(BigInt.asIntN(32, s >> BigInt(48 - bits))); };
    return { nextInt(b) {
      if ((b & -b) === b) return Number((BigInt(b) * BigInt(next(31))) >> 31n);
      let bits, val; do { bits = next(31); val = bits % b; } while (bits - val + (b - 1) > 0x7fffffff); return val;
    } };
  }
  function permutation(n, seed) { const a = [...Array(n).keys()], r = JRandom(seed); for (let i = n - 1; i > 0; i--) { const j = r.nextInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  /* ---------- Store ---------- */
  let curatedTxt = null, curated = null;
  const getCurated = () => { if (!curated) { curatedTxt = syncGet('cards.json') || '[]'; curated = J(curatedTxt, []); } return curated; };
  const settings = () => lsJ('settings', {});
  const liveEnabled = () => settings().live !== false;
  const live = () => lsJ('live', []);
  const all = () => { const c = getCurated(); if (!liveEnabled()) return c; const l = live(); return l.length ? c.concat(l) : c; };
  const favorites = () => new Set(lsJ('favorites', []));
  function indexOfRef(arr, ref) { if (ref == null) return -1; for (let i = arr.length - 1; i >= 0; i--) if (arr[i] && arr[i].ref === ref) return i; return -1; }
  function dailyOf(arr, type, day) {
    if (liveEnabled()) { const i = indexOfRef(arr, ls('live_' + type + '_' + day)); if (i >= 0) return i; }
    const c = getCurated(), idx = []; c.forEach((x, i) => { if (x && x.type === type) idx.push(i); });
    if (!idx.length) return -1;
    return idx[permutation(idx.length, 786 + jHash(type))[((day % idx.length) + idx.length) % idx.length]];
  }

  /* ---------- Sync (live verses and hadith) ---------- */
  const HADITH = 'https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/';
  const AVOID = /menstruat|urin|excret|private part|sexual|intercourse|stoned|adulter|circumcis|toilet|lice|vomit|slave-girl|concubine/i;
  const PROPHET_SAID = /(Messenger|Prophet)[^."]{0,60}\b(said|saying|say)\b[^"]{0,12}[":]/;
  const rnd = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const arDigits = n => String(n).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
  function tidy(s) { let t = s.replace(/`/g, "'").replace(/\s+/g, ' ').trim(); if ((t.match(/"/g) || []).length % 2 === 1) t += '"'; return /[.!?"')\]]$/.test(t) ? t : t + '.'; }
  function extractMatn(s) {
    if (!s) return ''; const re = /"\s*([^"]{8,})\s*"/g, src = s.replace(/[‏‎]/g, '').replace(/\s+/g, ' '); let best = '', m;
    while ((m = re.exec(src))) if (m[1].length > best.length) best = m[1];
    best = best.trim(); return best.length > 420 ? '' : best;
  }
  async function fetchQuran() {
    let err = null;
    for (let i = 0; i < 6; i++) {
      try {
        const d = (await getJson('https://api.alquran.cloud/v1/ayah/' + (rnd(TOTAL) + 1) + '/editions/quran-uthmani,en.sahih')).data;
        if (!d || d.length < 2) continue;
        const ar = d.find(x => x.edition.identifier === 'quran-uthmani'), en = d.find(x => x.edition.identifier === 'en.sahih');
        if (!ar || !en) continue;
        const t = en.text.trim(); if (t.length < 40 || t.length > 380) continue;
        const s = ar.surah.number, a = ar.numberInSurah; let at = ar.text.trim();
        if (a === 1 && s !== 1 && s !== 9 && at.startsWith('بِسْمِ')) { const p = at.split(' '); if (p.length > 4) at = p.slice(4).join(' '); }
        return { type: 'quran', ar: at + ' ۝' + arDigits(a), en: tidy(t), ref: `Qur'an ${s}:${a}`, src: 'Surah ' + ar.surah.englishName };
      } catch (e) { err = e; if (isOffline(e)) throw e; }
    }
    if (err) throw err; return null;
  }
  async function fetchHadith() {
    let err = null;
    for (let i = 0; i < 8; i++) {
      const bk = rnd(10) < 6, n = rnd(bk ? 7563 : 7450) + 1;
      try {
        const h = (await getJson(HADITH + (bk ? 'eng-bukhari/' : 'eng-muslim/') + n + '.min.json')).hadiths[0];
        let t = (h.text || '').replace(/\s+/g, ' ').trim();
        if (t.length < 50 || t.length > 420 || AVOID.test(t) || !PROPHET_SAID.test(t)) continue;
        let src = ''; let m = t.match(/^Narrated ([^:]{2,70}):\s*(.*)$/);
        if (m) { src = m[1].trim(); t = m[2].trim(); } else { m = t.match(/^([^,:.]{3,60}?) reported/); if (m) src = m[1].trim(); }
        if (t.length < 30) continue;
        const num = bk ? String(h.hadithnumber) : String(h.arabicnumber || '').trim();
        if (!num || num === '0') continue;
        let ar = ''; try { ar = extractMatn((await getJson(HADITH + (bk ? 'ara-bukhari/' : 'ara-muslim/') + n + '.min.json')).hadiths[0].text); } catch (e) {}
        return { type: 'hadith', ar, en: tidy(t), ref: (bk ? 'Sahih al-Bukhari ' : 'Sahih Muslim ') + num, grade: bk ? 'Bukhari' : 'Muslim', src: src.replace(/`/g, "'") };
      } catch (e) { err = e; if (isOffline(e)) throw e; }
    }
    if (err) throw err; return null;
  }
  const addLive = (arr, o) => arr.filter(x => x && x.ref !== o.ref).concat([o]);
  let syncing = null;
  function runSync(force) {
    if (syncing) return syncing;
    syncing = (async () => {
      if (!liveEnabled()) return 'off';
      const day = today(); let arr = live(), got = false, st = 'ok';
      for (const type of ['quran', 'hadith']) {
        const key = 'live_' + type + '_' + day;
        if (!force && ls(key) !== null) continue;
        let o = null; try { o = type === 'quran' ? await fetchQuran() : await fetchHadith(); } catch (e) { st = isOffline(e) ? 'offline' : 'error'; }
        if (o) { o.live = true; o.day = day; arr = addLive(arr, o); put(key, o.ref); got = true; }
      }
      if (got && arr.length < 400) for (let i = 0; i < 2; i++) {
        try { const q = await fetchQuran(); if (q) { q.live = true; q.day = day; arr = addLive(arr, q); } const h = await fetchHadith(); if (h) { h.live = true; h.day = day; arr = addLive(arr, h); } } catch (e) {}
      }
      if (got) {
        if (arr.length > 400) { const f = favorites(); let drop = arr.length - 400; arr = arr.filter(x => (drop > 0 && !f.has(x.ref)) ? (drop--, false) : true); }
        put('live', JSON.stringify(arr)); put('lastSync', String(Date.now()));
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); const m = k && k.match(/^noor:live_(quran|hadith)_(\d+)$/); if (m && +m[2] < day - 3) { localStorage.removeItem(k); i--; } }
      }
      return got ? 'ok' : st;
    })().finally(() => { syncing = null; });
    return syncing;
  }

  /* ---------- Quran progress + daily log + heard ---------- */
  let meta = null; const qMeta = () => meta || (meta = J(syncGet('quran/meta.json'), []));
  const b64ToBytes = b => { const a = new Uint8Array(780); try { const s = atob(b || ''); for (let i = 0; i < Math.min(s.length, 780); i++) a[i] = s.charCodeAt(i); } catch (e) {} return a; };
  const bytesToB64 = a => { let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
  const countBits = a => { let n = 0; for (let i = 0; i < TOTAL; i++) if (a[i >> 3] & (1 << (i & 7))) n++; return n; };
  function dailyAdd(kind, n) {
    if (!n) return; const k = 'log_' + kind, o = lsJ(k, {}), d = ymdStr();
    o[d] = Math.max(0, (o[d] || 0) + n);
    const keys = Object.keys(o); if (keys.length > 800) { const c = new Date(); c.setDate(c.getDate() - 730); const cut = ymdStr(c); keys.forEach(x => { if (x < cut) delete o[x]; }); }
    put(k, JSON.stringify(o));
  }
  function qSave(pos, bytes, khatm) {
    const oldCount = countBits(b64ToBytes(ls('q_read', ''))), newCount = countBits(bytes), oldK = +ls('q_khatm', 0);
    const delta = khatm > oldK ? (TOTAL - oldCount) + newCount + (khatm - oldK - 1) * TOTAL : newCount - oldCount;
    if (khatm >= oldK) dailyAdd('r', delta);
    put('q_pos', String(((pos % TOTAL) + TOTAL) % TOTAL)); put('q_read', bytesToB64(bytes)); put('q_khatm', String(khatm)); put('q_last', String(Date.now()));
  }
  function markRead(s, a) {
    const g = ((qMeta()[s - 1] || {}).start ?? -1) + a - 1; if (g < 0 || g >= TOTAL) return;
    let b = b64ToBytes(ls('q_read', '')); if (b[g >> 3] & (1 << (g & 7))) return;
    b[g >> 3] |= 1 << (g & 7); let k = +ls('q_khatm', 0); if (countBits(b) >= TOTAL) { k++; b = new Uint8Array(780); }
    qSave(+ls('q_pos', 0), b, k);
  }
  function heardSet(from, to) {
    if (from < 0 || to <= from) return; const b = b64ToBytes(ls('heard', ''));
    for (let i = from; i < to && i < TOTAL; i++) b[i >> 3] |= 1 << (i & 7); put('heard', bytesToB64(b));
  }

  /* ---------- notifications ---------- */
  const notifGranted = () => 'Notification' in window && Notification.permission === 'granted';
  async function notify(title, body, tag, onclickTab) {
    if (!notifGranted()) return false;
    const opt = { body, tag: tag || undefined, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { tab: onclickTab || '' } };
    try { const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration(); if (reg) { await reg.showNotification(title, opt); return true; } } catch (e) {}
    try { const n = new Notification(title, opt); n.onclick = () => { window.focus(); if (onclickTab && window.openFromWidget) window.openFromWidget(onclickTab); n.close(); }; return true; } catch (e) { return false; }
  }
  function chime() { try { const C = new (window.AudioContext || window.webkitAudioContext)(), o = C.createOscillator(), g = C.createGain(); o.frequency.value = 880; g.gain.setValueAtTime(.18, C.currentTime); g.gain.exponentialRampToValueAtTime(.001, C.currentTime + .9); o.connect(g).connect(C.destination); o.start(); o.stop(C.currentTime + 1); } catch (e) {} }
  function showReminder(kind, sound) {
    let title, body, tab;
    if (kind === 'hadith' || kind === 'verse') {
      const arr = all(), c = arr[dailyOf(arr, kind === 'verse' ? 'quran' : 'hadith', today())]; if (!c) return false;
      const q = c.type === 'quran'; let ref = c.ref; if (!q && ref.startsWith('Riyad') && c.grade) ref = c.grade + ' · ' + ref;
      title = (q ? 'Ayah of the day · ' : 'Hadith of the day · ') + ref; body = c.en + (q ? '\n— ' + c.src : (c.src ? '\n— Narrated by ' + c.src : '')); tab = 'card';
    } else if (kind.startsWith('note:')) { title = 'Your reminder'; body = kind.slice(5); tab = 'mine'; }
    else if (kind === 'reminder') {
      const r = lsJ('reminders', []); if (!r.length) return false; const d = today(), o = r[((d % r.length) + r.length) % r.length];
      title = 'Remind yourself'; body = o.text + (o.note ? '\n\n' + o.note : ''); tab = 'mine';
    } else {
      const pos = +ls('q_pos', 0), M = qMeta(); let s = 1, a = 1; for (let i = M.length - 1; i >= 0; i--) if (pos >= M[i].start) { s = M[i].n; a = pos - M[i].start + 1; break; }
      const pct = Math.floor(countBits(b64ToBytes(ls('q_read', ''))) * 1000 / TOTAL) / 10;
      title = `Continue reading · ${(M[s - 1] || {}).tr || ''} ${s}:${a}`; body = pct + '% · tap to pick up where you left off'; tab = 'read';
    }
    if (sound) chime();
    notify(title, body, 'noor-' + kind.slice(0, 20), tab); return true;
  }

  /* In-page scheduler: daily reminders (settings.notif) and prayer alerts (settings.pt) fire while Noor is open. */
  function nextTime(hm) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim()); if (!m) return -1; const d = new Date(); d.setHours(+m[1], +m[2], 0, 0); if (d.getTime() <= Date.now() + 15000) d.setDate(d.getDate() + 1); return d.getTime(); }
  let lastTick = Date.now();
  function tick() {
    const now = Date.now(), prev = lastTick; lastTick = now;
    const n = settings().notif;
    if (n && n.on && Array.isArray(n.items)) n.items.slice(0, 12).forEach(it => {
      if (!it || it.on === false) return; const m = /^(\d{1,2}):(\d{2})$/.exec(it.time || '08:00'); if (!m) return;
      const d = new Date(now); d.setHours(+m[1], +m[2], 0, 0); const t = d.getTime();
      if (t > prev && t <= now) showReminder(it.type === 'note' ? 'note:' + (it.text || '') : (it.type || 'verse'), !!n.sound);
    });
    prayerTick(prev, now);
    const pa = +ls('plant_at', 0); if (pa && pa > prev && pa <= now) { notify(ls('plant_t', ''), ls('plant_b', ''), 'noor-plant', 'track'); del('plant_at'); }
  }
  const PK = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'], PN = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
  function prayerTick(prev, now) {
    const c = settings().pt; if (!c || !c.loc || c.loc.lat == null || typeof window.ptNow !== 'function') return;
    let days; try { const tz = window.ptTz(c); days = [window.ptDay(c, window.ptYmd(tz, now)), window.ptDay(c, window.ptYmd(tz, now, -1))]; } catch (e) { return; }
    const before = Math.max(0, Math.min(60, +c.before || 0));
    const mode = i => { const o = c.al && c.al[PK[i]]; return (o && o.m) || (i === 1 ? 'off' : 'notify'); };
    const sound = i => { const o = c.al && c.al[PK[i]]; return (o && o.s) || (i === 0 ? 'madinah_fajr' : 'makkah'); };
    const place = c.loc.name ? ' · ' + c.loc.name : '';
    for (const t of days) for (let i = 0; i < 6; i++) {
      const at = t[i]; if (at == null || mode(i) === 'off') continue;
      if (before > 0 && i !== 1) { const b = at - before * 60000; if (b > prev && b <= now) notify(`${PN[i]} in ${before} ${before === 1 ? 'minute' : 'minutes'}`, `${PN[i]} at ${window.ptFmt(c, at)}${place}`, 'noor-soon-' + i, 'salah'); }
      if (at > prev && at <= now) {
        const msg = i === 1 ? 'The sun has risen. The time for Fajr has ended.' : `It's time for ${PN[i]}.`;
        notify(`${PN[i]} · ${window.ptFmt(c, at)}`, msg + place, 'noor-pt-' + i, 'salah');
        if (mode(i) === 'adhan' && i !== 1) adhan.play(sound(i), false);
      }
    }
  }

  /* ---------- blobs: IndexedDB for adhan files and dock backgrounds ---------- */
  const idb = (() => {
    let dbp = null; const open = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open('noor', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const tx = (mode, fn) => open().then(db => new Promise((res, rej) => { const t = db.transaction('files', mode), s = t.objectStore('files'), r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }));
    return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)), del: k => tx('readwrite', s => s.delete(k)), keys: () => tx('readonly', s => s.getAllKeys()) };
  })();
  const blobUrls = {};
  async function blobUrl(key) { if (blobUrls[key]) return blobUrls[key]; const b = await idb.get(key).catch(() => null); if (!b) return null; return (blobUrls[key] = URL.createObjectURL(b)); }

  /* ---------- adhan ---------- */
  const adhan = (() => {
    let player = null, previewId = null;
    const have = () => lsJ('adhan_have', []);
    const setHave = h => put('adhan_have', JSON.stringify(h));
    async function download(id, file, bases) {
      if (!/^[a-z0-9_]{1,40}$/.test(id || '')) return;
      let ok = false; const list = J(bases, []);
      for (const b of list) {
        if (ok || !String(b).startsWith('https://')) continue;
        try {
          const r = await fetch(b + encodeURIComponent(file).replace(/%28/g, '(').replace(/%29/g, ')'));
          if (!r.ok) continue;
          const total = +r.headers.get('content-length') || 0, rd = r.body.getReader(), parts = []; let got = 0, last = 0;
          for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (total && Date.now() - last > 250) { last = Date.now(); call('onAdhanDl', id, Math.floor(got * 100 / total), false); } }
          const blob = new Blob(parts, { type: 'audio/mpeg' }); if (blob.size > 1000) { await idb.set('adhan/' + id, blob); delete blobUrls['adhan/' + id]; ok = true; }
        } catch (e) {}
      }
      if (ok) { const h = have(); if (!h.includes(id)) h.push(id); setHave(h); }
      call('onAdhanDl', id, ok ? 100 : -1, true);
    }
    function stopPlayer() { if (player) { try { player.pause(); } catch (e) {} player = null; } }
    async function play(id, test) {
      const url = await blobUrl('adhan/' + id); if (!url) return false;
      stopPlayer(); player = new Audio(url); player.onended = () => { player = null; };
      try { await player.play(); } catch (e) { return false; } return true;
    }
    function preview(id, url) {
      previewStop(false); previewId = id; call('onAdhanPreview', id, 'loading');
      const go = u => { const a = new Audio(u); player = a; a.oncanplay = () => { if (player === a) call('onAdhanPreview', id, 'playing'); };
        a.onended = () => { if (player === a) { player = null; call('onAdhanPreview', id, 'stopped'); } }; a.onerror = () => { if (player === a) { player = null; call('onAdhanPreview', id, 'error'); } };
        a.play().catch(() => {}); };
      if (url) go(url); else blobUrl('adhan/' + id).then(u => u ? go(u) : call('onAdhanPreview', id, 'error'));
    }
    function previewStop(notify) { const id = previewId; stopPlayer(); previewId = null; if (notify && id) call('onAdhanPreview', id, 'stopped'); }
    function pick() {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'audio/*';
      inp.onchange = async () => { const f = inp.files && inp.files[0]; if (!f) { call('onAdhanPicked', null); return; }
        try { await idb.set('adhan/custom', f); delete blobUrls['adhan/custom']; const h = have(); if (!h.includes('custom')) h.push('custom'); setHave(h); put('pt_custom_name', f.name.replace(/\.[^.]+$/, '')); call('onAdhanPicked', ls('pt_custom_name')); }
        catch (e) { call('onAdhanPicked', null); } };
      inp.click();
    }
    return { download, play, preview, previewStop, pick, have, setHave, stop: stopPlayer, playing: () => !!player && !previewId };
  })();

  /* ---------- Quran audio (AudioPlan + AudioService) ---------- */
  const catalog = J(syncGet('reciters.json'), { reciters: [] });
  const count = s => (qMeta()[s - 1] || { count: 7 }).count;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const audio = (() => {
    const P = { surah: 1, from: 1, to: 7, ayah: 1, phase: 0, verseRep: 0, rangeRep: 0, verseRepeat: 1, rangeRepeat: 1, translation: false, continueNext: true, basmala: true, surahMode: false, stopAtSurahEnd: false };
    const fullRange = () => P.from === 1 && P.to === count(P.surah);
    const firstPhase = () => (P.surahMode || !P.basmala || P.ayah !== 1 || P.surah === 1 || P.surah === 9) ? 0 : -1;
    function start(s, a, f, t) { P.surah = clamp(s, 1, 114); const n = count(P.surah); P.from = f > 0 ? clamp(f, 1, n) : 1; P.to = t <= 0 ? n : clamp(t, P.from, n); P.ayah = a <= 0 ? P.from : clamp(a, P.from, P.to); P.verseRep = 0; P.rangeRep = 0; P.phase = firstPhase(); }
    function moveOn() {
      P.verseRep = 0; if (P.ayah < P.to) { P.ayah++; P.phase = 0; return true; }
      P.rangeRep++; if (P.rangeRepeat === 0 || P.rangeRep < P.rangeRepeat) { P.ayah = P.from; P.phase = firstPhase(); return true; }
      if (P.stopAtSurahEnd || !P.continueNext || P.to !== count(P.surah) || P.surah >= 114) return false;
      P.surah++; P.from = 1; P.to = count(P.surah); P.ayah = 1; P.rangeRep = 0; P.phase = firstPhase(); return true;
    }
    function advance() {
      if (P.phase === -1) { P.phase = 0; return true; }
      if (P.phase === 0) { P.verseRep++; if (P.verseRepeat === 0 || P.verseRep < P.verseRepeat) return true; if (P.translation && !P.surahMode) { P.phase = 1; return true; } }
      return moveOn();
    }
    function prevVerse() {
      P.verseRep = 0;
      if (P.ayah <= P.from) { if (fullRange() && P.surah > 1) { P.surah--; P.from = 1; P.to = count(P.surah); P.ayah = P.to; P.phase = 0; P.rangeRep = 0; return; } P.phase = firstPhase(); return; }
      P.ayah--; P.phase = 0;
    }
    function jump(a) { const n = count(P.surah), c = clamp(a, 1, n); if (c < P.from || c > P.to) { P.from = 1; P.to = n; P.rangeRep = 0; } P.ayah = c; P.verseRep = 0; P.phase = firstPhase(); }

    const el = new Audio(); el.preload = 'auto';
    let rid = 'husary', rec = null, active = false, playing = false, loading = false, inGap = false, ended = false, error = null, errStreak = 0;
    let gen = 0, gapMs = 0, speed = 1, countRead = false, sleepAt = 0, sleepEos = false, sleepT = null, gapT = null, pollT = null;
    let surahMode = false, timed = false, tStart = null, tEnd = null, loadedSurah = -1, mq = null, gapSeekPending = false;
    const opts = () => lsJ('audio_opts', {});
    function applyOpts(o) {
      if ('verseRepeat' in o) P.verseRepeat = Math.max(0, +o.verseRepeat | 0);
      if ('rangeRepeat' in o) P.rangeRepeat = Math.max(0, +o.rangeRepeat | 0);
      if ('translation' in o) P.translation = !!o.translation;
      if ('continueNext' in o) P.continueNext = o.continueNext !== false;
      if ('basmala' in o) P.basmala = o.basmala !== false;
      if ('gap' in o) gapMs = clamp(+o.gap || 0, 0, 10000);
      if ('countRead' in o) countRead = !!o.countRead;
      if ('speed' in o) { speed = clamp(+o.speed || 1, .5, 2); try { el.playbackRate = speed; } catch (e) {} }
    }
    function setReciter(id) {
      const r = (catalog.reciters || []).find(x => x.id === id); if (!r) return;
      const changed = r.id !== rid || !rec; rec = r; rid = r.id; surahMode = r.src === 'mq'; P.surahMode = surahMode;
      if (changed) { loadedSurah = -1; mq = null; timed = false; }
    }
    (function load() { applyOpts(opts()); const l = lsJ('audio_last', {}); setReciter(l.rid || 'husary'); if (!rec) setReciter('husary'); start(l.s || 1, l.a || 1, l.from || 0, l.to || 0); })();
    function saveLast() { put('audio_last', JSON.stringify({ rid, s: P.surah, a: P.ayah, from: fullRange() ? 0 : P.from, to: fullRange() ? 0 : P.to })); }

    function state() {
      if (!active) { const l = lsJ('audio_last', {}); return { active: false, playing: false, loading: false, rid: l.rid || 'husary', s: l.s || 1, a: l.a || 1, from: l.from || 1, to: l.to || 0, opts: opts() }; }
      let pos = 0, dur = 0;
      if (el.src && isFinite(el.currentTime)) { pos = el.currentTime * 1000; dur = isFinite(el.duration) ? el.duration * 1000 : 0;
        if (surahMode && timed && tStart) { pos -= tStart[P.ayah]; dur = tEnd[P.ayah] - tStart[P.ayah]; } }
      const o = { active: true, playing, loading, gap: inGap, ended, rid, s: P.surah, a: P.ayah, from: P.from, to: P.to, count: count(P.surah),
        phase: P.phase === 1 ? 'en' : P.phase === -1 ? 'basmala' : 'ar', vr: P.verseRep + 1, rr: P.rangeRep + 1, surahMode, timed,
        pos: Math.max(0, Math.round(pos)), dur: Math.max(0, Math.round(dur)), at: Date.now(), sleepAt, sleepEos, opts: opts() };
      if (error) o.error = error; return o;
    }
    function publish() { const s = JSON.stringify(state()); call('onAudio', s); session(); }
    function session() {
      if (!('mediaSession' in navigator)) return;
      try {
        const m = qMeta()[P.surah - 1] || {};
        navigator.mediaSession.metadata = new MediaMetadata({ title: `${m.tr || 'Surah ' + P.surah} · ${P.surah}:${P.ayah}`, artist: rec ? rec.name : 'Noor', album: 'Noor', artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
        navigator.mediaSession.playbackState = playing ? 'playing' : (active ? 'paused' : 'none');
      } catch (e) {}
    }
    if ('mediaSession' in navigator) {
      const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) {} };
      h('play', () => cmd({ op: 'resume' })); h('pause', () => cmd({ op: 'pause' })); h('nexttrack', () => cmd({ op: 'next' })); h('previoustrack', () => cmd({ op: 'prev' })); h('stop', () => cmd({ op: 'stop' }));
    }
    const startPoll = () => { stopPoll(); pollT = setInterval(poll, 200); };
    const stopPoll = () => { clearInterval(pollT); pollT = null; };
    function poll() {
      if (surahMode && timed && playing && tEnd && el.currentTime * 1000 >= tEnd[P.ayah] - 40 && loadedSurah === P.surah) surahVerseDone();
    }
    const clipName = (s, a) => String(s).padStart(3, '0') + String(a).padStart(3, '0') + '.mp3';
    const folderFor = ph => ph === 1 ? ((catalog.english && catalog.english.folder) || 'English/Sahih_Intnl_Ibrahim_Walk_192kbps') : rec.folder;
    const base = () => catalog.base || 'https://everyayah.com/data/';
    async function cachedUrl(url) {
      try { const c = await caches.open('noor-audio'); const r = await c.match(url); if (r && r.type !== 'opaque') return URL.createObjectURL(await r.blob()); } catch (e) {}
      return url;
    }
    let lastObj = null;
    function playSource(g, src, seekMs) {
      if (g !== gen) return;
      if (lastObj && lastObj !== src) { try { URL.revokeObjectURL(lastObj); } catch (e) {} lastObj = null; }
      if (src.startsWith('blob:')) lastObj = src;
      el.src = src; el.playbackRate = speed;
      const ready = () => { el.removeEventListener('loadedmetadata', ready); if (g !== gen) return; if (seekMs) el.currentTime = seekMs / 1000; };
      el.addEventListener('loadedmetadata', ready);
      el.play().then(() => { if (g !== gen) return; loading = false; playing = true; errStreak = 0; el.playbackRate = speed; startPoll(); publish(); })
        .catch(e => { if (g !== gen) return; if (e && e.name === 'NotAllowedError') { loading = false; playing = false; publish(); } else loadFailed("Couldn't load the audio. Check your internet connection."); });
    }
    el.addEventListener('error', () => { if (el.src && (loading || playing)) loadFailed("Couldn't play this audio."); });
    el.addEventListener('ended', () => {
      if (surahMode) {
        if (timed) { if (P.surah === loadedSurah) surahVerseDone(); return; }
        dailyAdd('l', count(P.surah)); const m = qMeta()[P.surah - 1]; if (m) heardSet(m.start, m.start + m.count);
        if (!P.continueNext || P.stopAtSurahEnd || P.surah >= 114) { finish(); return; }
        start(P.surah + 1, 1, 0, 0); begin(); return;
      }
      clipDone();
    });
    function heardCur() { if (P.phase !== 0) return; const m = qMeta()[P.surah - 1]; if (m) heardSet(m.start + P.ayah - 1, m.start + P.ayah); }
    function loadFailed(msg) {
      loading = false; playing = false; errStreak++; error = msg;
      if (!surahMode && errStreak < 3 && P.phase !== -1) { publish(); if (moveOn()) { const g = gen; setTimeout(() => { if (g === gen) beginClip(); }, 600); return; } }
      else if (!surahMode && P.phase === -1 && errStreak < 3) { advance(); beginClip(); return; }
      stopPoll(); publish();
    }
    function clipDone() {
      const ar = P.phase === 0;
      if (ar && P.verseRep === 0) { dailyAdd('l', 1); heardCur(); if (countRead) markRead(P.surah, P.ayah); }
      if (advance()) {
        saveLast();
        if (ar && gapMs > 0) { playing = false; inGap = true; publish(); gapT = setTimeout(() => { if (inGap) { inGap = false; beginClip(); } }, gapMs); return; }
        beginClip(); return;
      }
      finish();
    }
    function surahVerseDone() {
      const s = P.surah;
      if (P.verseRep === 0) { dailyAdd('l', 1); heardCur(); if (countRead) markRead(P.surah, P.ayah); }
      if (advance()) {
        saveLast();
        if (P.surah === s) {
          const t = tStart[P.ayah];
          if (gapMs > 0) { el.pause(); playing = false; inGap = true; stopPoll(); publish();
            gapT = setTimeout(() => { if (inGap) { inGap = false; el.currentTime = t / 1000; el.play().catch(() => {}); playing = true; startPoll(); publish(); } }, gapMs); return; }
          el.currentTime = t / 1000; publish(); return;
        }
        begin(); return;
      }
      finish();
    }
    function finish() {
      ended = true; if (sleepEos) { sleepEos = false; P.stopAtSurahEnd = false; }
      playing = false; inGap = false; try { el.pause(); } catch (e) {} stopPoll(); publish();
    }
    function beginClip() {
      const g = ++gen; loading = true; playing = false; error = null; stopPoll(); active = true; publish();
      const url = base() + folderFor(P.phase) + '/' + clipName(P.phase === -1 ? 1 : P.surah, P.phase === -1 ? 1 : P.ayah);
      cachedUrl(url).then(u => playSource(g, u));
      prefetch();
    }
    function prefetch() { /* warm the browser cache for the next clip */
      try { const s = P.surah, a = P.ayah < P.to ? P.ayah + 1 : P.ayah; if (P.phase === 0 && a !== P.ayah) { const l = document.createElement('link'); l.rel = 'prefetch'; l.as = 'audio'; l.href = base() + rec.folder + '/' + clipName(s, a); document.head.appendChild(l); setTimeout(() => l.remove(), 60000); } } catch (e) {}
    }
    async function resolveMq(r) {
      const c = lsJ('mq_' + r.id, {});
      if (c.server && Date.now() - (c.at || 0) < 6048e5) return c;
      const matches = name => { if (!name) return false; const low = name.toLowerCase(); return (r.en || []).some(k => low.includes(k)) || (r.arkw || []).some(k => name.includes(k)); };
      const first = o => Array.isArray(o) ? o : (Object.values(o || {}).find(Array.isArray) || []);
      let found = null;
      for (const lang of ['eng', 'ar']) { found = first(await getJson('https://mp3quran.net/api/v3/reciters?language=' + lang)).find(x => x && matches(x.name)); if (found) break; }
      if (!found) throw new Error('reciter not found');
      let best = null, score = -1;
      for (const m of found.moshaf || []) { const sc = ((m.name || '').includes('Hafs') || (m.name || '').includes('حفص') ? 1000 : 0) + (+m.surah_total || 0); if (sc > score) { score = sc; best = m; } }
      if (!best) throw new Error('no recording');
      let server = best.server || ''; if (!server.endsWith('/')) server += '/';
      const out = { server, surahs: best.surah_list || '', read: -1, folder: '' };
      try { const rd = first(await getJson('https://mp3quran.net/api/v3/ayat_timing/reads')).find(x => x && matches(x.name)); if (rd) { let f = rd.folder_url || ''; if (f && !f.endsWith('/')) f += '/'; out.read = +rd.id || -1; out.folder = f; } } catch (e) {}
      out.at = Date.now(); put('mq_' + r.id, JSON.stringify(out)); return out;
    }
    async function timings(read, s, n) {
      let txt = ls('mqt_' + read + '_' + s);
      try { if (!txt) txt = JSON.stringify(await getJson('https://mp3quran.net/api/v3/ayat_timing?surah=' + s + '&read=' + read)); } catch (e) { return null; }
      const arr = (o => Array.isArray(o) ? o : (Object.values(o || {}).find(Array.isArray) || []))(J(txt, []));
      const st = new Array(n + 1).fill(0), en = new Array(n + 1).fill(0); let ok = 0;
      for (const x of arr) { const a = x && +x.ayah; if (a >= 1 && a <= n) { st[a] = +x.start_time || 0; en[a] = +x.end_time || 0; if (en[a] > st[a]) ok++; } }
      if (ok < n) return null; put('mqt_' + read + '_' + s, txt); return [st, en];
    }
    function beginSurah() {
      const g = ++gen; loading = true; playing = false; error = null; stopPoll(); active = true; publish();
      const s = P.surah;
      if (s === loadedSurah && el.src && el.readyState > 0) {
        loading = false; el.currentTime = timed ? tStart[P.ayah] / 1000 : 0; el.play().catch(() => {}); playing = true; el.playbackRate = speed; startPoll(); publish(); return;
      }
      (async () => {
        let m, src, tm = null, err = null;
        try {
          m = await resolveMq(rec);
          if (m.surahs && !(',' + m.surahs + ',').includes(',' + s + ',')) err = "This reciter's recording of this surah isn't available.";
          else {
            const f = String(s).padStart(3, '0') + '.mp3', hasT = m.read > 0;
            src = ((hasT && m.folder) ? m.folder : m.server) + f;
            if (hasT) tm = await timings(m.read, s, count(s));
            src = await cachedUrl(src);
          }
        } catch (e) { err = "Couldn't reach mp3quran.net. Check your internet connection."; }
        if (g !== gen) return;
        if (err) { loadFailed(err); return; }
        mq = m; timed = !!tm; tStart = tm && tm[0]; tEnd = tm && tm[1]; loadedSurah = s;
        playSource(g, src, timed ? tStart[P.ayah] : 0);
      })();
    }
    function begin() { if (!rec) setReciter(rid); clearTimeout(gapT); inGap = false; saveLast(); if (surahMode) beginSurah(); else beginClip(); }
    function pause() {
      clearTimeout(gapT); const wasGap = inGap; inGap = false;
      try { el.pause(); } catch (e) {}
      if (loading) { gen++; loading = false; }
      if (wasGap && surahMode && timed) gapSeekPending = true;
      playing = false; stopPoll(); publish();
    }
    function resume() {
      if (ended) { start(P.surah, P.from, P.from, P.to); ended = false; begin(); return; }
      if (active && el.src && el.readyState > 0 && !loading && !error) {
        if (gapSeekPending && tStart) { gapSeekPending = false; el.currentTime = tStart[P.ayah] / 1000; }
        else if (!surahMode && el.ended) { begin(); return; }
        el.play().then(() => { playing = true; el.playbackRate = speed; startPoll(); publish(); }).catch(() => begin()); return;
      }
      begin();
    }
    function stopAll() { gen++; playing = false; loading = false; inGap = false; clearTimeout(gapT); clearTimeout(sleepT); sleepAt = 0; saveLast(); try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {} loadedSurah = -1; active = false; ended = false; stopPoll(); publish(); }
    function fadeThenPause(i) { if (!playing) { pause(); return; } el.volume = Math.max(0, i / 10); if (i <= 0) { pause(); el.volume = 1; return; } setTimeout(() => fadeThenPause(i - 1), 400); }
    function cmd(c) {
      switch (c.op) {
        case 'play': setReciter(c.rid || rid); start(c.s || 1, c.a || 0, c.from || 0, c.to || 0); ended = false; error = null; errStreak = 0; if (surahMode && P.surah !== loadedSurah) loadedSurah = -1; begin(); break;
        case 'toggle': if (playing || loading || inGap) pause(); else resume(); break;
        case 'pause': pause(); break;
        case 'resume': if (!active) { const l = lsJ('audio_last', {}); setReciter(l.rid || rid); start(l.s || 1, l.a || 1, l.from || 0, l.to || 0); begin(); } else resume(); break;
        case 'next': clearTimeout(gapT); inGap = false;
          if (surahMode && !timed) { if (P.surah < 114) start(P.surah + 1, 1, 0, 0); begin(); } else if (moveOn()) begin(); else finish(); break;
        case 'prev': clearTimeout(gapT); inGap = false;
          if (surahMode && !timed) { if (el.currentTime < 4 && P.surah > 1) start(P.surah - 1, 1, 0, 0); begin(); break; }
          if (surahMode || !playing || el.currentTime <= 3 || P.phase !== 0) { prevVerse(); begin(); } else { el.currentTime = 0; publish(); } break;
        case 'stop': stopAll(); break;
        case 'jump': jump(c.a || 1); ended = false; begin(); break;
        case 'range': { const a = P.ayah, ph = P.phase; start(P.surah, a, c.from || 1, c.to || 0); if (a === P.ayah) { P.phase = ph; saveLast(); publish(); } else begin(); break; }
        case 'opts': if (c.v) { put('audio_opts', JSON.stringify(Object.assign(opts(), c.v))); applyOpts(c.v); } publish(); break;
        case 'seek': if (el.src) { let ms = +c.ms || 0; if (surahMode && timed && tStart) ms += tStart[P.ayah]; el.currentTime = Math.max(0, ms) / 1000; } publish(); break;
        case 'sleep': clearTimeout(sleepT); sleepEos = !!c.eos; P.stopAtSurahEnd = sleepEos; sleepAt = c.min > 0 ? Date.now() + c.min * 60000 : 0;
          if (c.min > 0) sleepT = setTimeout(() => { sleepAt = 0; fadeThenPause(10); }, c.min * 60000); publish(); break;
        case 'device': put('audio_opts', JSON.stringify(Object.assign(opts(), { device: c.id | 0 }))); publish(); break;
      }
    }
    return { cmd, state: () => JSON.stringify(state()), isPlaying: () => playing };
  })();

  /* offline surah downloads (Cache API) */
  let dlCancel = false;
  async function audioDownload(id, s) {
    const r = (catalog.reciters || []).find(x => x.id === id); if (!r || s < 1 || s > 114) return;
    dlCancel = false; const c = await caches.open('noor-audio');
    const rep = (done, total, st) => call('onAudioDl', JSON.stringify({ rid: id, s, done, total, state: st }));
    let urls;
    try {
      if (r.src === 'mq') { const m = lsJ('mq_' + id, {}); if (!m.server) throw 0; const f = String(s).padStart(3, '0') + '.mp3'; urls = [((m.read > 0 && m.folder) ? m.folder : m.server) + f]; }
      else { const b = catalog.base || 'https://everyayah.com/data/'; urls = []; for (let a = 1; a <= count(s); a++) urls.push(b + r.folder + '/' + String(s).padStart(3, '0') + String(a).padStart(3, '0') + '.mp3'); if (s !== 1 && s !== 9) urls.push(b + r.folder + '/001001.mp3'); }
    } catch (e) { rep(0, 1, 'error'); return; }
    let done = 0;
    for (const u of urls) {
      if (dlCancel) { rep(done, urls.length, 'cancel'); return; }
      try { if (!(await c.match(u))) { const res = await fetch(u, { mode: 'cors' }); if (!res.ok) throw 0; await c.put(u, res); } } catch (e) { rep(done, urls.length, 'error'); return; }
      done++; rep(done, urls.length, done === urls.length ? 'done' : 'run');
    }
    const idx = lsJ('dl_' + id, []); if (!idx.includes(s)) idx.push(s); put('dl_' + id, JSON.stringify(idx));
  }
  async function cacheSize() { try { const e = await navigator.storage.estimate(); put('dl_bytes', String((e.usageDetails && e.usageDetails.caches) || e.usage || 0)); } catch (e) {} }
  async function audioClear(id) {
    try { const c = await caches.open('noor-audio'); const keys = await c.keys(); const r = id && (catalog.reciters || []).find(x => x.id === id);
      for (const k of keys) if (!r || k.url.includes('/' + r.folder + '/') || (r.src === 'mq' && (lsJ('mq_' + id, {}).server || '\0') && k.url.startsWith(lsJ('mq_' + id, {}).server))) await c.delete(k); } catch (e) {}
    if (id) del('dl_' + id); else (catalog.reciters || []).forEach(x => del('dl_' + x.id)); cacheSize();
  }

  /* ---------- hadith search (whole Bukhari + Muslim, downloaded once) ---------- */
  let hIndex = null;
  async function hadithLoad() {
    if (hIndex) return hIndex; const c = await caches.open('noor-hadith'), out = [];
    for (const book of ['eng-bukhari', 'eng-muslim']) {
      let res = null;
      for (const b of ['https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/', 'https://raw.githubusercontent.com/fawazahmed0/hadith-api/1/editions/']) {
        const u = b + book + '.min.json'; res = await c.match(u); if (res) break;
        try { const r = await fetch(u); if (r.ok) { await c.put(u, r.clone()); res = r; break; } } catch (e) {}
      }
      if (!res) throw new Error('offline');
      const name = book.endsWith('bukhari') ? 'bukhari' : 'muslim';
      for (const h of (await res.json()).hadiths || []) { const t = (h.text || '').trim(); if (t.length < 20) continue; out.push([name, String(h.hadithnumber), h.reference ? h.reference.book : 0, h.reference ? h.reference.hadith : 0, t, t.toLowerCase()]); }
    }
    put('hadith_ready', '1'); return (hIndex = out);
  }
  async function hadithSearch(q) {
    try {
      const idx = await hadithLoad(), t = (q || '').toLowerCase().trim(), words = t.split(/[^\p{L}\p{N}']+/u).filter(w => w.length >= 2);
      if (!words.length) return { ok: true, total: 0, results: [] };
      const hits = []; for (const h of idx) if (words.every(w => h[5].includes(w))) hits.push([h, (h[5].includes(t) ? 100 : 0) - Math.floor(h[4].length / 200)]);
      hits.sort((a, b) => b[1] - a[1]);
      return { ok: true, total: hits.length, results: hits.slice(0, 40).map(([h]) => h[0] === 'bukhari'
        ? { ref: 'Sahih al-Bukhari ' + h[1], url: 'https://sunnah.com/bukhari:' + h[1], text: h[4] }
        : { ref: `Sahih Muslim, Book ${h[2]} Hadith ${h[3]}`, url: `https://sunnah.com/muslim/${h[2]}/${h[3]}`, text: h[4] }) };
    } catch (e) { return { ok: false, error: 'offline' }; }
  }

  /* ---------- location + compass ---------- */
  function requestLocation() {
    if (!navigator.geolocation) { call('onLocation', { ok: false, err: 'none' }); return; }
    navigator.geolocation.getCurrentPosition(
      p => { put('loc_granted', '1'); call('onLocation', { ok: true, lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }); },
      e => call('onLocation', { ok: false, err: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'none' }),
      { enableHighAccuracy: false, timeout: 20000, maximumAge: 600000 });
  }
  if (navigator.permissions) navigator.permissions.query({ name: 'geolocation' }).then(s => { const f = () => put('loc_granted', s.state === 'granted' ? '1' : s.state === 'denied' ? 'denied' : ''); f(); s.onchange = f; }).catch(() => {});
  let compassH = null, smooth = NaN;
  const hasCompass = () => 'DeviceOrientationEvent' in window && (matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent));
  function startCompass() {
    stopCompass(); smooth = NaN;
    const on = e => {
      let h = null, acc = 2;
      if (e.webkitCompassHeading != null) { h = e.webkitCompassHeading; acc = e.webkitCompassAccuracy < 0 ? 0 : e.webkitCompassAccuracy > 25 ? 1 : 3; }
      else if (e.absolute && e.alpha != null) { h = (360 - e.alpha) % 360; acc = 3; }
      if (h == null) return;
      if (isNaN(smooth)) smooth = h; else { let d = ((h - smooth + 540) % 360) - 180; smooth = (smooth + d * .25 + 360) % 360; }
      window.onHeading && window.onHeading(smooth, acc);
    };
    const attach = () => { const ev = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'; window.addEventListener(ev, on); compassH = () => window.removeEventListener(ev, on); };
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().then(r => { if (r === 'granted') attach(); }).catch(() => {});
    else attach();
  }
  function stopCompass() { if (compassH) { compassH(); compassH = null; } }

  /* ---------- focus mode: full screen + screen kept awake ---------- */
  let wake = null;
  async function keepAwake(on) { try { if (on && 'wakeLock' in navigator) { if (!wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } else if (!on && wake) { await wake.release(); wake = null; } } catch (e) {} }
  let focusOn = false;
  function focusEnter(pin) { focusOn = true; keepAwake(true); if (pin) try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {} return JSON.stringify({ dnd: false, pinned: !!pin && !!document.documentElement.requestFullscreen }); }
  function focusExit() { focusOn = false; keepAwake(false); try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {} }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && focusOn) keepAwake(true); });

  /* ---------- dock backgrounds (your own photo or video) ---------- */
  async function dockBgListAsync() {
    const keys = (await idb.keys().catch(() => [])).filter(k => String(k).startsWith('dock/')).sort().reverse(), out = [];
    for (const k of keys) { const b = await idb.get(k); if (b) out.push({ name: k.slice(5), url: await blobUrl(k), video: k.includes('_v'), size: b.size }); }
    return out;
  }
  let dockList = []; const refreshDock = () => dockBgListAsync().then(l => { dockList = l; });
  refreshDock();
  function dockBgPick() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*,video/*';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) { call('onDockBg', null); return; }
      if (f.size > 200 * 1024 * 1024) { call('onDockBg', JSON.stringify({ ok: false, error: 'That file is too large' })); return; }
      const video = /^video\//.test(f.type), name = Date.now() + (video ? '_v' : '_i') + '.' + ((f.name.split('.').pop() || 'bin').toLowerCase());
      try { await idb.set('dock/' + name, f); const url = await blobUrl('dock/' + name); await refreshDock(); call('onDockBg', JSON.stringify({ ok: true, name, url, video })); }
      catch (e) { call('onDockBg', JSON.stringify({ ok: false, error: "Couldn't add that file" })); }
    };
    inp.click();
  }

  /* ---------- the bridge ---------- */
  const cardsCache = { txt: null, key: '' };
  window.Noor = {
    getCards: () => { const k = (liveEnabled() ? 'L' : 'C') + (ls('lastSync') || ''); if (cardsCache.key !== k) { getCurated(); cardsCache.txt = liveEnabled() && live().length ? JSON.stringify(all()) : curatedTxt; cardsCache.key = k; } return cardsCache.txt; },
    getState: () => { const arr = all(), d = today(); return JSON.stringify({ favorites: lsJ('favorites', []), reminders: lsJ('reminders', []), settings: settings(), day: d,
      dailyQuran: dailyOf(arr, 'quran', d), dailyHadith: dailyOf(arr, 'hadith', d), lastSync: +ls('lastSync', 0), liveCount: live().length, curatedCount: getCurated().length,
      night: matchMedia('(prefers-color-scheme: dark)').matches }); },
    setFavorites: j => put('favorites', j), setReminders: j => put('reminders', j),
    setSettings: j => { const was = liveEnabled(); put('settings', j); if (!was && liveEnabled()) runSync(false).then(r => r === 'ok' && call('onSynced', r)); },
    share: t => { if (navigator.share) navigator.share({ text: t }).catch(() => {}); else if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => window.toast && window.toast('Copied to share')); },
    copy: t => { try { navigator.clipboard.writeText(t); } catch (e) { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); } },
    haptic: () => { try { navigator.vibrate && navigator.vibrate(8); } catch (e) {} },
    toast: m => window.toast ? window.toast(m) : console.log(m),
    setLightBars: light => { const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = light ? '#e9edf5' : '#060a17'; document.body && (document.body.style.background = light ? '#e9edf5' : '#060a17'); },
    syncNow: () => runSync(true).then(r => call('onSynced', r)),
    getQuranMeta: () => JSON.stringify(qMeta()),
    getSurah: n => syncGet('quran/' + n + '.json') || '[]',
    getQuranProgress: () => JSON.stringify({ pos: +ls('q_pos', 0), read: ls('q_read', ''), khatm: +ls('q_khatm', 0), last: +ls('q_last', 0) }),
    setQuranProgress: (pos, read, khatm) => qSave(pos, b64ToBytes(read), khatm),
    getDailyLog: () => JSON.stringify({ r: lsJ('log_r', {}), l: lsJ('log_l', {}) }),
    getHeard: () => ls('heard', ''),
    clearHeard: (a, b) => { if (a <= 0 && b >= TOTAL) { del('heard'); return; } const x = b64ToBytes(ls('heard', '')); for (let i = Math.max(0, a); i < b && i < TOTAL; i++) x[i >> 3] &= ~(1 << (i & 7)); put('heard', bytesToB64(x)); },
    getKV: k => k === 'tracker' ? ls('kv_tracker', '{}') : '{}',
    setKV: (k, j) => { if (k === 'tracker' && J(j, null)) put('kv_tracker', j); },
    plantAlarm: (at, t, b) => { if (+at > 0) { put('plant_at', at); put('plant_t', t); put('plant_b', b); } else del('plant_at'); },

    /* widgets are an Android home-screen feature; the web app has none to configure */
    configTarget: () => -1, listWidgets: () => '[]',
    getWidgetConfig: id => { const s = settings(); return JSON.stringify({ id, kind: 'daily', cfg: lsJ('widgetCfg', {})[id] || {}, defaults: { glass: s.widgetGlass || 'midnight', opacity: s.widgetOpacity || 100, arSize: s.widgetArSize || 20, enSize: s.widgetEnSize || 14, arabic: s.widgetArabic !== false, source: s.widgetSource || 'all' } }); },
    saveWidgetConfig: (id, j) => { const a = lsJ('widgetCfg', {}); if (j) a[id] = J(j, {}); else delete a[id]; put('widgetCfg', JSON.stringify(a)); },
    finishConfig: () => {},

    notifStatus: () => JSON.stringify({ granted: notifGranted(), sdk: 34, web: true, supported: 'Notification' in window }),
    requestNotifPermission: () => { if (!('Notification' in window)) { call('onNotifPermission', false); return; } if (Notification.permission === 'granted') { call('onNotifPermission', true); return; }
      Notification.requestPermission().then(p => call('onNotifPermission', p === 'granted')).catch(() => call('onNotifPermission', false)); },
    openNotifSettings: () => window.toast && window.toast('Allow notifications for this site in your browser settings'),
    testNotification: (t, snd) => showReminder(t, snd),

    getReciters: () => JSON.stringify(catalog),
    audioCmd: j => audio.cmd(J(j, {})),
    audioState: () => audio.state(),
    audioDevices: () => JSON.stringify({ list: [{ id: 0, kind: 'speaker', name: 'This device' }], canPick: false, sdk: 34 }),
    openOutputPicker: () => {},
    audioDownload: (id, s) => { audioDownload(id, s).then(cacheSize); },
    audioCancelDownload: () => { dlCancel = true; },
    audioCacheInfo: id => JSON.stringify({ bytes: +ls('dl_bytes', 0), reciterBytes: 0, surahs: lsJ('dl_' + id, []) }),
    audioClearCache: id => { audioClear(id); },

    hadithSearchReady: () => ls('hadith_ready') === '1',
    searchOnline: (id, q) => { hadithSearch(q).then(r => call('onOnlineSearch', id, JSON.stringify(r))); },

    getTimes: () => syncGet('times.json') || '{}',
    getTimesState: () => ls('times_state', '{}'),
    setTimesState: j => { if (J(j, null)) put('times_state', j); },
    getTafsirCached: k => /^\d{1,3}:\d{1,3}$/.test(k || '') ? (lsJ('tafsir', {})[k] || '') : '',
    fetchTafsir: k => { if (!/^\d{1,3}:\d{1,3}$/.test(k || '')) return;
      getJson('https://api.quran.com/api/v4/tafsirs/169/by_ayah/' + k).then(d => { const t = ((d.tafsir && d.tafsir.text) || '').replace(/[\u2028\u2029]/g, ' ');
        if (t) { const a = lsJ('tafsir', {}); a[k] = t; put('tafsir', JSON.stringify(a)); } call('onTafsir', k, t || null); }).catch(() => call('onTafsir', k, null)); },

    prayerStatus: () => JSON.stringify({ exact: true, notif: notifGranted(), have: adhan.have(), customName: ls('pt_custom_name', ''), h24: !/[AP]M/i.test(new Date(2000, 0, 1, 13).toLocaleTimeString()), playing: adhan.playing() }),
    requestLocation, hasLocationPermission: () => ls('loc_granted') === '1',
    openAppSettings: () => window.toast && window.toast('Allow location for this site in your browser settings'),
    openExactAlarmSettings: () => {},
    hasCompass, startCompass, stopCompass,
    adhanDownload: (id, file, bases) => { adhan.download(id, file, bases); },
    adhanDelete: id => { if (!/^[a-z0-9_]{1,40}$/.test(id || '')) return; idb.del('adhan/' + id).catch(() => {}); delete blobUrls['adhan/' + id]; adhan.setHave(adhan.have().filter(x => x !== id)); if (id === 'custom') del('pt_custom_name'); },
    adhanPreview: (id, url) => adhan.preview(id, url),
    adhanPreviewStop: () => adhan.previewStop(true),
    adhanTest: id => { if (!adhan.have().includes(id)) return false; adhan.play(id, true); return true; },
    adhanStop: () => adhan.stop(),
    pickAdhanFile: () => adhan.pick(),
    refreshPrayer: () => {},

    focusDndAllowed: () => false,
    focusEnter: (n, pin) => focusEnter(pin), focusEnter2: (n, c, pin) => focusEnter(pin),
    focusExit, focusOpenDnd: () => {}, focusReapply: () => { if (focusOn) keepAwake(true); }, focusRestore: () => {},
    dockOrient: land => { try { if (land) screen.orientation.lock('landscape').catch(() => {}); else screen.orientation.unlock(); } catch (e) {} },
    dockBgList: () => JSON.stringify(dockList), dockBgPick,
    dockBgDelete: name => { if (!name || name.includes('/')) return; idb.del('dock/' + name).then(refreshDock).catch(() => {}); }
  };

  /* ---------- app lifecycle: back button, theme, resume, background sync, scheduler ---------- */
  window.addEventListener('DOMContentLoaded', () => {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => window.onSystemTheme && window.onSystemTheme(e.matches));
    /* Android Back: one history entry that the page consumes, like the app's onBackPressed */
    try { history.replaceState({ noor: 'root' }, ''); history.pushState({ noor: 'top' }, ''); } catch (e) {}
    window.addEventListener('popstate', () => { let handled = false; try { handled = window.onBack && window.onBack(); } catch (e) {} if (handled) history.pushState({ noor: 'top' }, ''); else history.back(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { try { window.onAppResume && window.onAppResume(); } catch (e) {} tick(); maybeSync(); } });
    const tab = new URLSearchParams(location.search).get('tab'); if (tab && window.openFromWidget) setTimeout(() => window.openFromWidget(tab), 300);
    setInterval(tick, 15000);
    maybeSync();
  });
  function maybeSync() { if (!liveEnabled()) return; const d = today(); if (ls('live_quran_' + d) !== null && ls('live_hadith_' + d) !== null) return; runSync(false).then(r => { if (r === 'ok') call('onSynced', r); }); }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.tab && window.openFromWidget) window.openFromWidget(e.data.tab); });
  }
})();
