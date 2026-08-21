/* FieldBook Pro — Install banner + PWA UX helpers
 * ----------------------------------------------------------------------------
 * - Shows a small "Add to Home Screen" banner when the browser fires
 *   beforeinstallprompt (Android/Chromium/Edge). Tapping Install calls the
 *   native prompt. Dismissals are remembered for 14 days.
 * - On iOS/Safari (no beforeinstallprompt) shows a one-time hint explaining
 *   the Share -> "Add to Home Screen" gesture.
 * - Hides itself automatically once the app is running installed (standalone).
 * - Shows a "New version available - Refresh" toast when the service worker
 *   detects an update, so users always get the latest deploy.
 *
 * This file is intentionally framework-free and safe to load on any page.
 */
(function () {
  'use strict';

  var DISMISS_KEY = 'fb_install_dismissed_until';
  var IOS_HINT_KEY = 'fb_ios_hint_shown';

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true;
  }
  // Safe localStorage wrappers — some browsers throw in private mode or on
  // opaque origins. Never let storage errors break the banner.
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function dismissedRecently() {
    var until = parseInt(lsGet(DISMISS_KEY) || '0', 10);
    return until && Date.now() < until;
  }
  function remember(days) {
    lsSet(DISMISS_KEY, String(Date.now() + days * 864e5));
  }
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // ---------- banner DOM ----------
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function makeBanner(opts) {
    var bar = el('div', [
      'position:fixed', 'left:12px', 'right:12px', 'bottom:12px', 'z-index:99999',
      'background:#0D3D0D', 'color:#fff', 'border-radius:14px',
      'box-shadow:0 6px 24px rgba(0,0,0,.35)', 'padding:12px 14px',
      'display:flex', 'align-items:center', 'gap:12px',
      'font-family:system-ui,sans-serif', 'font-size:14px',
      'max-width:520px', 'margin:0 auto'
    ].join(';'));
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Install FieldBook Pro');

    var icon = el('div', 'font-size:26px;flex:none', '🌱');
    var txt = el('div', 'flex:1;line-height:1.3');
    txt.appendChild(el('div', 'font-weight:800', opts.title));
    txt.appendChild(el('div', 'opacity:.85;font-size:12px;margin-top:2px', opts.sub));

    var actions = el('div', 'display:flex;gap:8px;flex:none;align-items:center');
    if (opts.installText) {
      var install = el('button', [
        'background:#4CAF50', 'color:#fff', 'border:0', 'border-radius:10px',
        'padding:9px 14px', 'font-weight:800', 'font-size:13px', 'cursor:pointer'
      ].join(';'), opts.installText);
      install.onclick = opts.onInstall;
      actions.appendChild(install);
    }
    var close = el('button', [
      'background:transparent', 'color:#fff', 'border:0', 'font-size:20px',
      'cursor:pointer', 'opacity:.8', 'line-height:1', 'padding:4px 6px'
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Dismiss');
    close.onclick = function () { remember(14); bar.remove(); };
    actions.appendChild(close);

    bar.appendChild(icon); bar.appendChild(txt); bar.appendChild(actions);
    return bar;
  }

  var deferredPrompt = null;
  var shown = false;

  function showChromiumBanner() {
    if (shown || isStandalone() || dismissedRecently()) return;
    shown = true;
    var bar = makeBanner({
      title: 'Install FieldBook Pro',
      sub: 'Add it to your home screen for offline, full-screen use.',
      installText: 'Install',
      onInstall: function () {
        if (!deferredPrompt) { bar.remove(); return; }
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () {
          deferredPrompt = null; bar.remove();
        });
      }
    });
    document.body.appendChild(bar);
  }

  function showIOSHint() {
    if (isStandalone() || dismissedRecently()) return;
    if (localStorage.getItem(IOS_HINT_KEY)) return;
    localStorage.setItem(IOS_HINT_KEY, '1');
    var bar = makeBanner({
      title: 'Add FieldBook Pro to Home Screen',
      sub: 'Tap the Share icon, then “Add to Home Screen”.',
      installText: '',
      onInstall: null
    });
    document.body.appendChild(bar);
  }

  // beforeinstallprompt (Chromium/Android/Edge)
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showChromiumBanner();
  });

  // Hide/cleanup once actually installed
  window.addEventListener('appinstalled', function () {
    remember(3650);
    var bars = document.querySelectorAll('[aria-label="Install FieldBook Pro"]');
    for (var i = 0; i < bars.length; i++) bars[i].remove();
  });

  // iOS has no beforeinstallprompt — show the manual hint after load.
  window.addEventListener('load', function () {
    if (isIOS() && !isStandalone()) setTimeout(showIOSHint, 1500);
  });

  // ---------- update toast (new deploy available) ----------
  window.fbShowUpdateToast = function (onReload) {
    if (document.getElementById('fb-update-toast')) return;
    var bar = makeBanner({
      title: 'Update available',
      sub: 'A new version of FieldBook Pro is ready.',
      installText: 'Refresh',
      onInstall: function () { (onReload || function(){ location.reload(); })(); }
    });
    bar.id = 'fb-update-toast';
    bar.setAttribute('aria-label', 'FieldBook Pro update');
    document.body.appendChild(bar);
  };
})();
