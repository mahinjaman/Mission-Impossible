// App icon generator: a neon reticle with a lit-fuse "M" and its spark.
// Writes icons/icon.svg and rasterises the same geometry (signed-distance
// shapes, anti-aliased) into PNGs with zero dependencies (node:zlib).
// Artwork stays inside the centre 80% so the PNGs work as maskable icons.
// Usage: node tools/icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---- geometry (512 x 512 design space) ----
const CX = 256, CY = 256;
const RING = { r: 172, w: 10 }, INNER = { r: 140, w: 3 };
const TICKS = [[256, 52, 256, 112], [256, 400, 256, 460], [52, 256, 112, 256], [400, 256, 460, 256]];
const M = [[178, 338], [178, 186], [256, 276], [334, 186], [334, 338]];
const M_W = 26;
const SPARK = { x: 334, y: 338 };
const RAYS = Array.from({ length: 8 }, (_, i) => {
  const a = i * Math.PI / 4 + Math.PI / 8, len = i % 2 ? 26 : 44;
  return [SPARK.x + Math.cos(a) * 18, SPARK.y + Math.sin(a) * 18, SPARK.x + Math.cos(a) * len, SPARK.y + Math.sin(a) * len];
});
const COL = { bg0: '#03050a', bg1: '#0f2440', cyan: '#29e7ff', core: '#e4fdff', red: '#ff2e4d', amber: '#ffb020', white: '#ffffff' };

// ---- SVG ----
function svg() {
  const line = ([x1, y1, x2, y2], extra) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2.toFixed ? +y2.toFixed(1) : y2}" ${extra}/>`;
  const pts = M.map(p => p.join(',')).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="46%" r="62%">
      <stop offset="0" stop-color="${COL.bg1}"/>
      <stop offset="1" stop-color="${COL.bg0}"/>
    </radialGradient>
    <radialGradient id="spark" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${COL.white}"/>
      <stop offset="0.25" stop-color="${COL.amber}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="${COL.amber}" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="9" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" rx="104" fill="url(#bg)"/>
  <g fill="none" stroke-linecap="round" filter="url(#glow)">
    <circle cx="${CX}" cy="${CY}" r="${INNER.r}" stroke="${COL.cyan}" stroke-opacity="0.35" stroke-width="${INNER.w}"/>
    <circle cx="${CX}" cy="${CY}" r="${RING.r}" stroke="${COL.cyan}" stroke-width="${RING.w}"/>
    ${TICKS.map(t => line(t, `stroke="${COL.red}" stroke-width="10"`)).join('\n    ')}
    <polyline points="${pts}" stroke="${COL.cyan}" stroke-width="${M_W + 10}" stroke-linejoin="round" stroke-opacity="0.55"/>
    <polyline points="${pts}" stroke="${COL.core}" stroke-width="${M_W - 6}" stroke-linejoin="round"/>
    ${RAYS.map(r => line(r.map(v => +v.toFixed(1)), `stroke="${COL.amber}" stroke-width="5"`)).join('\n    ')}
  </g>
  <circle cx="${SPARK.x}" cy="${SPARK.y}" r="46" fill="url(#spark)"/>
  <circle cx="${SPARK.x}" cy="${SPARK.y}" r="12" fill="${COL.white}"/>
</svg>
`;
}

// ---- raster ----
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const segDist = (px, py, [x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
};
const M_SEGS = M.slice(1).map((p, i) => [...M[i], ...p]);

function pixel(x, y, px) {   // x, y in design units; px = design units per pixel
  const cover = (d, half) => Math.max(0, Math.min(1, (half - d) / px + 0.5));
  const mix = (c, s, a) => { for (let i = 0; i < 3; i++) c[i] += (s[i] - c[i]) * a; };
  const add = (c, s, a) => { for (let i = 0; i < 3; i++) c[i] += s[i] * a; };
  const rc = Math.hypot(x - CX, y - CY + 20) / (512 * 0.62);
  const c = hex(COL.bg1).map((v, i) => v + (hex(COL.bg0)[i] - v) * Math.min(1, rc));

  const dRing = Math.abs(Math.hypot(x - CX, y - CY) - RING.r);
  const dInner = Math.abs(Math.hypot(x - CX, y - CY) - INNER.r);
  const dTick = Math.min(...TICKS.map(t => segDist(x, y, t)));
  const dM = Math.min(...M_SEGS.map(s => segDist(x, y, s)));
  const dRay = Math.min(...RAYS.map(r => segDist(x, y, r)));
  const dSpark = Math.hypot(x - SPARK.x, y - SPARK.y);

  const glow = (d, w, s) => Math.exp(-((Math.max(0, d - w) / s) ** 2));
  add(c, hex(COL.cyan), 0.32 * glow(dRing, 5, 16) + 0.45 * glow(dM, M_W / 2, 20));
  add(c, hex(COL.red), 0.35 * glow(dTick, 5, 12));
  mix(c, hex(COL.cyan), 0.35 * cover(dInner, INNER.w / 2));
  mix(c, hex(COL.cyan), cover(dRing, RING.w / 2));
  mix(c, hex(COL.red), cover(dTick, 5));
  mix(c, hex(COL.cyan), 0.6 * cover(dM, M_W / 2 + 5));
  mix(c, hex(COL.core), cover(dM, M_W / 2 - 3));
  add(c, hex(COL.amber), 0.9 * Math.exp(-((dSpark / 30) ** 2)));
  mix(c, hex(COL.amber), cover(dRay, 2.5));
  mix(c, hex(COL.white), cover(dSpark, 12));
  return c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));
}

function png(size) {
  const k = 512 / size, rgba = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const [r, g, b] = pixel((i + 0.5) * k, (j + 0.5) * k, k);
      rgba.set([r, g, b, 255], (j * size + i) * 4);
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);          // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const dir = fileURLToPath(new URL('../icons/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(dir + 'icon.svg', svg());
console.log('icons/icon.svg');
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(dir + name, png(size));
  console.log(`icons/${name}  ${size}x${size}`);
}
