/* ============================================================================
 * FieldBook Pro — Web bridge shim (PWA)
 * ----------------------------------------------------------------------------
 * Implements window.FBNative with EXACTLY the same method names, argument order,
 * synchronous/asynchronous semantics, and window.fbOn... / window.__fb... callbacks
 * that app.html expects from the Android NativeBridge.kt.
 *
 * Storage model (iOS-safe): everything is persisted in IndexedDB. Sync-return
 * native methods (saveDataFile/listDataFiles/savePhoto/dataFileExists/hasFolder
 * /folderName) are served from a synchronous in-memory mirror that is hydrated
 * from IndexedDB at boot and written through to IndexedDB asynchronously.
 *
 * File "export" on iOS = Web Share API (navigator.share files) with a Download
 * fallback. Photos = <input capture>/gallery. GPS = navigator.geolocation.
 * Voice = webkitSpeechRecognition. App-lock / biometric = WebAuthn (Face/Touch
 * ID) with a graceful fail-open, mirroring NativeBridge.promptAppLock.
 * ========================================================================== */
(function () {
  'use strict';

  if (window.FBNative && !window.FBNative.__isWebShim) {
    // A real native bridge is present (running inside the Android WebView). Do
    // nothing so we never shadow it.
    return;
  }

  var APP_VERSION = '1.0';

  // -------------------------------------------------------------- IndexedDB
  var DB_NAME = 'FieldBookProPWA';
  var DB_VER = 1;
  var STORE_KV = 'kv';        // misc keys: app_lock, root_folder marker
  var STORE_FILES = 'files';  // data files:  key=name -> {name,content,kind,meta,modified}
  var STORE_PHOTOS = 'photos';// photos:      key=path -> {path,dataUrl,meta,modified}

  var _db = null;
  var _ready = false;
  var _readyWaiters = [];

  // Synchronous mirrors (hydrated from IDB at boot, written through on change)
  var memFiles = Object.create(null);   // name -> record
  var memPhotos = Object.create(null);  // path -> record
  var memKV = Object.create(null);      // key  -> value

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
        if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES, { keyPath: 'name' });
        if (!db.objectStoreNames.contains(STORE_PHOTOS)) db.createObjectStore(STORE_PHOTOS, { keyPath: 'path' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGetAll(store) {
    return new Promise(function (resolve, reject) {
      var out = [];
      var tx = _db.transaction(store, 'readonly');
      var cur = tx.objectStore(store).openCursor();
      cur.onsuccess = function (e) {
        var c = e.target.result;
        if (c) { out.push({ key: c.key, val: c.value }); c.continue(); }
        else resolve(out);
      };
      cur.onerror = function () { reject(cur.error); };
    });
  }

  function idbPut(store, value, key) {
    if (!_db) return Promise.resolve();
    return new Promise(function (resolve) {
      try {
        var tx = _db.transaction(store, 'readwrite');
        if (key === undefined) tx.objectStore(store).put(value);
        else tx.objectStore(store).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }

  function idbDelete(store, key) {
    if (!_db) return Promise.resolve();
    return new Promise(function (resolve) {
      try {
        var tx = _db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }

  function whenReady(cb) { if (_ready) cb(); else _readyWaiters.push(cb); }

  function boot() {
    return openDb().then(function (db) {
      _db = db;
      return Promise.all([
        idbGetAll(STORE_FILES), idbGetAll(STORE_PHOTOS), idbGetAll(STORE_KV)
      ]);
    }).then(function (res) {
      res[0].forEach(function (r) { memFiles[r.val.name] = r.val; });
      res[1].forEach(function (r) { memPhotos[r.val.path] = r.val; });
      res[2].forEach(function (r) { memKV[r.key] = r.val; });
      _ready = true;
      _readyWaiters.splice(0).forEach(function (cb) { try { cb(); } catch (e) {} });
    }).catch(function (e) {
      // If IDB is unavailable, run purely in-memory so the UI still works.
      _ready = true;
      _readyWaiters.splice(0).forEach(function (cb) { try { cb(); } catch (e2) {} });
      console.warn('[FBWeb] IndexedDB unavailable, memory-only mode:', e);
    });
  }

  // ------------------------------------------------------------------ utils
  function jsBool(v) { return !!v; }
  function nowMs() { return Date.now(); }
  function stripDataUrl(s) { var i = s.indexOf('base64,'); return i >= 0 ? s.substring(i + 7) : s; }
  function safe(s) {
    return String(s || '').replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'NA';
  }
  function parseMeta(s) { try { return s ? JSON.parse(s) : {}; } catch (e) { return {}; } }
  function b64ToBlob(b64, mime) {
    var bin = atob(b64), len = bin.length, arr = new Uint8Array(len);
    for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'application/octet-stream' });
  }
  function mimeForName(name) {
    var n = String(name).toLowerCase();
    if (n.endsWith('.csv')) return 'text/csv';
    if (n.endsWith('.json')) return 'application/json';
    if (n.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (n.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (n.endsWith('.txt') || n.endsWith('.log')) return 'text/plain';
    if (n.endsWith('.pdf')) return 'application/pdf';
    if (n.endsWith('.zip')) return 'application/zip';
    return 'application/octet-stream';
  }
  function isBinaryB64(kind, name) {
    var n = String(name).toLowerCase();
    return n.endsWith('.xlsx') || n.endsWith('.pptx');
  }
  function callJs(fnName, args) {
    try { if (typeof window[fnName] === 'function') window[fnName].apply(window, args || []); } catch (e) {}
  }

  // Download helper (fallback when Web Share files unsupported)
  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  // ============================================================ THE BRIDGE
  var FB = {
    __isWebShim: true,

    // ---- META
    appVersion: function () { return 'v' + APP_VERSION + ' (Field Edition · PWA)'; },

    // ---- STORAGE (folder). On iOS there is no SAF folder; we emulate a single
    // logical root that is always "present" once the user confirms it, so the
    // app's hasFolder()/folderName() gates behave identically.
    hasFolder: function () { return !!memKV['root_folder']; },
    folderName: function () { return memKV['root_folder'] || ''; },
    pickFolder: function () {
      // Emulate the SAF tree picker. In the PWA the "folder" is internal
      // storage; we set a name and fire the same fbOnFolderPicked(true) callback.
      var name = 'FieldBook Pro (device storage)';
      memKV['root_folder'] = name;
      idbPut(STORE_KV, name, 'root_folder');
      setTimeout(function () {
        callJs('fbOnFolderPicked', [true]);
        if (window.__fbAfterRepick) { var f = window.__fbAfterRepick; window.__fbAfterRepick = null; try { f(); } catch (e) {} }
      }, 0);
    },
    repickFolder: function () { FB.pickFolder(); },
    clearPrevRoot: function () { /* no-op: single logical root */ },
    migrateData: function () { return false; /* nothing to migrate between roots */ },
    openFolder: function () {
      // No OS file browser in a PWA; surface the export/share flow instead.
      try { alert('Files are stored inside the app. Use "Share files" / Download to export them.'); } catch (e) {}
    },

    // saveDataFile is called SYNCHRONOUSLY and its boolean is used inline.
    saveDataFile: function (filename, content, kind, metaJson) {
      try {
        var rec = {
          name: filename,
          content: content,
          kind: kind || '',
          meta: metaJson || '{}',
          binary: isBinaryB64(kind, filename),
          modified: nowMs()
        };
        memFiles[filename] = rec;           // synchronous mirror update
        idbPut(STORE_FILES, rec);           // async write-through
        return true;
      } catch (e) { return false; }
    },

    dataFileExists: function (filename) { return !!memFiles[filename]; },

    // readDataFile is ASYNC via __fbReadOk/__fbReadErr
    readDataFile: function (path) {
      whenReady(function () {
        var rec = memFiles[path] || memFiles[String(path).split('/').pop()];
        setTimeout(function () {
          if (rec && typeof rec.content === 'string' && !rec.binary) callJs('__fbReadOk', [rec.content]);
          else if (rec && typeof rec.content === 'string') callJs('__fbReadOk', [rec.content]);
          else callJs('__fbReadErr', []);
        }, 0);
      });
    },

    // listDataFiles is SYNCHRONOUS and returns a JSON string.
    listDataFiles: function () {
      var out = [];
      for (var k in memFiles) {
        var r = memFiles[k];
        out.push({ name: r.name, path: r.name, modified: r.modified });
      }
      return JSON.stringify(out);
    },

    // ---- CRASH BACKUP
    saveCrashBackup: function (content) {
      try {
        var rec = { name: '__crash_autosave.json', content: content, kind: 'backup', meta: '{}', binary: false, modified: nowMs() };
        memFiles['__crash_autosave.json'] = rec;
        idbPut(STORE_FILES, rec);
        return true;
      } catch (e) { return false; }
    },
    readCrashBackup: function () {
      whenReady(function () {
        var rec = memFiles['__crash_autosave.json'];
        setTimeout(function () {
          if (rec && rec.content) callJs('__fbCrashOk', [rec.content]);
          else callJs('__fbCrashNone', []);
        }, 0);
      });
    },
    clearCrashBackup: function () {
      delete memFiles['__crash_autosave.json'];
      idbDelete(STORE_FILES, '__crash_autosave.json');
    },

    // ---- RESTORE (file picker) -> __fbRestoreOk(txt,name) / __fbRestoreErr()
    pickRestore: function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'application/json,text/*,.json,.csv,.txt';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) { callJs('__fbRestoreErr', []); return; }
        var fr = new FileReader();
        fr.onload = function () { callJs('__fbRestoreOk', [String(fr.result || ''), f.name]); };
        fr.onerror = function () { callJs('__fbRestoreErr', []); };
        fr.readAsText(f);
      };
      inp.click();
    },

    // ---- PHOTOS
    // savePhoto is SYNCHRONOUS and returns the stored path string.
    savePhoto: function (dataUrl, metaJson) {
      try {
        var meta = parseMeta(metaJson);
        var trial = safe(meta.folder || 'Trial');
        var obs = safe(meta.obs || 'obs');
        var tp = safe(meta.tp || '') || 'No interval';
        var plot = safe(meta.plot || 'plot');
        var idx = meta.photoIndex || 1;
        var fname = (obs + '_' + tp + '_' + plot + '_' + idx + '.jpg').replace(/ /g, '-');
        var path = 'FieldBook Pro/' + trial + '/Photos/' + obs + '/' + tp + '/' + plot + '/' + fname;
        var rec = { path: path, dataUrl: dataUrl, meta: metaJson || '{}', modified: nowMs() };
        memPhotos[path] = rec;              // synchronous mirror
        idbPut(STORE_PHOTOS, rec);          // async write-through
        return path;
      } catch (e) { return ''; }
    },
    // readPhoto is SYNCHRONOUS and returns a data URL string.
    readPhoto: function (path) {
      var r = memPhotos[path];
      return r ? r.dataUrl : '';
    },
    deletePhoto: function (path) {
      delete memPhotos[path];
      idbDelete(STORE_PHOTOS, path);
    },
    takePhoto: function () { pickImage(true); },
    pickGallery: function () { pickImage(false); },
    pickFile: function () { pickImage(false); },

    // ---- GPS -> fbOnGps(lat,lon,acc,alt) / fbOnGpsError(msg)
    getGps: function () {
      if (!navigator.geolocation) { callJs('fbOnGpsError', ['no geolocation']); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        var c = pos.coords;
        var alt = (typeof c.altitude === 'number' && !isNaN(c.altitude)) ? c.altitude : null;
        callJs('fbOnGps', [c.latitude, c.longitude, c.accuracy, alt]);
      }, function (err) {
        callJs('fbOnGpsError', [err && err.message ? err.message : 'gps error']);
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    },

    // ---- WEATHER (same Open-Meteo endpoints) -> fbOnWeather(json) / fbOnWeatherError(msg)
    fetchWeather: function (lat, lon, start, end) {
      var daily = 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,' +
        'relative_humidity_2m_mean,precipitation_sum,wind_speed_10m_max,shortwave_radiation_sum';
      var dayMs = 86400000;
      var today = new Date(); today.setUTCHours(0, 0, 0, 0);
      var cutoff = new Date(today.getTime() - 6 * dayMs);
      var startD = parseYmd(start) || today;
      var endD = parseYmd(end) || today;
      if (endD > today) endD = today;
      var urls = [];
      if (startD <= cutoff) {
        var archEnd = endD < cutoff ? endD : cutoff;
        urls.push('https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon +
          '&start_date=' + ymd(startD) + '&end_date=' + ymd(archEnd) + '&daily=' + daily + '&timezone=auto');
      }
      if (endD > cutoff) {
        var recStart = startD > cutoff ? startD : new Date(cutoff.getTime() + dayMs);
        var pastDays = Math.min(92, Math.max(1, Math.floor((today.getTime() - recStart.getTime()) / dayMs) + 1));
        urls.push('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
          '&daily=' + daily + '&past_days=' + pastDays + '&forecast_days=1&timezone=auto');
      }
      if (!urls.length) {
        urls.push('https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon +
          '&start_date=' + start + '&end_date=' + end + '&daily=' + daily + '&timezone=auto');
      }
      mergeWeather(urls, start, ymd(endD)).then(function (merged) {
        callJs('fbOnWeather', [merged]);
      }).catch(function (e) {
        callJs('fbOnWeatherError', [e && e.message ? e.message : 'weather error']);
      });
    },
    fetchWeatherCMA: function (lat, lon, start, end) {
      var url = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon +
        '&start_date=' + start + '&end_date=' + end +
        '&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,' +
        'relative_humidity_2m_mean,precipitation_sum,wind_speed_10m_max,shortwave_radiation_sum&timezone=auto';
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (body) { callJs('__fbCmaOk', [body]); })
        .catch(function (e) { callJs('__fbCmaErr', [e && e.message ? e.message : 'network error']); });
    },
    openMap: function (lat, lon, label) {
      var q = encodeURIComponent(label || '');
      var url = 'https://maps.google.com/?q=' + lat + ',' + lon + (q ? ('(' + q + ')') : '');
      try { window.open(url, '_blank'); } catch (e) {}
    },
    openLocationSettings: function () {
      try { alert('Enable Location for this site in your browser settings to use GPS.'); } catch (e) {}
    },

    // ---- VOICE -> fbOnVoice(targetId,text) / fbOnVoiceError(msg)
    startVoice: function (targetId, locale) {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { callJs('fbOnVoiceError', ['voice unsupported']); return; }
      try {
        var rec = new SR();
        rec.lang = locale || 'en-US';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.onresult = function (ev) {
          var text = (ev.results && ev.results[0] && ev.results[0][0]) ? ev.results[0][0].transcript : '';
          callJs('fbOnVoice', [targetId, text]);
        };
        rec.onerror = function (ev) { callJs('fbOnVoiceError', [ev && ev.error ? ev.error : 'voice error']); };
        rec.start();
      } catch (e) { callJs('fbOnVoiceError', [e && e.message ? e.message : 'voice error']); }
    },

    // ---- AUTH (WebAuthn platform authenticator = Face ID / Touch ID / Windows Hello)
    // In-app biometric sign-in -> __fbBioOk() / __fbBioErr(msg)
    biometricAuth: function () {
      webauthnVerify().then(function () { callJs('__fbBioOk', []); })
        .catch(function (e) { callJs('__fbBioErr', [e && e.message ? e.message : 'auth failed']); });
    },
    // App-lock toggle. Returns boolean like native setAppLock.
    setAppLock: function (enabled) {
      if (enabled && !(window.PublicKeyCredential)) return false; // no platform auth -> refuse, like native
      memKV['app_lock'] = !!enabled;
      idbPut(STORE_KV, !!enabled, 'app_lock');
      return true;
    },
    isAppLockEnabled: function () { return !!memKV['app_lock']; },

    // ---- SHARE / EMAIL -> fbOnShareDone(count) / fbOnShareError(msg)
    shareFiles: function (filenamesCsv, subject, body) {
      var names = String(filenamesCsv || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean);
      var recs = names.map(function (n) { return memFiles[n]; }).filter(Boolean);
      if (!recs.length) { callJs('fbOnShareError', ['no-files']); return; }
      var files = recs.map(function (r) {
        var mime = mimeForName(r.name);
        var blob = r.binary ? b64ToBlob(stripDataUrl(r.content), mime)
                            : new Blob([r.content], { type: mime });
        return new File([blob], r.name, { type: mime });
      });
      // Prefer Web Share API with files (works on iOS Safari + Android Chrome)
      if (navigator.canShare && navigator.canShare({ files: files })) {
        navigator.share({ files: files, title: subject || 'FieldBook Pro export', text: body || '' })
          .then(function () { callJs('fbOnShareDone', [files.length]); })
          .catch(function (e) {
            if (e && e.name === 'AbortError') { callJs('fbOnShareDone', [files.length]); return; }
            // fall back to downloads
            files.forEach(function (f) { download(f, f.name); });
            callJs('fbOnShareDone', [files.length]);
          });
      } else {
        // Download fallback (desktop / unsupported)
        files.forEach(function (f) { download(f, f.name); });
        callJs('fbOnShareDone', [files.length]);
      }
    },
    emailFiles: function (filenamesCsv, subject, body) { FB.shareFiles(filenamesCsv, subject, body); },

    // ---- LOGGING (native no-ops mapped to console/persist)
    logCatalog: function (line) { /* kept in memFiles via saveDataFile from app side */ },
    flushLog: function (metaJson) { return true; }
  };

  // ---------------------------------------------------- image picker helper
  function pickImage(useCamera) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    if (useCamera) inp.setAttribute('capture', 'environment');
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) { callJs('fbOnPhoto', ['']); return; }
      downscaleToDataUrl(f, 1600, 0.82).then(function (dataUrl) {
        callJs('fbOnPhoto', [dataUrl]);
      }).catch(function () { callJs('fbOnPhoto', ['']); });
    };
    inp.click();
  }

  // Downscale + JPEG re-encode in the browser (mirrors native downscaleToDataUrl)
  function downscaleToDataUrl(file, maxEdge, quality) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          var le = Math.max(w, h);
          var scale = le > maxEdge ? maxEdge / le : 1;
          var nw = Math.max(1, Math.round(w * scale));
          var nh = Math.max(1, Math.round(h * scale));
          var cv = document.createElement('canvas');
          cv.width = nw; cv.height = nh;
          cv.getContext('2d').drawImage(img, 0, 0, nw, nh);
          var dataUrl = cv.toDataURL('image/jpeg', quality);
          URL.revokeObjectURL(url);
          resolve(dataUrl);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  // ---------------------------------------------------- weather merge helper
  function parseYmd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); if (!m) return null; var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return isNaN(d) ? null : d; }
  function ymd(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }

  function mergeWeather(urls, startClamp, endClamp) {
    var cols = ['temperature_2m_max', 'temperature_2m_min', 'temperature_2m_mean',
      'relative_humidity_2m_mean', 'precipitation_sum', 'wind_speed_10m_max', 'shortwave_radiation_sum'];
    return Promise.all(urls.map(function (u) {
      return fetch(u).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).catch(function () { return null; });
    })).then(function (bodies) {
      var byDate = {};
      bodies.forEach(function (root) {
        if (!root || !root.daily || !root.daily.time) return;
        var times = root.daily.time;
        for (var i = 0; i < times.length; i++) {
          var date = times[i];
          if (date < startClamp || date > endClamp) continue;
          var row = byDate[date] || (byDate[date] = {});
          cols.forEach(function (c) {
            var arr = root.daily[c];
            if (arr && i < arr.length && arr[i] != null) row[c] = arr[i];
          });
        }
      });
      var dates = Object.keys(byDate).sort();
      if (!dates.length) throw new Error('No weather data');
      var daily = { time: dates };
      cols.forEach(function (c) { daily[c] = dates.map(function (d) { return (c in byDate[d]) ? byDate[d][c] : null; }); });
      return JSON.stringify({ daily: daily });
    });
  }

  // ---------------------------------------------------- WebAuthn (biometric)
  function b64urlToBuf(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = atob(s), buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function webauthnVerify() {
    // A lightweight local-only "user presence" check via platform authenticator.
    // We don't run a server; we just require a successful platform gesture. If
    // WebAuthn is unavailable we FAIL OPEN (mirrors native promptAppLock).
    if (!window.PublicKeyCredential || !navigator.credentials) return Promise.resolve();
    var challenge = new Uint8Array(32); (crypto.getRandomValues || function () {})(challenge);
    return navigator.credentials.get({
      publicKey: {
        challenge: challenge,
        timeout: 60000,
        userVerification: 'preferred',
        allowCredentials: [] // any platform credential / presence
      }
    }).then(function () { return true; }).catch(function (e) {
      // If there is simply no credential enrolled, fail open like the native gate.
      if (e && (e.name === 'NotAllowedError' || e.name === 'InvalidStateError')) throw e;
      return true;
    });
  }

  // ------------------------------------------------ launch app-lock overlay
  function armAppLockGate() {
    if (!FB.isAppLockEnabled()) return;
    var ov = document.createElement('div');
    ov.id = 'fbLockOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0D3D0D;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;';
    ov.innerHTML = '<div style="font-size:24px">FieldBook Pro</div>' +
      '<div style="font-size:44px;margin:24px 0">\uD83D\uDD12</div>' +
      '<div id="fbLockMsg" style="color:#C8E6C9;font-size:15px">Locked — authenticate to continue</div>' +
      '<button id="fbLockBtn" style="margin-top:24px;padding:10px 24px;font-size:16px">Unlock</button>';
    document.documentElement.appendChild(ov);
    function tryUnlock() {
      webauthnVerify().then(function () { ov.remove(); })
        .catch(function () { var m = document.getElementById('fbLockMsg'); if (m) m.textContent = 'Authentication failed — tap Unlock to retry'; });
    }
    ov.querySelector('#fbLockBtn').addEventListener('click', tryUnlock);
    tryUnlock();
  }

  // -------------------------------------------------------------- install
  window.FBNative = FB;

  boot().then(function () {
    // Re-arm lock when returning to foreground, like MainActivity.onResume.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') armAppLockGate();
    });
    armAppLockGate();
    // Flush any saves queued before the shim was ready.
    try {
      if (window.__fbPendingSaves && window.__fbPendingSaves.length) {
        window.__fbPendingSaves.splice(0).forEach(function (s) {
          try { FB.saveDataFile(s.filename, s.content, s.kind, s.meta); } catch (e) {}
        });
      }
    } catch (e) {}
  });

  console.log('[FBWeb] FBNative web shim installed.');
})();