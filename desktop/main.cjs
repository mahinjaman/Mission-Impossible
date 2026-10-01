// Electron entry point for the Windows / macOS / Linux desktop app.
// The game is served from dist/ through a private app:// scheme so ES modules,
// localStorage and fetch behave exactly like they do on a website.
const { app, BrowserWindow, protocol, net, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 752,
    minWidth: 640,
    minHeight: 380,
    backgroundColor: '#03050a',
    title: 'Mission Impossible',
    icon: path.join(ROOT, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  // F11 toggles fullscreen
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  // open external links (e.g. GitHub) in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL('app://game/index.html');

  // Self-test used when building: MI_SNAPSHOT=out.png saves a screenshot and quits.
  const snap = process.env.MI_SNAPSHOT;
  if (snap) {
    win.webContents.on('did-fail-load', (e, code, desc, url) => console.log('load failed', code, desc, url));
    win.webContents.on('console-message', (e, ...a) => console.log('page:', a.join(' ')));
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try { const img = await win.webContents.capturePage(); require('node:fs').writeFileSync(snap, img.toPNG()); console.log('snapshot', snap, img.getSize()); } catch (err) { console.log('snapshot failed', err); }
      app.quit();
    }, 2500));
  }
}

app.whenReady().then(() => {
  protocol.handle('app', req => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
