// Copies the playable game (no tools) into dist/ - the folder the website
// (GitHub Pages), the desktop app (Electron) and the Android app (Capacitor)
// are built from.
// Usage: node tools/build-web.mjs
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const FILES = ['index.html', 'style.css', 'manifest.webmanifest', 'sw.js', 'icons', 'src'];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const f of FILES) cpSync(root + f, dist + f, { recursive: true });
console.log(`copied ${FILES.join(', ')} -> dist/`);
