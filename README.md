# Noor

Noor for the web: the Noor Android app (v3.28.1) running in the browser. It has daily Qur'an and Sunnah cards, prayer times with adhan and alerts, Qibla, the Qur'an reader with progress, recitation with 27 reciters, Sahih al-Bukhari and Sahih Muslim offline, adhkar, the "In times of…" topics, the progress tracker, focus mode and the dock clock.

**Live:** https://munazzar.github.io/noor/

## How it is built

The Android app is a WebView around `index.html`. Its native features are called through a JavaScript bridge (`window.Noor`). This site ships the same page and assets. `web/bridge.js` re-implements every bridge call with web APIs, following the app's Java logic:

| Android | Web |
| --- | --- |
| SharedPreferences | `localStorage` |
| AudioService / AudioPlan (verse-by-verse, repeat, translation, gap, sleep timer, mp3quran surah timing) | `<audio>` with the same plan rules, Media Session controls |
| Offline surah audio, adhan files, dock backgrounds | Cache API and IndexedDB |
| Location, compass sensor | Geolocation, DeviceOrientation |
| Notifications and AlarmManager | Notification API; reminders and prayer alerts fire while Noor is open |
| Live daily verse and hadith sync, tafsir, hadith search | Same public APIs (alquran.cloud, fawazahmed0/hadith-api, quran.com) |
| Focus mode (DND, screen pinning) | Full screen and Screen Wake Lock |

On screens 1024px and wider, `web/desktop.css` and `web/desktop.js` switch to a desktop layout: a side navigation bar, a wider page, two-column Today and Library, multi-column surah lists and grids, and sheets that open as centred dialogs. Phones get the app's layout unchanged.

`sw.js` makes the app installable and usable offline after the first visit.

Home-screen widgets and background alarms are Android-only, so the web app has nothing to configure for them.

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.
