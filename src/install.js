// "Get the app" support.
//
// - Windows:  downloads the desktop installer (.exe) from the latest GitHub Release.
// - Android:  downloads the Android app (.apk) from the latest GitHub Release.
// - iPhone / iPad: Apple only allows App Store apps, so we explain
//   "Share -> Add to Home Screen", which installs the game as a full-screen app.
// - Everything else (macOS, Linux, ChromeOS): the browser's install prompt (PWA).
//
// The .exe, .apk and .AppImage are built by .github/workflows/release.yml
// whenever a version tag (v1.0.0, v1.1.0, ...) is pushed.
//
// Every browser API is feature-checked, so this is a no-op in Node.

export const REPO = 'mahinjaman/Mission-Impossible';
const LATEST = `https://github.com/${REPO}/releases/latest/download`;
export const DOWNLOADS = {
  windows: `${LATEST}/MissionImpossible-Setup.exe`,
  android: `${LATEST}/MissionImpossible.apk`,
};

let deferred = null;          // the captured beforeinstallprompt event
let onChange = () => {};

const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent ?? '');

/** 'windows' | 'android' | 'ios' | 'other' */
export function platform() {
  const u = ua();
  if (/Android/i.test(u)) return 'android';
  if (/iPad|iPhone|iPod/.test(u) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Windows/i.test(u)) return 'windows';
  return 'other';
}

/** True inside the packaged desktop (Electron) or Android (Capacitor) app. */
export function isNativeApp() {
  return /Electron/i.test(ua()) || (typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.());
}

export function initInstall(changed) {
  onChange = changed;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; onChange(); });
  window.addEventListener('appinstalled', () => { deferred = null; onChange(); });
}

/** True when already running as an app (installed PWA or native build). */
export function isInstalled() {
  if (isNativeApp()) return true;
  try {
    return matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches
      || navigator.standalone === true;
  } catch { return false; }
}

/** Menu label for the download button. */
export function installLabel() {
  switch (platform()) {
    case 'windows': return 'GET PC APP';
    case 'android': return 'GET ANDROID APP';
    case 'ios': return 'GET IPHONE APP';
    default: return 'INSTALL APP';
  }
}

function download(url) {
  try {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch { location.href = url; }
}

/** Start the right install for this device. Returns a short message for a toast (or null). */
export async function promptInstall() {
  const p = platform();
  if (p === 'windows') { download(DOWNLOADS.windows); return 'Downloading MissionImpossible-Setup.exe ...'; }
  if (p === 'android') { download(DOWNLOADS.android); return 'Downloading MissionImpossible.apk ...'; }
  if (p === 'ios') return 'Safari: tap Share, then "Add to Home Screen"';
  if (deferred) {
    const e = deferred;
    deferred = null;
    e.prompt();
    const { outcome } = await e.userChoice;
    onChange();
    return outcome === 'accepted' ? 'Installing Mission Impossible...' : null;
  }
  return 'Use the browser menu: "Install app"';
}
