// Menus, dossiers and overlays. Pure canvas drawing, no DOM access.
//
// A "screen" is { items: [{ x, y, w, h, label, action, disabled, kind, ... }], sel, back }.
// main.js does hover / click via hitTest, keyboard via navigate, and calls the
// build* / draw* pairs below. Everything is drawn in code at 960x544 logical px.
//
// Visual language: an IMF field terminal. Holographic wireframe for the HQ
// screens (rotating target globe, terminal command lines), physical paper for
// the mission dossier (it burns away into the level) and the after-action report.

import { FONT, C, themeFor, rgba, fmtTime } from './theme.js';
import { missionIdentity } from './rng.js';
import { isInstalled, installLabel } from './install.js';

export const VW = 960, VH = 544;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const PER_PAGE = 20;

// ===========================================================================
// Shared primitives (hud.js uses these too)
// ===========================================================================
export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOut = t => 1 - (1 - t) ** 3;
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const pad3 = n => String(n).padStart(3, '0');

/** Stateless hash -> [0, 1). Used instead of Math.random so motion is stable. */
export function h32(a, b = 0) {
  let x = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/** Hex colour lerp -> 'rgb(r,g,b)'. */
export function mix(a, b, t) {
  const p = parseInt(a.slice(1), 16), q = parseInt(b.slice(1), 16);
  const ch = s => Math.round(lerp((p >> s) & 255, (q >> s) & 255, clamp(t)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export function setFont(ctx, size, weight = '') {
  ctx.font = `${weight ? weight + ' ' : ''}${size}px ${FONT}`;
}

export function txt(ctx, s, x, y, size, color, align = 'left', weight = '') {
  setFont(ctx, size, weight);
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/** Text with a dark drop for legibility over the playfield. */
export function txtS(ctx, s, x, y, size, color, align = 'left', weight = '') {
  txt(ctx, s, x + 1, y + 1, size, 'rgba(0,0,0,0.75)', align, weight);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/** Letter-spaced monospace text. Returns the drawn width. */
export function spaced(ctx, s, x, y, size, color, sp, align = 'left', weight = '') {
  setFont(ctx, size, weight);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const cw = ctx.measureText('M').width + sp;
  const total = cw * s.length - sp;
  const x0 = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  ctx.fillStyle = color;
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ') ctx.fillText(s[i], x0 + i * cw, y);
  return total;
}

export function textW(ctx, s, size, weight = '') {
  setFont(ctx, size, weight);
  return ctx.measureText(s).width;
}

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&*+=<>/\\';
const HEXD = '0123456789ABCDEF';

/** Decode effect: the first `revealed` chars are real, the rest flicker as random glyphs. */
export function scramble(s, revealed, frame, seed = 0) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (i < revealed || ch === ' ' || ch === '·' || ch === '-') out += ch;
    else out += GLYPHS[Math.floor(h32(i + seed * 31, frame >> 1) * GLYPHS.length)];
  }
  return out;
}

/** A random-looking matrix code 'XXXX-XXXX' from two integers. */
export function hexRoll(a, b = 0) {
  let s = '';
  for (let i = 0; i < 8; i++) s += HEXD[Math.floor(h32(a * 8 + i, b) * 16)] + (i === 3 ? '-' : '');
  return s;
}

export function brackets(ctx, x, y, w, h, len, color, lw = 1.5) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
  ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
  ctx.moveTo(x + w, y + h - len); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - len, y + h);
  ctx.moveTo(x + len, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - len);
  ctx.stroke();
}

export function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Dark glass panel with hairline border, notched corner and corner brackets. */
export function panel(ctx, x, y, w, h, accent, a = 0.72) {
  ctx.fillStyle = `rgba(4,8,15,${a})`;
  ctx.beginPath();
  ctx.moveTo(x + 10, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h - 10);
  ctx.lineTo(x + w - 10, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + 10); ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.22); ctx.lineWidth = 1; ctx.stroke();
  brackets(ctx, x - 3, y - 3, w + 6, h + 6, 9, rgba(accent, 0.7), 1.2);
}

/**
 * Matrix fingerprint: the 8 hex digits of a matrix code drawn as a 8x4 bit
 * grid. Every trap matrix has its own little barcode. Returns the width.
 */
export function drawFingerprint(ctx, code, x, y, cell, color, faint = null) {
  const digits = String(code ?? '').replace('-', '');
  const step = cell + 1;
  let ox = x;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const v = parseInt(digits[i] ?? '0', 16) || 0;
    for (let b = 0; b < 4; b++) if (v & (8 >> b)) ctx.rect(ox, y + b * step, cell, cell);
    ox += step + (i === 3 ? cell : 0);
  }
  ctx.fill();
  if (faint) {
    ox = x;
    ctx.fillStyle = faint;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const v = parseInt(digits[i] ?? '0', 16) || 0;
      for (let b = 0; b < 4; b++) if (!(v & (8 >> b))) ctx.rect(ox + cell / 2 - 0.5, y + b * step + cell / 2 - 0.5, 1, 1);
      ox += step + (i === 3 ? cell : 0);
    }
    ctx.fill();
  }
  return ox - x - 1;
}

/**
 * A burning fuse from x0 to x1 at height y; p = 0..1 burnt. Rope ahead of the
 * spark, ash + embers behind it. Returns the spark x.
 */
export function drawFuse(ctx, x0, x1, y, p, frame, { lw = 2, over = false, rope = '#9c8660', spark = true } = {}) {
  p = clamp(p);
  const sx = x0 + (x1 - x0) * p;
  if (sx < x1 - 0.5) {
    ctx.strokeStyle = rope; ctx.lineWidth = lw;
    line(ctx, sx, y, x1, y);
    ctx.strokeStyle = 'rgba(30,22,10,0.85)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0 + Math.ceil((sx - x0) / 5) * 5; x < x1 - 1; x += 5) { ctx.moveTo(x, y - lw / 2); ctx.lineTo(x + 2, y + lw / 2); }
    ctx.stroke();
  }
  if (sx > x0) {
    ctx.strokeStyle = over ? 'rgba(255,46,77,0.45)' : 'rgba(140,140,150,0.32)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    line(ctx, x0, y, sx, y);
    ctx.setLineDash([]);
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const d = i * 6 + h32(i, frame >> 2) * 6;
      if (sx - d < x0) break;
      if (h32(i, frame) < d / 110) continue;
      ctx.rect(sx - d, y - 1 + (h32(i * 3, frame >> 1) - 0.5) * 3, 1.5, 1.5);
    }
    ctx.fillStyle = over ? C.danger : C.warn;
    ctx.fill();
  }
  if (spark) {
    const col = over ? C.danger : C.warn;
    const g = ctx.createRadialGradient(sx, y, 0, sx, y, 11);
    g.addColorStop(0, rgba(over ? C.danger : '#ffd27a', 0.8));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(sx - 11, y - 11, 22, 22);
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = h32(i, frame) * TAU, l = 3 + h32(i + 9, frame) * 6;
      ctx.moveTo(sx + Math.cos(a) * 2, y + Math.sin(a) * 2);
      ctx.lineTo(sx + Math.cos(a) * l, y + Math.sin(a) * l);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillRect(sx - 1.5, y - 1.5, 3, 3);
  }
  return sx;
}

export const RANK_COL = { GHOST: '#3dffa8', AGENT: '#7df9ff', OPERATIVE: '#ffb020', ROOKIE: '#ff7a8a' };
const RANK_STARS = { GHOST: 4, AGENT: 3, OPERATIVE: 2, ROOKIE: 1 };
const RANK_NOTE = {
  GHOST: 'NO DEATHS · UNDER PAR', AGENT: 'TWO DEATHS OR FEWER', OPERATIVE: 'EIGHT DEATHS OR FEWER', ROOKIE: 'SURVIVED, EVENTUALLY',
};

/** Hexagonal rank medal with chevrons. */
export function drawRankBadge(ctx, rank, x, y, r, frame, alpha = 1) {
  const col = RANK_COL[rank] ?? C.dim;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.fillStyle = '#060a12';
  ctx.beginPath();
  for (let i = 0; i < 6; i++) { const a = i * TAU / 6 - Math.PI / 2; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.strokeStyle = rgba(col, 0.35); ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) { const a = i * TAU / 6 - Math.PI / 2; ctx.lineTo(Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82); }
  ctx.closePath(); ctx.stroke();
  // rotating tick ring
  ctx.strokeStyle = rgba(col, 0.6);
  ctx.beginPath();
  for (let i = 0; i < 36; i++) {
    const a = i * TAU / 36 + frame * 0.01, l = i % 3 ? 3 : 6;
    ctx.moveTo(Math.cos(a) * (r + 5), Math.sin(a) * (r + 5));
    ctx.lineTo(Math.cos(a) * (r + 5 + l), Math.sin(a) * (r + 5 + l));
  }
  ctx.stroke();
  // chevrons
  const n = RANK_STARS[rank] ?? 1, cw = r * 0.5;
  ctx.strokeStyle = col; ctx.lineWidth = 3;
  for (let i = 0; i < n; i++) {
    const cy = -r * 0.42 + i * r * 0.17;
    ctx.beginPath(); ctx.moveTo(-cw / 2, cy); ctx.lineTo(0, cy + r * 0.12); ctx.lineTo(cw / 2, cy); ctx.stroke();
  }
  if (r >= 24) txt(ctx, rank, 0, r * 0.5, Math.max(9, Math.round(r * 0.26)), col, 'center', 'bold');
  ctx.restore();
}

// ===========================================================================
// Mission identity cache
// ===========================================================================
const idCache = new Map();
function ident(m) {
  let v = idCache.get(m);
  if (!v) {
    v = missionIdentity(m);
    if (idCache.size > 4000) idCache.clear();
    idCache.set(m, v);
  }
  return v;
}
const shortName = codename => String(codename ?? '').replace(/^OPERATION\s+/, '');
const fmtLat = lat => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
const fmtLon = lon => `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

function careerStats(save) {
  const ms = save?.missions ?? {};
  let cleared = 0, deaths = 0, ghosts = 0, clears = 0, fastest = null;
  for (const k of Object.keys(ms)) {
    const r = ms[k] ?? {};
    if ((r.clears ?? 0) > 0) cleared++;
    clears += r.clears ?? 0;
    deaths += r.deaths ?? 0;
    if (r.bestRank === 'GHOST') ghosts++;
    if (r.bestFrames != null && (fastest === null || r.bestFrames < fastest)) fastest = r.bestFrames;
  }
  return { cleared, deaths, ghosts, clears, fastest };
}

// ===========================================================================
// Hit testing + keyboard navigation
// ===========================================================================
export function hitTest(screen, x, y) {
  if (!screen?.items) return -1;
  return screen.items.findIndex(it => !it.disabled && x >= it.x && x < it.x + it.w && y >= it.y && y < it.y + it.h);
}

const DIRS = {
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};

/** Move the selection to the nearest enabled item in the arrow direction. */
export function navigate(screen, code) {
  const d = DIRS[code];
  if (!d || !screen?.items?.length) return false;
  const cur = screen.items[screen.sel];
  if (!cur || cur.disabled) {
    const i = screen.items.findIndex(it => !it.disabled);
    if (i >= 0 && i !== screen.sel) { screen.sel = i; return true; }
    return false;
  }
  const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
  let best = -1, bestScore = Infinity;
  screen.items.forEach((it, i) => {
    if (i === screen.sel || it.disabled) return;
    // nearest point of the candidate's box along the axis, so tall/wide items are reachable
    const tx = clamp(cx, it.x, it.x + it.w), ty = clamp(cy, it.y, it.y + it.h);
    const dx = (d[0] ? it.x + it.w / 2 : tx) - cx, dy = (d[1] ? it.y + it.h / 2 : ty) - cy;
    const along = dx * d[0] + dy * d[1];
    if (along <= 1) return;
    const across = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  if (best >= 0) { screen.sel = best; return true; }
  return false;
}

/** Animated selection frame: eases toward the selected item. */
function selFrame(screen) {
  const it = screen.items[screen.sel];
  if (!it) return null;
  const b = screen._b ?? (screen._b = { x: it.x, y: it.y, w: it.w, h: it.h });
  b.x = lerp(b.x, it.x, 0.32); b.y = lerp(b.y, it.y, 0.32);
  b.w = lerp(b.w, it.w, 0.32); b.h = lerp(b.h, it.h, 0.32);
  return b;
}

/** Frames since the selection last changed (for retyping the selected label). */
function selAge(screen, frame) {
  if (screen._selPrev !== screen.sel) { screen._selPrev = screen.sel; screen._selAt = frame; }
  return frame - (screen._selAt ?? frame);
}

// ===========================================================================
// HQ backdrop + chrome
// ===========================================================================
function backdrop(ctx, th, frame) {
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, C.bg1); g.addColorStop(0.55, C.bg0); g.addColorStop(1, '#020308');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  // dot grid
  ctx.fillStyle = rgba(th.accent, 0.075);
  ctx.beginPath();
  for (let y = 12; y < VH; y += 24) for (let x = 12; x < VW; x += 24) ctx.rect(x, y, 1, 1);
  ctx.fill();
  // crosshair marks every 4 cells
  ctx.strokeStyle = rgba(th.accent, 0.08); ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = 108; y < VH; y += 96) for (let x = 108; x < VW; x += 96) {
    ctx.moveTo(x - 4, y + 0.5); ctx.lineTo(x + 5, y + 0.5); ctx.moveTo(x + 0.5, y - 4); ctx.lineTo(x + 0.5, y + 5);
  }
  ctx.stroke();
  // slow horizontal sweep band
  const sy = (frame * 0.9) % (VH + 160) - 80;
  const sg = ctx.createLinearGradient(0, sy - 60, 0, sy + 4);
  sg.addColorStop(0, rgba(th.accent, 0)); sg.addColorStop(1, rgba(th.accent, 0.045));
  ctx.fillStyle = sg;
  ctx.fillRect(0, sy - 60, VW, 64);
  ctx.fillStyle = rgba(th.accent, 0.08);
  ctx.fillRect(0, sy + 4, VW, 1);
  // vignette
  const v = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.35, VW / 2, VH / 2, VW * 0.65);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, VW, VH);
  // screen corner brackets
  brackets(ctx, 8, 8, VW - 16, VH - 16, 16, rgba(th.accent, 0.35), 1);
}

function clock() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

function topBar(ctx, th, frame, right) {
  const y = 30;
  if ((frame >> 5) % 2 === 0) {
    ctx.fillStyle = C.danger;
    ctx.beginPath(); ctx.arc(30, y - 4, 4, 0, TAU); ctx.fill();
  }
  txt(ctx, 'REC', 40, y, 11, C.danger, 'left', 'bold');
  txt(ctx, 'SECURE CHANNEL', 72, y, 11, C.dim, 'left', 'bold');
  txt(ctx, clock(), 176, y, 11, th.accent, 'left', 'bold');
  // signal bars
  for (let i = 0; i < 5; i++) {
    const on = i < 3 + ((frame >> 4) % 3 === 0 ? 1 : 2);
    ctx.fillStyle = on ? rgba(th.accent, 0.85) : C.faint;
    ctx.fillRect(258 + i * 5, y - 2 - i * 2, 3, 3 + i * 2);
  }
  txt(ctx, right, VW - 28, y, 11, C.dim, 'right', 'bold');
  ctx.fillStyle = rgba(th.accent, 0.18);
  ctx.fillRect(24, y + 8, VW - 48, 1);
  ctx.fillStyle = rgba(th.accent, 0.6);
  ctx.fillRect(24, y + 7, 40, 3);
  ctx.fillRect(VW - 64, y + 7, 40, 3);
}

/** Dim the frozen game behind an overlay, with fine scanlines. */
function veil(ctx, a) {
  ctx.fillStyle = `rgba(2,4,9,${a})`;
  ctx.fillRect(0, 0, VW, VH);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  for (let y = 0; y < VH; y += 3) ctx.rect(0, y, VW, 1);
  ctx.fill();
}

// ===========================================================================
// The globe: orthographic wireframe earth with land dots, arcs and markers.
// ===========================================================================
// Land mask at 10° resolution: per 10° latitude band (90..80, 80..70, ...),
// inclusive column ranges where column c covers longitude -180+10c .. -170+10c.
const LAND = [
  [[13, 14]],
  [[4, 15], [19, 19], [23, 24], [27, 32]],
  [[0, 6], [8, 8], [10, 16], [18, 35]],
  [[2, 7], [9, 12], [16, 31], [33, 33]],
  [[5, 12], [17, 32]],
  [[6, 10], [17, 32]],
  [[6, 9], [16, 30]],
  [[7, 9], [16, 23], [25, 30]],
  [[9, 12], [17, 22], [26, 26], [28, 30]],
  [[10, 14], [18, 21], [27, 33]],
  [[10, 14], [19, 23], [30, 32], [35, 35]],
  [[10, 13], [19, 22], [29, 33]],
  [[10, 12], [19, 21], [29, 33], [35, 35]],
  [[10, 11], [32, 32], [34, 35]],
  [[10, 11]],
  [[11, 12], [18, 35]],
  [[1, 13], [16, 33]],
  [[0, 35]],
];

let LAND_DOTS = null;   // Float32Array of unit vectors x,y,z
function landDots() {
  if (LAND_DOTS) return LAND_DOTS;
  const pts = [];
  LAND.forEach((ranges, r) => {
    for (const [a, b] of ranges) {
      for (let c = a; c <= b; c++) {
        for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
          if ((r >= 16 || r <= 2) && (sx + sy) % 2) continue;
          const lat = 90 - r * 10 - 2.5 - sy * 5;
          const lon = -180 + c * 10 + 2.5 + sx * 5;
          const p = lat * DEG, l = lon * DEG;
          pts.push(Math.cos(p) * Math.sin(l), Math.sin(p), Math.cos(p) * Math.cos(l));
        }
      }
    }
  });
  LAND_DOTS = new Float32Array(pts);
  return LAND_DOTS;
}

function unit(lat, lon) {
  const p = lat * DEG, l = lon * DEG;
  return [Math.cos(p) * Math.sin(l), Math.sin(p), Math.cos(p) * Math.cos(l)];
}

/** Projector for a globe view. Writes into P = { x, y, z }. */
function projector(cx, cy, R, lon0, tilt) {
  const cl = Math.cos(lon0), sl = Math.sin(lon0), ct = Math.cos(tilt), st = Math.sin(tilt);
  const P = { x: 0, y: 0, z: 0 };
  P.proj = (x, y, z) => {
    const x1 = x * cl - z * sl, z1 = z * cl + x * sl;
    const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
    P.x = cx + R * x1; P.y = cy - R * y2; P.z = z2;
    return P;
  };
  return P;
}

const GRAT = (() => {
  // meridians + parallels as unit-vector polylines (flat arrays, NaN separators)
  const out = [];
  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -90; lat <= 90; lat += 6) out.push(...unit(lat, lon));
    out.push(NaN, NaN, NaN);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon <= 180; lon += 6) out.push(...unit(lat, lon));
    out.push(NaN, NaN, NaN);
  }
  return new Float32Array(out);
})();

/**
 * Draw the globe. o = { lon0, tilt (radians), accent, frame, markers: [{lat, lon, color, r}],
 *   arcs: [{a: {lat,lon}, b: {lat,lon}, prog}], target: {lat, lon}, detail (0..1) }
 * Returns the target's screen position { x, y, vis }.
 */
function drawGlobe(ctx, cx, cy, R, o) {
  const acc = o.accent, frame = o.frame;
  const P = projector(cx, cy, R, o.lon0, o.tilt);
  // disc + atmosphere
  const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
  g.addColorStop(0, rgba(acc, 0.08)); g.addColorStop(0.75, rgba(acc, 0.03)); g.addColorStop(1, rgba(acc, 0.16));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
  const halo = ctx.createRadialGradient(cx, cy, R, cx, cy, R * 1.12);
  halo.addColorStop(0, rgba(acc, 0.16)); halo.addColorStop(1, rgba(acc, 0));
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, cy, R * 1.12, 0, TAU); ctx.fill();

  // graticule: back pass (faint) then front pass
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = pass ? rgba(acc, 0.24) : rgba(acc, 0.06);
    ctx.lineWidth = 1;
    ctx.beginPath();
    let px = 0, py = 0, pz = 0, has = false;
    for (let i = 0; i < GRAT.length; i += 3) {
      if (Number.isNaN(GRAT[i])) { has = false; continue; }
      P.proj(GRAT[i], GRAT[i + 1], GRAT[i + 2]);
      if (has && ((pz + P.z) >= 0) === (pass === 1)) { ctx.moveTo(px, py); ctx.lineTo(P.x, P.y); }
      px = P.x; py = P.y; pz = P.z; has = true;
    }
    ctx.stroke();
  }

  // land dots (front hemisphere only), two brightness buckets
  const D = landDots();
  const ds = R > 120 ? 1.8 : 1.4;
  for (let pass = 0; pass < 2; pass++) {
    ctx.fillStyle = pass ? rgba(acc, 0.85) : rgba(acc, 0.32);
    ctx.beginPath();
    for (let i = 0; i < D.length; i += 3) {
      P.proj(D[i], D[i + 1], D[i + 2]);
      if (P.z <= 0) continue;
      if ((P.z > 0.35) !== (pass === 1)) continue;
      ctx.rect(P.x - ds / 2, P.y - ds / 2, ds, ds);
    }
    ctx.fill();
  }

  // limb
  ctx.strokeStyle = rgba(acc, 0.75); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  ctx.strokeStyle = rgba('#ffffff', 0.25); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R - 2, Math.PI * 1.05, Math.PI * 1.45); ctx.stroke();

  // flight arcs: great circles lifted off the surface, drawn in progressively
  for (const arc of o.arcs ?? []) {
    const a = unit(arc.a.lat, arc.a.lon), b = unit(arc.b.lat, arc.b.lon);
    const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1), om = Math.acos(dot);
    if (om < 0.01) continue;
    const so = Math.sin(om), lift = 0.05 + 0.18 * om / Math.PI;
    const N = 28, end = clamp(arc.prog);
    let hx = 0, hy = 0, hv = false;
    ctx.strokeStyle = rgba(arc.color ?? acc, 0.8); ctx.lineWidth = 1.2;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * end;
      const k0 = Math.sin((1 - s) * om) / so, k1 = Math.sin(s * om) / so, hgt = 1 + lift * Math.sin(Math.PI * s);
      P.proj((a[0] * k0 + b[0] * k1) * hgt, (a[1] * k0 + b[1] * k1) * hgt, (a[2] * k0 + b[2] * k1) * hgt);
      const dx = P.x - cx, dy = P.y - cy;
      const vis = P.z > 0 || dx * dx + dy * dy > R * R;
      if (vis) { if (pen) ctx.lineTo(P.x, P.y); else ctx.moveTo(P.x, P.y); }
      pen = vis;
      hx = P.x; hy = P.y; hv = vis;
    }
    ctx.stroke();
    if (hv && end < 1) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hx, hy, 2.2, 0, TAU); ctx.fill();
    }
  }

  // markers
  for (const m of o.markers ?? []) {
    const u = unit(m.lat, m.lon);
    P.proj(u[0], u[1], u[2]);
    if (P.z <= 0.05) continue;
    const r = m.r ?? 3;
    ctx.fillStyle = m.color ?? C.good;
    ctx.beginPath(); ctx.moveTo(P.x, P.y - r); ctx.lineTo(P.x + r, P.y); ctx.lineTo(P.x, P.y + r); ctx.lineTo(P.x - r, P.y); ctx.closePath();
    ctx.fill();
  }

  // target reticle
  const out = { x: cx, y: cy, vis: false };
  if (o.target) {
    const u = unit(o.target.lat, o.target.lon);
    P.proj(u[0], u[1], u[2]);
    out.x = P.x; out.y = P.y; out.vis = P.z > 0.1;
    if (out.vis) {
      const tx = P.x, ty = P.y, col = o.targetColor ?? C.danger;
      const pulse = (frame % 70) / 70;
      ctx.strokeStyle = rgba(col, (1 - pulse) * 0.9); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(tx, ty, 4 + pulse * 22, 0, TAU); ctx.stroke();
      ctx.save();
      ctx.translate(tx, ty); ctx.rotate(frame * 0.02);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        ctx.rotate(TAU / 4);
        ctx.beginPath(); ctx.arc(0, 0, 10, -0.45, 0.45); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(18, 0); ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.fillRect(tx - 1.5, ty - 1.5, 3, 3);
    }
  }
  return out;
}

/** Outer bezel ring with rotating degree ticks. */
function globeBezel(ctx, cx, cy, R, acc, frame) {
  const r0 = R + 10;
  ctx.strokeStyle = rgba(acc, 0.22); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, r0, 0, TAU); ctx.stroke();
  ctx.strokeStyle = rgba(acc, 0.4);
  ctx.beginPath();
  const rot = -frame * 0.0015;
  for (let i = 0; i < 72; i++) {
    const a = rot + i * TAU / 72, l = i % 6 === 0 ? 7 : 3;
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * (r0 + l), cy + Math.sin(a) * (r0 + l));
  }
  ctx.stroke();
  ctx.strokeStyle = rgba(acc, 0.7); ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const a = frame * 0.004 + i * TAU / 4;
    ctx.beginPath(); ctx.arc(cx, cy, r0 + 14, a, a + 0.35); ctx.stroke();
  }
}

// ===========================================================================
// MAIN MENU
// ===========================================================================
let menuT0 = 0, menuLast = -1e9;

export function buildMainMenu(app) {
  const save = app.save ?? {};
  const hi = Math.max(1, save.highest ?? 1);
  const id = ident(hi);
  const st = careerStats(save);
  const X = 52, W = 400;
  const items = [
    {
      kind: 'cmd', x: X, y: 250, w: W, h: 46, action: 'continue',
      label: hi > 1 ? 'CONTINUE' : 'START', suffix: `MISSION ${pad3(hi)}`,
      note: `// ${shortName(id.codename)} · ${id.city}`,
    },
    {
      kind: 'cmd', x: X, y: 300, w: W, h: 46, action: 'select', label: 'MISSION ARCHIVE',
      suffix: `${st.cleared} CLEARED`, note: '// case files 001 → ∞ · replay any cleared op',
    },
    {
      kind: 'cmd', x: X, y: 350, w: W, h: 46, action: 'howto', label: 'FIELD MANUAL',
      suffix: '', note: '// controls · scanner · heart-rate · ranks',
    },
  ];
  [['sound', 'SOUND'], ['music', 'MUSIC'], ['fx', 'EFFECTS']].forEach(([key, label], i) => {
    items.push({ kind: 'chip', x: X + i * 136, y: 408, w: 128, h: 40, action: 'toggle', key, label, on: !!save[key] });
  });
  // desktop / mobile app download, top-right in the status bar (last, so toggle indices stay stable)
  if (!isInstalled()) items.push({ kind: 'install', x: VW - 214, y: 14, w: 190, h: 26, action: 'install', label: installLabel() });
  return { items, sel: 0, back: null, kind: 'menu' };
}

function drawCmdItem(ctx, it, sel, th, frame, age) {
  const y = it.y, cyL = y + 21;
  if (sel) {
    const g = ctx.createLinearGradient(it.x, 0, it.x + it.w, 0);
    g.addColorStop(0, rgba(th.accent, 0.16)); g.addColorStop(1, rgba(th.accent, 0));
    ctx.fillStyle = g;
    ctx.fillRect(it.x, y, it.w, it.h);
  }
  txt(ctx, '>', it.x + 14, cyL, 20, sel ? th.accent : C.faint, 'left', 'bold');
  const typed = sel ? Math.floor(age * 1.6) : 99;
  const lab = sel ? scramble(it.label, typed, frame, 7) : it.label;
  txt(ctx, lab, it.x + 36, cyL, 20, sel ? C.text : C.dim, 'left', 'bold');
  let x = it.x + 36 + textW(ctx, it.label, 20, 'bold');
  if (it.suffix) {
    txt(ctx, ` — ${it.suffix}`, x, cyL, 14, sel ? th.accent : rgba(th.accent, 0.45), 'left', 'bold');
    x += textW(ctx, ` — ${it.suffix}`, 14, 'bold');
  }
  if (sel && (frame >> 4) % 2 === 0) {
    ctx.fillStyle = th.accent;
    ctx.fillRect(x + 6, cyL - 14, 9, 16);
  }
  if (it.note) txt(ctx, it.note, it.x + 36, y + 37, 10, sel ? rgba(C.text, 0.6) : rgba(C.dim, 0.55));
}

function drawInstall(ctx, it, sel, th, frame) {
  ctx.fillStyle = sel ? th.accent : 'rgba(4,8,15,0.85)';
  ctx.fillRect(it.x, it.y, it.w, it.h);
  ctx.strokeStyle = th.accent; ctx.lineWidth = 1;
  ctx.strokeRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1);
  // download glyph
  const gx = it.x + 16, gy = it.y + it.h / 2, bob = sel ? Math.sin(frame * 0.2) * 1.5 : 0;
  ctx.strokeStyle = sel ? C.bg0 : th.accent; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(gx, gy - 7 + bob); ctx.lineTo(gx, gy + 3 + bob);
  ctx.moveTo(gx - 4, gy - 1 + bob); ctx.lineTo(gx, gy + 3 + bob); ctx.lineTo(gx + 4, gy - 1 + bob);
  ctx.moveTo(gx - 6, gy + 7); ctx.lineTo(gx + 6, gy + 7);
  ctx.stroke();
  txt(ctx, it.label, it.x + it.w / 2 + 10, it.y + 17, 12, sel ? C.bg0 : C.text, 'center', 'bold');
}

function drawChip(ctx, it, sel, th) {
  const on = !!it.on;
  ctx.fillStyle = sel ? rgba(th.accent, 0.14) : 'rgba(255,255,255,0.03)';
  ctx.fillRect(it.x, it.y, it.w, it.h);
  ctx.strokeStyle = sel ? th.accent : rgba(th.accent, 0.25); ctx.lineWidth = 1;
  ctx.strokeRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1);
  txt(ctx, it.label, it.x + 10, it.y + 17, 11, sel ? C.text : C.dim, 'left', 'bold');
  txt(ctx, on ? 'ON' : 'OFF', it.x + 10, it.y + 32, 11, on ? C.good : C.danger, 'left', 'bold');
  // switch
  const sx = it.x + it.w - 44, sy = it.y + it.h / 2 - 8;
  rrect(ctx, sx, sy, 34, 16, 8);
  ctx.fillStyle = on ? rgba(C.good, 0.25) : 'rgba(255,46,77,0.12)'; ctx.fill();
  ctx.strokeStyle = on ? C.good : rgba(C.danger, 0.6); ctx.stroke();
  ctx.fillStyle = on ? C.good : C.danger;
  ctx.beginPath(); ctx.arc(on ? sx + 26 : sx + 8, sy + 8, 5, 0, TAU); ctx.fill();
}

function drawTitle(ctx, x, frame, t, th) {
  const words = [['MISSION', 124, C.text], ['IMPOSSIBLE', 184, th.accent]];
  const size = 56;
  setFont(ctx, size, 'bold');
  const cw = ctx.measureText('M').width + 3;
  const gk = frame % 420;
  const glitching = t > 90 && gk > 404;
  // "MISSION POSSIBLE" troll: a redaction bar slides over "IM" now and then
  const ck = (t + 300) % 900;
  const redact = t > 150 && ck > 640 && ck < 800 ? clamp((ck - 640) / 12) * (ck > 780 ? (800 - ck) / 20 : 1) : 0;
  words.forEach(([w, y, col], wi) => {
    for (let i = 0; i < w.length; i++) {
      const rt = 8 + (wi * 7 + i) * 2.4 + h32(i, wi) * 16;
      let ch = w[i], c = col;
      if (t < rt) {
        if (t < rt - 26) continue;
        ch = GLYPHS[Math.floor(h32(i + wi * 50, frame >> 1) * GLYPHS.length)];
        c = rgba(th.accent, 0.5);
      }
      const jx = glitching && h32(i, frame) < 0.3 ? (h32(i + 3, frame) - 0.5) * 14 : 0;
      setFont(ctx, size, 'bold');
      ctx.textAlign = 'left';
      if (glitching) {
        ctx.fillStyle = 'rgba(255,46,77,0.7)'; ctx.fillText(ch, x + i * cw + jx - 3, y);
        ctx.fillStyle = 'rgba(41,231,255,0.7)'; ctx.fillText(ch, x + i * cw + jx + 3, y);
      }
      ctx.fillStyle = c;
      ctx.fillText(ch, x + i * cw + jx, y);
    }
  });
  if (redact > 0) {
    const bw = cw * 2 * redact;
    ctx.fillStyle = '#000';
    ctx.fillRect(x - 4, 184 - 44, bw + 4, 52);
    ctx.strokeStyle = rgba(C.danger, 0.8); ctx.lineWidth = 1;
    ctx.strokeRect(x - 4.5, 184 - 44.5, bw + 5, 53);
    if (redact >= 1) txt(ctx, 'NICE TRY', x + cw - 2, 184 - 50, 9, C.danger, 'center', 'bold');
  }
  // underline + ticks
  ctx.fillStyle = rgba(th.accent, 0.5);
  ctx.fillRect(x, 198, cw * 10 - 3, 1);
  for (let i = 0; i <= 10; i++) ctx.fillRect(x + i * cw - (i === 10 ? 3 : 0), 195, 1, i % 5 ? 3 : 6);
}

// ===========================================================================
// OPENING CREDIT: studio ident before the HQ menu (t = frames since boot)
// ===========================================================================
export const INTRO_FRAMES = 360;
const CREATOR = 'MAHIN JAMAN';
const ROLES = 'DESIGN  ·  ENGINEERING  ·  DIRECTION';

export function drawIntro(ctx, app, t) {
  const th = themeFor(Math.max(1, app.save?.highest ?? 1));
  const acc = th.accent;
  const cx = VW / 2, ly = 292, half = 290;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, VW, VH);

  // faint dot grid + vignette breathing in
  const ga = clamp(t / 60) * (1 - clamp((t - 300) / 40));
  ctx.fillStyle = rgba(acc, 0.06 * ga);
  ctx.beginPath();
  for (let y = 12; y < VH; y += 24) for (let x = 12; x < VW; x += 24) ctx.rect(x, y, 1, 1);
  ctx.fill();
  const v = ctx.createRadialGradient(cx, ly, 40, cx, ly, VW * 0.6);
  v.addColorStop(0, rgba(acc, 0.07 * ga)); v.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, VW, VH);

  // ------------------------------------------------ credit block
  const A = 1 - clamp((t - 250) / 28);
  if (A > 0) {
    ctx.save();
    ctx.globalAlpha = A;

    // frame brackets close in from the screen corners
    const k = easeOut(clamp(t / 42));
    const bx = lerp(12, 186, k), by = lerp(12, 166, k), bw = VW - 2 * bx, bh = lerp(VH - 24, 236, k);
    brackets(ctx, bx, by, bw, bh, 14, rgba(acc, 0.6 * clamp(t / 10)), 1.5);

    // corner metadata
    const ma = clamp((t - 92) / 20);
    if (ma > 0) {
      ctx.globalAlpha = A * ma;
      txt(ctx, 'CREATOR FILE // MJ-0001', bx + 16, by + 22, 9, C.dim, 'left', 'bold');
      txt(ctx, t > 132 ? 'IDENTITY VERIFIED' : scramble('IDENTITY VERIFIED', Math.floor((t - 92) / 2.4), t, 5), bx + bw - 16, by + 22, 9, t > 132 ? C.good : rgba(acc, 0.7), 'right', 'bold');
      drawFingerprint(ctx, '4D4A-2026', bx + 16, by + bh - 24, 2, acc, rgba(acc, 0.25));
      txt(ctx, 'EST. 2026', bx + bw - 16, by + bh - 14, 9, C.dim, 'right', 'bold');
      ctx.globalAlpha = A;
    }

    // "A GAME BY" settles its tracking
    const a1 = clamp((t - 18) / 30);
    spaced(ctx, 'A GAME BY', cx, 214, 12, rgba(C.dim, a1), lerp(16, 7, easeOut(a1)), 'center', 'bold');

    // hairline grows from the centre, ticks every 29px
    const lw = half * easeOut(clamp((t - 10) / 40));
    ctx.fillStyle = rgba(acc, 0.3);
    ctx.fillRect(cx - lw, ly, lw * 2, 1);
    for (let x = -half; x <= half; x += 29) if (Math.abs(x) <= lw) ctx.fillRect(cx + x, ly - (x % 145 ? 2 : 4), 1, x % 145 ? 2 : 4);

    // a fuse spark races along the line and lights it up
    const p = easeInOut(clamp((t - 58) / 92));
    const sx = cx - half + half * 2 * p;
    if (t >= 58) {
      ctx.fillStyle = rgba(acc, 0.85);
      ctx.fillRect(cx - half, ly - 0.5, sx - (cx - half), 2);
    }
    if (t >= 58 && t < 156) {
      const g = ctx.createRadialGradient(sx, ly, 0, sx, ly, 26);
      g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.25, rgba(acc, 0.6)); g.addColorStop(1, rgba(acc, 0));
      ctx.fillStyle = g;
      ctx.fillRect(sx - 26, ly - 26, 52, 52);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = h32(i, t) * TAU, l = 4 + h32(i + 9, t) * 10;
        ctx.moveTo(sx, ly); ctx.lineTo(sx + Math.cos(a) * l, ly + Math.sin(a) * l);
      }
      ctx.stroke();
    }
    const fl = clamp(1 - Math.abs(t - 152) / 16);
    if (fl > 0) {
      ctx.fillStyle = rgba('#ffffff', 0.8 * fl);
      ctx.fillRect(cx - half, ly - 1, half * 2, 3);
      const g = ctx.createLinearGradient(0, ly - 60, 0, ly + 60);
      g.addColorStop(0, rgba(acc, 0)); g.addColorStop(0.5, rgba(acc, 0.12 * fl)); g.addColorStop(1, rgba(acc, 0));
      ctx.fillStyle = g;
      ctx.fillRect(cx - half, ly - 60, half * 2, 120);
    }

    // the name: letters decode from random glyphs, then glow once the line is lit
    const size = 54, sp = 12;
    setFont(ctx, size, 'bold');
    const cw = ctx.measureText('M').width + sp;
    const x0 = cx - (cw * CREATOR.length - sp) / 2;
    const glitch = (t >= 198 && t < 206) || (t >= 228 && t < 231);
    const glow = clamp((t - 150) / 20);
    for (let i = 0; i < CREATOR.length; i++) {
      const ch = CREATOR[i];
      if (ch === ' ') continue;
      const rt = 40 + i * 6 + h32(i, 7) * 10;
      if (t < rt - 24) continue;
      const real = t >= rt;
      const shown = real ? ch : GLYPHS[Math.floor(h32(i + 70, t >> 1) * GLYPHS.length)];
      const x = x0 + i * cw;
      const jx = glitch && h32(i, t) < 0.35 ? (h32(i + 3, t) - 0.5) * 16 : 0;
      setFont(ctx, size, 'bold');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      if (glitch) {
        ctx.fillStyle = 'rgba(255,46,77,0.75)'; ctx.fillText(shown, x + jx - 4, 270);
        ctx.fillStyle = rgba(acc, 0.75); ctx.fillText(shown, x + jx + 4, 270);
      }
      if (real && glow > 0) { ctx.shadowColor = acc; ctx.shadowBlur = 22 * glow; }
      ctx.fillStyle = real ? C.text : rgba(acc, 0.55);
      ctx.fillText(shown, x + jx, 270);
      ctx.shadowBlur = 0;
    }

    // roles typed under the line
    const n = Math.floor(clamp((t - 112) / 46) * ROLES.length);
    if (n > 0) {
      const typed = [...ROLES].map((c, i) => (i < n ? c : ' ')).join('');
      spaced(ctx, typed, cx, 326, 11, rgba(C.text, 0.72), 3, 'center', 'bold');
    }
    ctx.restore();
  }

  // ------------------------------------------------ "PRESENTS"
  const pa = clamp((t - 266) / 20) * (1 - clamp((t - 322) / 22));
  if (pa > 0) {
    ctx.globalAlpha = pa;
    spaced(ctx, 'PRESENTS', cx, 284, 18, C.text, lerp(20, 11, easeOut(clamp((t - 266) / 70))), 'center', 'bold');
    const w = 70 * easeOut(clamp((t - 270) / 40));
    ctx.fillStyle = rgba(acc, 0.7);
    ctx.fillRect(cx - w, 298, w * 2, 1);
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------ footer
  const fa = clamp((t - 30) / 30) * (1 - clamp((t - 300) / 30));
  if (fa > 0) {
    txt(ctx, '© 2026 MAHIN JAMAN · ALL RIGHTS RESERVED', cx, 516, 9, rgba(C.dim, 0.75 * fa), 'center', 'bold');
    if ((t >> 5) % 2 === 0 || t < 60) txt(ctx, 'PRESS ANY KEY TO SKIP ▸', VW - 28, 516, 9, rgba(acc, 0.6 * fa), 'right', 'bold');
  }
}

function drawTicker(ctx, th, frame, save) {
  const st = careerStats(save);
  const hi = Math.max(1, save?.highest ?? 1);
  const s = `AGENT RECORD  //  MISSIONS CLEARED ${st.cleared}  //  TOTAL CLEARS ${st.clears}  //  DEATHS ${st.deaths}  //  GHOST RANKS ${st.ghosts}  //  FASTEST EXTRACTION ${fmtTime(st.fastest)}  //  CLEARANCE LEVEL M-${pad3(hi)}  //  EVERY ATTEMPT IS A NEW TRAP MATRIX  //  DESIGNED & DEVELOPED BY MAHIN JAMAN  //  `;
  const y0 = 488, h = 20;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(24, y0, VW - 48, h);
  ctx.fillStyle = rgba(th.accent, 0.35);
  ctx.fillRect(24, y0, VW - 48, 1); ctx.fillRect(24, y0 + h - 1, VW - 48, 1);
  ctx.fillStyle = th.accent;
  ctx.fillRect(24, y0, 52, h);
  txt(ctx, 'LIVE', 50, y0 + 14, 11, C.bg0, 'center', 'bold');
  ctx.save();
  ctx.beginPath(); ctx.rect(80, y0, VW - 104, h); ctx.clip();
  const w = Math.max(200, textW(ctx, s, 11, 'bold'));
  const off = (frame * 0.7) % w;
  txt(ctx, s, 84 - off, y0 + 14, 11, C.dim, 'left', 'bold');
  txt(ctx, s, 84 - off + w, y0 + 14, 11, C.dim, 'left', 'bold');
  ctx.restore();
}

export function drawMainMenu(ctx, app, screen, frame) {
  if (frame - menuLast > 10 || frame < menuLast) menuT0 = frame;
  menuLast = frame;
  const t = frame - menuT0;
  const save = app.save ?? {};
  const hi = Math.max(1, save.highest ?? 1);
  const th = themeFor(hi);
  const target = ident(hi);
  backdrop(ctx, th, frame);
  topBar(ctx, th, frame, screen.items.some(it => it.kind === 'install') ? '' : `IMF-NET · NODE ${pad3((hi * 37) % 997)} · ENCRYPTED`);

  // ---------------------------------------------------------------- globe
  const cx = 712, cy = 280, R = 168;
  const spin = (1 - easeOut(clamp(t / 150))) * TAU * 1.35;
  const sway = Math.sin(t / 260) * 0.75 * clamp((t - 100) / 160);
  const lon0 = target.lon * DEG + sway - spin;
  const tilt = clamp(target.lat * 0.7, -40, 40) * DEG + 0.1;
  const markers = [], arcs = [], seen = new Set();
  for (let m = Math.max(1, hi - 80); m < hi; m++) {
    const id = ident(m);
    if (seen.has(id.city)) continue;
    seen.add(id.city);
    markers.push({ lat: id.lat, lon: id.lon, color: C.good, r: 3 });
  }
  for (let m = Math.max(1, hi - 6); m < hi; m++) {
    const a = ident(m), b = ident(m + 1), k = hi - 1 - m;
    const cyc = ((t - k * 50) % 300 + 300) % 300;
    arcs.push({ a, b, prog: t < k * 50 ? 0 : clamp(cyc / 90), color: m + 1 === hi ? th.accent : C.good });
  }
  globeBezel(ctx, cx, cy, R, th.accent, frame);
  const tp = drawGlobe(ctx, cx, cy, R, { lon0, tilt, accent: th.accent, frame, markers, arcs, target, targetColor: C.danger });

  // leader line + target card
  const locked = t > 150;
  if (tp.vis) {
    const bx = 780, by = 62, bw = 164, bh = 76;
    const a = locked ? clamp((t - 150) / 20) : 0.35;
    ctx.globalAlpha = a;
    ctx.strokeStyle = rgba(C.danger, 0.7); ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(tp.x + 14, tp.y - 14); ctx.lineTo(bx - 20, by + bh / 2); ctx.lineTo(bx, by + bh / 2); ctx.stroke(); ctx.setLineDash([]);
    panel(ctx, bx, by, bw, bh, C.danger, 0.8);
    txt(ctx, locked ? 'TARGET LOCKED' : 'ACQUIRING…', bx + 10, by + 15, 9, C.danger, 'left', 'bold');
    txt(ctx, `M-${pad3(hi)} · ${target.city}`, bx + 10, by + 33, 13, C.text, 'left', 'bold');
    txt(ctx, shortName(target.codename), bx + 10, by + 49, 10, th.accent, 'left', 'bold');
    txt(ctx, `${fmtLat(target.lat)} ${fmtLon(target.lon)}`, bx + 10, by + 65, 10, C.dim);
    ctx.globalAlpha = 1;
  }
  txt(ctx, `ORBITAL TRACK · ${pad3(markers.length)} CITIES SECURED · LON ${(((lon0 / DEG) % 360 + 540) % 360 - 180).toFixed(1)}`, cx, 474, 10, rgba(th.accent, 0.7), 'center', 'bold');

  // ---------------------------------------------------------------- title
  const X = 52;
  txt(ctx, 'IMF // FIELD TERMINAL 7.3 // CLEARANCE ' + pad3(hi), X, 68, 10, C.dim, 'left', 'bold');
  drawTitle(ctx, X, frame, t, th);
  spaced(ctx, 'EVERY ATTEMPT · A NEW TRAP MATRIX', X, 220, 11, C.text, 2.4, 'left', 'bold');
  const roll = hexRoll(frame >> 2, 77);
  txt(ctx, 'NEXT MATRIX ▸', X, 240, 11, C.dim, 'left', 'bold');
  txt(ctx, roll, X + 104, 240, 12, C.warn, 'left', 'bold');
  drawFingerprint(ctx, roll, X + 196, 230, 2, C.warn, rgba(C.warn, 0.3));
  txt(ctx, 'UNPREDICTABLE', X + 240, 240, 9, rgba(C.warn, 0.7), 'left', 'bold');

  // ---------------------------------------------------------------- items
  const age = selAge(screen, frame);
  const b = selFrame(screen);
  screen.items.forEach((it, i) => {
    if (it.kind === 'chip') drawChip(ctx, it, i === screen.sel, th);
    else if (it.kind === 'install') drawInstall(ctx, it, i === screen.sel, th, frame);
    else drawCmdItem(ctx, it, i === screen.sel, th, frame, age);
  });
  if (b) {
    const k = 4 + Math.sin(frame * 0.12) * 1.5;
    brackets(ctx, b.x - k, b.y - 2, b.w + 2 * k, b.h + 4, 10, th.accent, 2);
  }
  txt(ctx, '▲▼ SELECT   ENTER CONFIRM   CLICK / TAP', X, 470, 9, rgba(C.dim, 0.7), 'left', 'bold');

  // ---------------------------------------------------------------- footer
  drawTicker(ctx, th, frame, save);
  const fp = (frame % 2400) / 2400;
  const sx = drawFuse(ctx, 24, VW - 240, 528, fp, frame);
  txt(ctx, 'THIS TERMINAL WILL SELF-DESTRUCT', VW - 26, 532, 9, rgba(C.warn, 0.75), 'right', 'bold');
  if (fp > 0.97) {
    ctx.fillStyle = `rgba(255,176,32,${(fp - 0.97) * 6})`;
    ctx.fillRect(0, 0, VW, VH);
  }
  void sx;
}

// ===========================================================================
// MISSION ARCHIVE (endless case files)
// ===========================================================================
export function buildSelect(app, page) {
  const save = app.save ?? {};
  const hi = Math.max(1, save.highest ?? 1);
  const unlocked = app.debug ? Infinity : hi;
  const lastPage = app.debug ? 499 : Math.floor((hi - 1) / PER_PAGE);
  if (page === undefined || page === null || Number.isNaN(+page)) page = Math.floor((hi - 1) / PER_PAGE);
  page = Math.round(clamp(+page, 0, lastPage));
  const items = [];
  for (let i = 0; i < PER_PAGE; i++) {
    const m = page * PER_PAGE + i + 1, col = i % 5, row = Math.floor(i / 5);
    const locked = m > unlocked;
    items.push({
      kind: 'card', x: 66 + col * 168, y: 100 + row * 94, w: 156, h: 84,
      mission: m, action: 'mission', label: `M-${pad3(m)}`, disabled: locked, locked,
    });
  }
  items.push({ kind: 'arrow', dir: -1, x: 8, y: 100, w: 48, h: 366, action: 'page', page: page - 1, label: 'PREV', disabled: page <= 0 });
  items.push({ kind: 'arrow', dir: 1, x: 904, y: 100, w: 48, h: 366, action: 'page', page: page + 1, label: 'NEXT', disabled: page >= lastPage });
  items.push({ kind: 'back', x: 24, y: 46, w: 132, h: 40, action: 'back', label: 'HQ' });
  let sel = items.findIndex(it => it.mission === Math.min(hi, (page + 1) * PER_PAGE) && !it.disabled);
  if (sel < 0) sel = items.findIndex(it => !it.disabled);
  return { items, sel, back: 'back', kind: 'select', page, lastPage };
}

function drawCard(ctx, app, it, sel, frame, hi) {
  const m = it.mission, th = themeFor(m), id = ident(m);
  const rec = app.save?.missions?.[m];
  const cleared = (rec?.clears ?? 0) > 0;
  const active = !it.locked && !cleared && m === hi;
  const lift = sel ? -3 : 0;
  const x = it.x, y = it.y + lift, w = it.w, h = it.h;
  // folder silhouette
  ctx.beginPath();
  ctx.moveTo(x, y + 9); ctx.lineTo(x + 6, y); ctx.lineTo(x + 58, y); ctx.lineTo(x + 64, y + 9);
  ctx.lineTo(x + w, y + 9); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
  ctx.fillStyle = it.locked ? 'rgba(10,14,22,0.85)' : sel ? rgba(th.accent, 0.13) : 'rgba(8,16,28,0.88)';
  ctx.fill();
  ctx.strokeStyle = it.locked ? rgba(C.dim, 0.18) : sel ? th.accent : rgba(th.accent, active ? 0.7 : 0.3);
  ctx.lineWidth = sel ? 1.5 : 1;
  ctx.stroke();
  if (!it.locked) { ctx.fillStyle = th.accent; ctx.fillRect(x + 8, y + 2, 3, 5); }
  txt(ctx, it.label, x + 15, y + 7.5, 8, it.locked ? C.faint : sel ? C.text : C.dim, 'left', 'bold');

  if (it.locked) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x + 1, y + 10, w - 2, h - 11); ctx.clip();
    ctx.strokeStyle = 'rgba(111,134,163,0.07)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = -h; k < w; k += 9) { ctx.moveTo(x + k, y + h); ctx.lineTo(x + k + h, y + 10); }
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x + 12, y + 22, 72, 9); ctx.fillRect(x + 12, y + 36, 104, 9); ctx.fillRect(x + 12, y + 62, 54, 7);
    ctx.translate(x + w / 2 + 10, y + 50); ctx.rotate(-0.16);
    ctx.strokeStyle = rgba(C.danger, 0.55); ctx.lineWidth = 1.5;
    ctx.strokeRect(-52, -11, 104, 20);
    txt(ctx, 'CLASSIFIED', 0, 4, 12, rgba(C.danger, 0.7), 'center', 'bold');
    ctx.restore();
    return;
  }
  txt(ctx, pad3(m), x + 10, y + 44, 26, sel ? C.text : th.accent, 'left', 'bold');
  const words = shortName(id.codename).split(' ');
  txt(ctx, words[0] ?? '', x + 70, y + 27, 10, sel ? C.text : rgba(C.text, 0.75), 'left', 'bold');
  txt(ctx, words.slice(1).join(' '), x + 70, y + 40, 10, sel ? C.text : rgba(C.text, 0.75), 'left', 'bold');
  txt(ctx, `${id.city}, ${id.country}`, x + 10, y + 60, 9, C.dim, 'left', 'bold');
  if (cleared) {
    txt(ctx, `✓${rec.clears}  KIA ${rec.deaths ?? 0}  ${fmtTime(rec.bestFrames)}`, x + 10, y + 76, 9, rgba(C.good, 0.85), 'left', 'bold');
    if (rec.bestRank) {
      const rc = RANK_COL[rec.bestRank] ?? C.dim;
      ctx.save();
      ctx.translate(x + w - 22, y + 60); ctx.rotate(-0.25);
      ctx.strokeStyle = rc; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, 13, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 10, 0, TAU); ctx.stroke();
      txt(ctx, rec.bestRank[0], 0, 4.5, 12, rc, 'center', 'bold');
      ctx.restore();
    }
  } else if ((rec?.deaths ?? 0) > 0) {
    txt(ctx, `UNSOLVED · KIA ${rec.deaths}`, x + 10, y + 76, 9, rgba(C.danger, 0.85), 'left', 'bold');
  } else {
    txt(ctx, 'NO FIELD DATA', x + 10, y + 76, 9, rgba(C.dim, 0.6), 'left', 'bold');
  }
  if (active && (frame >> 4) % 2 === 0) {
    ctx.fillStyle = C.danger;
    ctx.fillRect(x + w - 50, y + 1, 46, 11);
    txt(ctx, 'ACTIVE', x + w - 27, y + 10, 9, '#fff', 'center', 'bold');
  }
  if (sel) {
    const sx = x + ((frame * 3) % w);
    ctx.fillStyle = rgba(th.accent, 0.35);
    ctx.fillRect(sx, y + 10, 1, h - 10);
  }
}

function drawArrow(ctx, it, sel, th, frame) {
  const dis = it.disabled;
  ctx.fillStyle = sel ? rgba(th.accent, 0.12) : 'rgba(255,255,255,0.02)';
  ctx.fillRect(it.x, it.y, it.w, it.h);
  ctx.strokeStyle = dis ? rgba(C.dim, 0.12) : sel ? th.accent : rgba(th.accent, 0.3);
  ctx.lineWidth = 1;
  ctx.strokeRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1);
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2, d = it.dir;
  const nudge = sel ? Math.sin(frame * 0.15) * 3 * d : 0;
  ctx.strokeStyle = dis ? rgba(C.dim, 0.2) : sel ? C.text : th.accent; ctx.lineWidth = 3;
  for (let k = 0; k < 2; k++) {
    const ox = cx + nudge + (k - 0.5) * 9 * d;
    ctx.beginPath(); ctx.moveTo(ox - 5 * d, cy - 11); ctx.lineTo(ox + 5 * d, cy); ctx.lineTo(ox - 5 * d, cy + 11); ctx.stroke();
  }
  const s = it.label;
  for (let i = 0; i < s.length; i++) txt(ctx, s[i], cx, cy + 40 + i * 12, 10, dis ? rgba(C.dim, 0.25) : C.dim, 'center', 'bold');
}

function drawBackBtn(ctx, it, sel, th, label = '◂ ' + it.label) {
  ctx.fillStyle = sel ? rgba(th.accent, 0.16) : 'rgba(255,255,255,0.03)';
  ctx.fillRect(it.x, it.y, it.w, it.h);
  ctx.strokeStyle = sel ? th.accent : rgba(th.accent, 0.3); ctx.lineWidth = 1;
  ctx.strokeRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1);
  txt(ctx, label, it.x + 14, it.y + it.h / 2 + 5, 14, sel ? C.text : C.dim, 'left', 'bold');
  txt(ctx, 'ESC', it.x + it.w - 10, it.y + it.h / 2 + 4, 9, rgba(C.dim, 0.6), 'right', 'bold');
}

/** Tiny equirectangular world map with mission pins. */
function miniMap(ctx, x, y, w, h, pins, selM, acc, frame) {
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = rgba(acc, 0.25); ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  const cw = w / 36, ch = h / 18;
  ctx.fillStyle = rgba(acc, 0.35);
  ctx.beginPath();
  LAND.forEach((ranges, r) => {
    for (const [a, b] of ranges) for (let c = a; c <= b; c++) {
      ctx.rect(x + c * cw + cw * 0.25, y + r * ch + ch * 0.25, Math.max(1, cw * 0.5), Math.max(1, ch * 0.5));
    }
  });
  ctx.fill();
  const px = lon => x + (lon + 180) / 360 * w, py = lat => y + (90 - lat) / 180 * h;
  for (const p of pins) {
    ctx.fillStyle = p.color;
    ctx.fillRect(px(p.lon) - 1.5, py(p.lat) - 1.5, 3, 3);
  }
  const s = pins.find(p => p.m === selM);
  if (s) {
    const sx = px(s.lon), sy = py(s.lat);
    ctx.strokeStyle = rgba(C.danger, 0.6);
    line(ctx, x, sy + 0.5, x + w, sy + 0.5); line(ctx, sx + 0.5, y, sx + 0.5, y + h);
    ctx.strokeStyle = C.danger; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sx, sy, 4 + (frame % 40) / 10, 0, TAU); ctx.stroke();
  }
}

export function drawSelect(ctx, app, screen, frame) {
  const save = app.save ?? {};
  const hi = Math.max(1, save.highest ?? 1);
  const th = themeFor(hi);
  backdrop(ctx, th, frame);
  topBar(ctx, th, frame, 'MISSION ARCHIVE · CASE FILES');
  const page = screen.page ?? 0;
  const first = page * PER_PAGE + 1, last = first + PER_PAGE - 1;
  spaced(ctx, 'MISSION ARCHIVE', VW / 2, 70, 22, C.text, 4, 'center', 'bold');
  txt(ctx, `CASE FILES ${pad3(first)}–${pad3(last)} · PAGE ${String(page + 1).padStart(2, '0')} / ${app.debug ? '∞' : String((screen.lastPage ?? 0) + 1).padStart(2, '0')} · MISSIONS NEVER END`, VW / 2, 88, 10, C.dim, 'center', 'bold');
  const st = careerStats(save);
  txt(ctx, `CLEARED ${st.cleared}`, VW - 28, 62, 12, C.good, 'right', 'bold');
  txt(ctx, `DEATHS ${st.deaths}`, VW - 28, 78, 10, rgba(C.danger, 0.8), 'right', 'bold');

  const age = selAge(screen, frame);
  screen.items.forEach((it, i) => {
    const sel = i === screen.sel;
    if (it.kind === 'card') drawCard(ctx, app, it, sel, frame, hi);
    else if (it.kind === 'arrow') drawArrow(ctx, it, sel, th, frame);
    else drawBackBtn(ctx, it, sel, th);
  });
  const b = selFrame(screen);
  if (b) brackets(ctx, b.x - 4, b.y - 4 - (screen.items[screen.sel]?.kind === 'card' ? 3 : 0), b.w + 8, b.h + 8, 8, th.accent, 1.5);

  // detail strip
  const y0 = 478;
  panel(ctx, 24, y0, VW - 48, 54, th.accent, 0.75);
  const it = screen.items[screen.sel];
  const pins = screen.items.filter(c => c.kind === 'card' && !c.locked).map(c => {
    const id = ident(c.mission);
    return { m: c.mission, lat: id.lat, lon: id.lon, color: (save.missions?.[c.mission]?.clears ?? 0) > 0 ? C.good : th.accent };
  });
  miniMap(ctx, VW - 196, y0 + 5, 160, 44, pins, it?.mission, th.accent, frame);
  if (it?.kind === 'card') {
    const id = ident(it.mission), rec = save.missions?.[it.mission];
    const mt = themeFor(it.mission);
    const head = `M-${pad3(it.mission)} // ${id.codename}`;
    txt(ctx, scramble(head, age * 3, frame, 3), 40, y0 + 22, 14, C.text, 'left', 'bold');
    ctx.fillStyle = mt.accent; ctx.fillRect(34, y0 + 10, 3, 38);
    const info = `${id.city}, ${id.country} · ${fmtLat(id.lat)} ${fmtLon(id.lon)} · CLEARS ${rec?.clears ?? 0} · DEATHS ${rec?.deaths ?? 0} · BEST ${fmtTime(rec?.bestFrames)} · RANK ${rec?.bestRank ?? '—'}`;
    txt(ctx, info, 40, y0 + 40, 10, C.dim, 'left', 'bold');
  } else if (it?.kind === 'arrow') {
    const p = it.page;
    txt(ctx, `ARCHIVE PAGE ${p + 1} · CASE FILES ${pad3(p * PER_PAGE + 1)}–${pad3(p * PER_PAGE + PER_PAGE)}`, 40, y0 + 22, 14, C.text, 'left', 'bold');
    txt(ctx, 'Every file holds a mission that re-rolls its trap matrix on every attempt.', 40, y0 + 40, 10, C.dim, 'left', 'bold');
  } else {
    txt(ctx, 'RETURN TO HQ', 40, y0 + 22, 14, C.text, 'left', 'bold');
    txt(ctx, 'Locked files are CLASSIFIED until the previous mission is cleared.', 40, y0 + 40, 10, C.dim, 'left', 'bold');
  }
}

// ===========================================================================
// FIELD MANUAL
// ===========================================================================
export function buildHowTo() {
  return { items: [{ kind: 'back', x: 40, y: 484, w: 240, h: 42, action: 'back', label: 'BACK TO HQ' }], sel: 0, back: 'back', kind: 'howto' };
}

function keycap(ctx, label, x, y, th) {
  const w = Math.max(28, textW(ctx, label, 12, 'bold') + 16);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  rrect(ctx, x, y + 3, w, 26, 4); ctx.fill();
  ctx.fillStyle = '#0d1a2c';
  rrect(ctx, x, y, w, 26, 4); ctx.fill();
  ctx.strokeStyle = rgba(th.accent, 0.55); ctx.lineWidth = 1; ctx.stroke();
  txt(ctx, label, x + w / 2, y + 17, 12, C.text, 'center', 'bold');
  return w;
}

const wrapCache = new Map();
function wrap(ctx, s, size, maxW, weight = '') {
  const key = `${size}|${maxW}|${weight}|${s}`;
  let lines = wrapCache.get(key);
  if (lines) return lines;
  setFont(ctx, size, weight);
  lines = [];
  let cur = '';
  for (const word of s.split(' ')) {
    const t = cur ? cur + ' ' + word : word;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = word; } else cur = t;
  }
  if (cur) lines.push(cur);
  if (wrapCache.size > 400) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}

function ecgShape(ph) {
  const g = (c, s) => Math.exp(-((ph - c) ** 2) / (2 * s * s));
  return 0.1 * g(0.14, 0.025) - 0.12 * g(0.235, 0.008) + g(0.25, 0.011) - 0.25 * g(0.268, 0.01) + 0.25 * g(0.45, 0.04);
}
export { ecgShape };

const RULE_ICONS = {
  matrix(ctx, x, y, frame, th) {
    const code = hexRoll(frame >> 3, 5);
    drawFingerprint(ctx, code, x + 2, y + 6, 3, th.accent, rgba(th.accent, 0.25));
    txt(ctx, code.slice(0, 4), x + 20, y + 36, 9, C.warn, 'center', 'bold');
  },
  scan(ctx, x, y, frame, th) {
    for (let i = 0; i < 3; i++) {
      const p = ((frame / 60) + i / 3) % 1;
      ctx.strokeStyle = rgba(C.scan, 1 - p); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x + 20, y + 20, 3 + p * 17, 0, TAU); ctx.stroke();
    }
    ctx.fillStyle = C.danger; ctx.fillRect(x + 30, y + 26, 5, 5);
  },
  pulse(ctx, x, y, frame) {
    ctx.strokeStyle = C.danger; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const ph = ((i + frame * 1.2) / 20) % 1;
      const v = ecgShape(ph);
      if (i) ctx.lineTo(x + i, y + 26 - v * 18); else ctx.moveTo(x + i, y + 26 - v * 18);
    }
    ctx.stroke();
  },
  key(ctx, x, y) {
    ctx.fillStyle = C.key; rrect(ctx, x + 9, y + 6, 22, 30, 3); ctx.fill();
    ctx.fillStyle = '#5a4300'; ctx.fillRect(x + 13, y + 11, 9, 7);
    ctx.fillRect(x + 13, y + 24, 14, 2); ctx.fillRect(x + 13, y + 29, 10, 2);
  },
  decoy(ctx, x, y, frame) {
    for (let k = 0; k < 2; k++) {
      const dx = x + 3 + k * 20;
      ctx.strokeStyle = k ? C.good : rgba(C.good, 0.8); ctx.lineWidth = 1.5;
      ctx.strokeRect(dx, y + 8, 14, 26);
    }
    txt(ctx, (frame >> 4) % 2 ? '?' : '!', x + 10, y + 26, 13, C.danger, 'center', 'bold');
  },
  rank(ctx, x, y, frame) { drawRankBadge(ctx, 'GHOST', x + 20, y + 20, 15, frame); },
};

const RULES = [
  ['matrix', 'TRAP MATRIX', 'Every attempt (first try, death, restart) builds a brand-new trap layout that never repeats. Memorizing is useless: read the room.'],
  ['scan', 'SCANNER', 'Press SCAN to pulse 10 m around you and tag hidden traps. The gadget then needs to recharge (watch dial, bottom-left).'],
  ['pulse', 'HEART-RATE MONITOR', 'Your pulse (top-right) climbs near ANY trap — even ones you cannot see. 68 BPM is calm. 180 means stop and think.'],
  ['key', 'KEYCARDS', 'Some exits are locked until every keycard is collected. Not every keycard is real.'],
  ['decoy', 'DECOY EXITS', 'An exit can be a decoy that kills on touch, or the real one may run away. Trust nothing.'],
  ['rank', 'RANKS', 'GHOST: no deaths and under par · AGENT: ≤2 deaths · OPERATIVE: ≤8 · ROOKIE: everything else.'],
];

export function drawHowTo(ctx, app, screen, frame) {
  const th = themeFor(Math.max(1, app.save?.highest ?? 1));
  backdrop(ctx, th, frame);
  topBar(ctx, th, frame, 'FIELD MANUAL · REV. ∞');
  spaced(ctx, 'FIELD MANUAL', 40, 76, 24, C.text, 4, 'left', 'bold');
  txt(ctx, 'READ ONCE. THE TRAPS WILL NOT RETURN THE FAVOUR.', 40, 94, 10, th.accent, 'left', 'bold');

  // controls
  panel(ctx, 40, 112, 392, 352, th.accent, 0.6);
  txt(ctx, 'CONTROLS', 56, 136, 12, th.accent, 'left', 'bold');
  const rows = [
    ['MOVE', [['←', '→'], ['A', 'D']]],
    ['JUMP', [['SPACE', '↑', 'W']]],
    ['SCAN', [['E', 'SHIFT', 'X']]],
    ['NEW MATRIX', [['R']], 'restart with a fresh layout'],
    ['PAUSE', [['ESC', 'P']]],
  ];
  rows.forEach(([name, groups, note], i) => {
    const y = 154 + i * 52;
    txt(ctx, name, 56, y + 18, 12, C.text, 'left', 'bold');
    let x = 168;
    groups.forEach((g, gi) => {
      if (gi) { txt(ctx, 'or', x + 4, y + 18, 10, C.dim); x += 22; }
      g.forEach(k => { x += keycap(ctx, k, x, y, th) + 5; });
    });
    if (note) txt(ctx, note, 168, y + 42, 9, C.dim, 'left', 'bold');
    ctx.fillStyle = rgba(th.accent, 0.1); ctx.fillRect(56, y + 46, 360, 1);
  });
  txt(ctx, 'TOUCH: on-screen buttons appear on phones / tablets.', 56, 446, 10, C.dim, 'left', 'bold');

  // rules
  RULES.forEach(([icon, title, body], i) => {
    const x = 456, y = 112 + i * 60;
    ctx.fillStyle = 'rgba(4,8,15,0.6)';
    ctx.fillRect(x, y, 464, 54);
    ctx.strokeStyle = rgba(th.accent, 0.2); ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, 463, 53);
    ctx.fillStyle = th.accent; ctx.fillRect(x, y, 2, 54);
    RULE_ICONS[icon](ctx, x + 8, y + 7, frame, th);
    txt(ctx, `${String(i + 1).padStart(2, '0')} ${title}`, x + 58, y + 16, 12, C.text, 'left', 'bold');
    wrap(ctx, body, 10, 396).slice(0, 3).forEach((ln, k) => txt(ctx, ln, x + 58, y + 30 + k * 11, 10, C.dim));
  });

  screen.items.forEach((it, i) => drawBackBtn(ctx, it, i === screen.sel, th));
  const b = selFrame(screen);
  if (b) brackets(ctx, b.x - 4, b.y - 4, b.w + 8, b.h + 8, 8, th.accent, 1.5);
}

// ===========================================================================
// BRIEFING: the paper dossier (fx burns it away on accept)
// ===========================================================================
const INK = '#1a1c22', INK2 = '#4a4d55', RED = '#b3122e';

export function buildBriefing(app) {
  const def = app.def ?? {};
  const m = def.mission ?? app.mission ?? 1;
  const keys = def.keysNeeded ?? 0;
  const lines = [
    { s: `MISSION ${pad3(m)} · CLEARANCE OMEGA`, size: 11, color: INK2, h: 18 },
    { s: def.codename ?? 'OPERATION UNKNOWN', size: 22, bold: true, h: 30 },
    { s: `LOCATION ...... ${def.city ?? '?'}, ${def.country ?? '?'}`, h: 18 },
    { s: `COORDINATES ... ${fmtLat(def.lat ?? 0)}  ${fmtLon(def.lon ?? 0)}`, h: 18 },
    { s: 'THREAT LEVEL .. ', threat: def.threat ?? 1, h: 18 },
    { s: `KEYCARDS ...... ${keys ? keys + ' REQUIRED · TRUST NONE' : 'NONE ON FILE'}`, h: 18 },
    { s: `SCANNER ....... RECHARGE ${((def.scanCooldown ?? 150) / 60).toFixed(1)} s`, h: 18 },
    { s: `PAR TIME ...... ${fmtTime(def.par)}`, h: 18 },
    { s: `ENCOUNTERS .... ${def.slots?.length ?? '?'} · DETAILS ████████`, h: 26 },
    { s: `TRAP MATRIX #${def.matrix ?? '????-????'} — RANDOMIZED`, size: 14, bold: true, color: RED, mark: true, h: 20 },
    { s: 'Layout re-rolls on every attempt. Recon is worthless.', size: 11, h: 15 },
    { s: 'Objective: reach extraction ███████ alive.', size: 11, h: 15 },
    { s: 'Your mission, should you choose to accept it...', size: 11, h: 15, italic: true },
  ];
  return {
    items: [
      { kind: 'accept', x: 590, y: 462, w: 306, h: 50, action: 'accept', label: 'ACCEPT MISSION' },
      { kind: 'decline', x: 432, y: 462, w: 144, h: 50, action: 'menu', label: 'DECLINE' },
    ],
    sel: 0, back: 'menu', kind: 'brief', lines,
  };
}

/** Draw a line of typed text; '█' runs become redaction bars. */
function inkLine(ctx, s, x, y, size, color, weight, italic) {
  setFont(ctx, size, `${italic ? 'italic ' : ''}${weight}`.trim());
  ctx.textAlign = 'left';
  const cw = ctx.measureText('M').width;
  let i = 0;
  while (i < s.length) {
    let j = i;
    const bar = s[i] === '█';
    while (j < s.length && (s[j] === '█') === bar) j++;
    const seg = s.slice(i, j);
    if (bar) {
      ctx.fillStyle = '#0b0b0d';
      ctx.fillRect(x + i * cw, y - size * 0.8, seg.length * cw, size * 0.98);
    } else {
      ctx.fillStyle = color;
      ctx.fillText(seg, x + i * cw, y);
    }
    i = j;
  }
  return s.length * cw;
}

function stamp(ctx, text, x, y, rot, size, color, t, frame, sub = null, knock = true) {
  if (t < 0) return;
  const k = clamp(t / 6);
  const sc = lerp(2.4, 1, easeOut(k));
  ctx.save();
  ctx.globalAlpha *= k * 0.88;
  ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sc, sc);
  setFont(ctx, size, 'bold');
  const w = ctx.measureText(text).width + size;
  const h = size * (sub ? 2.1 : 1.45);
  if (!knock) { ctx.fillStyle = rgba(C.paper, 0.92); ctx.fillRect(-w / 2, -h / 2, w, h); }
  ctx.strokeStyle = color; ctx.lineWidth = 2.5;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.lineWidth = 1;
  ctx.strokeRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8);
  txt(ctx, text, 0, sub ? size * 0.05 : size * 0.36, size, color, 'center', 'bold');
  if (sub) txt(ctx, sub, 0, size * 0.72, Math.round(size * 0.4), color, 'center', 'bold');
  // rubber texture: knock-outs
  ctx.fillStyle = C.paper;
  if (knock) for (let i = 0; i < 26; i++) ctx.fillRect((h32(i, 3) - 0.5) * w, (h32(i, 4) - 0.5) * h, 1 + h32(i, 5) * 2.5, 1 + h32(i, 6) * 1.5);
  ctx.restore();
  void frame;
}

function paper(ctx, x, y, w, h, seed) {
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(x + 6, y + 8, w, h);
  const g = ctx.createLinearGradient(x, y, x + w * 0.3, y + h);
  g.addColorStop(0, '#e2dcc9'); g.addColorStop(0.6, C.paper); g.addColorStop(1, '#c9c1aa');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // fibres
  ctx.strokeStyle = 'rgba(90,70,40,0.07)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 60; i++) {
    const fx = x + h32(i, seed) * w, fy = y + h32(i, seed + 1) * h, l = 6 + h32(i, seed + 2) * 18;
    ctx.moveTo(fx, fy); ctx.lineTo(fx + l, fy + (h32(i, seed + 3) - 0.5) * 4);
  }
  ctx.stroke();
  // edge darkening
  const e = ctx.createLinearGradient(x, 0, x + 26, 0);
  e.addColorStop(0, 'rgba(80,60,30,0.16)'); e.addColorStop(1, 'rgba(80,60,30,0)');
  ctx.fillStyle = e; ctx.fillRect(x, y, 26, h);
}

export function drawBriefing(ctx, app, screen, t) {
  const def = app.def ?? {};
  const m = def.mission ?? app.mission ?? 1;
  const th = themeFor(m);
  const frame = app.frame ?? t;
  // desk
  backdrop(ctx, th, frame);
  const slide = (1 - easeOut(clamp(t / 16))) * 36;
  ctx.save();
  ctx.globalAlpha = clamp(t / 6);
  ctx.translate(0, slide);

  const PX = 36, PY = 20, PW = 888, PH = 504;
  // accent folder tab
  ctx.fillStyle = th.accent;
  ctx.fillRect(PX + PW - 150, PY - 9, 110, 12);
  txt(ctx, `FILE M-${pad3(m)}`, PX + PW - 95, PY - 0.5, 9, C.bg0, 'center', 'bold');
  paper(ctx, PX, PY, PW, PH, 11);
  // coffee ring
  ctx.save();
  ctx.beginPath(); ctx.rect(PX, PY, PW, PH); ctx.clip();
  ctx.strokeStyle = 'rgba(110,70,30,0.13)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(PX + PW - 30, PY + PH - 18, 44, 0, TAU * 0.86); ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(PX + PW - 30, PY + PH - 18, 38, 0.5, TAU * 0.7); ctx.stroke();
  ctx.restore();

  // header
  spaced(ctx, 'IMPOSSIBLE MISSIONS FORCE', PX + 30, PY + 30, 13, INK, 2, 'left', 'bold');
  txt(ctx, `EYES ONLY · DIRECTORATE OF OPERATIONS · DOSSIER M-${pad3(m)}/${(def.matrix ?? '').slice(0, 4)}`, PX + 30, PY + 46, 9, INK2, 'left', 'bold');
  ctx.fillStyle = INK; ctx.fillRect(PX + 28, PY + 56, PW - 56, 2); ctx.fillRect(PX + 28, PY + 60, PW - 56, 1);

  // typed lines
  const lines = screen.lines ?? buildBriefing(app).lines;
  let budget = Math.max(0, (t - 14) * 3.2);
  let y = PY + 84;
  const LX = PX + 30;
  let caret = null;
  for (const ln of lines) {
    const size = ln.size ?? 12;
    const n = Math.min(ln.s.length, Math.floor(budget));
    budget -= ln.s.length + 4;
    if (n <= 0) { if (!caret) caret = { x: LX, y, size }; break; }
    const shown = ln.s.slice(0, n);
    if (ln.mark && n > 0) {
      ctx.fillStyle = 'rgba(255,214,60,0.55)';
      setFont(ctx, size, 'bold');
      ctx.fillRect(LX - 4, y - size + 1, ctx.measureText(shown).width + 8, size + 4);
    }
    const w = inkLine(ctx, shown, LX, y, size, ln.color ?? INK, ln.bold ? 'bold' : '', ln.italic);
    if (ln.threat && n >= ln.s.length) {
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = i < ln.threat ? RED : 'rgba(0,0,0,0.15)';
        ctx.fillRect(LX + w + i * 15, y - 10, 11, 11);
      }
      txt(ctx, `${ln.threat}/5`, LX + w + 80, y, 11, INK2, 'left', 'bold');
    }
    if (n < ln.s.length) { caret = { x: LX + w, y, size }; break; }
    y += ln.h ?? 18;
  }
  if (caret && (frame >> 3) % 2 === 0) { ctx.fillStyle = INK; ctx.fillRect(caret.x + 1, caret.y - caret.size + 2, caret.size * 0.55, caret.size); }

  // satellite photo: live globe centred on the target city
  const GX = PX + 560, GY = PY + 70, GW = 300, GH = 222;
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(GX + 4, GY + 5, GW, GH);
  ctx.fillStyle = '#04070d'; ctx.fillRect(GX, GY, GW, GH);
  ctx.save();
  ctx.beginPath(); ctx.rect(GX, GY, GW, GH); ctx.clip();
  const lat = def.lat ?? 0, lon = def.lon ?? 0;
  const spin = (1 - easeOut(clamp(t / 90))) * TAU;
  const tp = drawGlobe(ctx, GX + GW / 2, GY + GH / 2 + 4, 92, {
    lon0: lon * DEG - spin + Math.sin(t / 200) * 0.25, tilt: clamp(lat * 0.8, -50, 50) * DEG, accent: th.accent, frame, target: { lat, lon }, targetColor: C.danger,
  });
  if (tp.vis && t > 90) {
    ctx.strokeStyle = rgba(C.danger, 0.5); ctx.lineWidth = 1;
    line(ctx, GX, tp.y + 0.5, GX + GW, tp.y + 0.5); line(ctx, tp.x + 0.5, GY, tp.x + 0.5, GY + GH);
  }
  txt(ctx, 'SAT-7 // LIVE', GX + 8, GY + 14, 9, th.accent, 'left', 'bold');
  txt(ctx, t > 90 ? 'TARGET LOCKED' : 'ACQUIRING…', GX + GW - 8, GY + 14, 9, C.danger, 'right', 'bold');
  txt(ctx, `${fmtLat(lat)} ${fmtLon(lon)}`, GX + 8, GY + GH - 8, 9, th.accent, 'left', 'bold');
  txt(ctx, def.city ?? '', GX + GW - 8, GY + GH - 8, 10, C.text, 'right', 'bold');
  ctx.restore();
  // photo corners
  ctx.fillStyle = '#2a2620';
  for (const [cx, cy, sx, sy] of [[GX, GY, 1, 1], [GX + GW, GY, -1, 1], [GX, GY + GH, 1, -1], [GX + GW, GY + GH, -1, -1]]) {
    ctx.beginPath(); ctx.moveTo(cx - sx * 4, cy - sy * 4); ctx.lineTo(cx + sx * 18, cy - sy * 4); ctx.lineTo(cx - sx * 4, cy + sy * 18); ctx.closePath(); ctx.fill();
  }
  txt(ctx, `FIG. 1 — TARGET CITY · ${def.city ?? ''}, ${def.country ?? ''}`, GX, GY + GH + 16, 9, INK2, 'left', 'bold');

  // recon strip (thumbnail of THIS matrix)
  const SX = PX + 30, SY = PY + 334, SW = PW - 60, SH = 78;
  ctx.fillStyle = '#f4f0e4'; ctx.fillRect(SX - 5, SY - 5, SW + 10, SH + 10);
  ctx.fillStyle = '#04070d'; ctx.fillRect(SX, SY, SW, SH);
  if (app.run && typeof app.renderer?.drawThumbnail === 'function') {
    ctx.save();
    ctx.beginPath(); ctx.rect(SX, SY, SW, SH); ctx.clip();
    app.renderer.drawThumbnail(ctx, app.run, SX, SY, SW, SH, t);
    ctx.restore();
  }
  const scanX = SX + ((t * 4) % (SW + 60)) - 30;
  if (scanX > SX && scanX < SX + SW) {
    ctx.fillStyle = rgba(th.accent, 0.5); ctx.fillRect(scanX, SY, 2, SH);
  }
  // paperclip
  ctx.strokeStyle = '#8d9097'; ctx.lineWidth = 2;
  rrect(ctx, SX + 20, SY - 16, 12, 34, 6); ctx.stroke();
  rrect(ctx, SX + 23, SY - 11, 6, 24, 3); ctx.stroke();
  txt(ctx, `FIG. 2 — SAT-RECON · MATRIX #${def.matrix ?? ''} ·`, SX, SY + SH + 18, 9, INK2, 'left', 'bold');
  const capW = textW(ctx, `FIG. 2 — SAT-RECON · MATRIX #${def.matrix ?? ''} · `, 9, 'bold');
  txt(ctx, 'VALID FOR ONE ATTEMPT ONLY', SX + capW, SY + SH + 18, 9, RED, 'left', 'bold');
  drawFingerprint(ctx, def.matrix, SX + capW + 160, SY + SH + 9, 2, INK, 'rgba(0,0,0,0.2)');

  // stamps
  stamp(ctx, 'TOP SECRET', PX + PW - 140, PY + 34, -0.1, 20, RED, t - 30, frame);
  stamp(ctx, 'VOID AFTER USE', SX + SW - 130, SY + SH + 6, -0.06, 14, RED, t - 70, frame, 'MATRIX ROTATES ON FAILURE', false);

  // self-destruct line + fuse
  const blink = (frame >> 4) % 2 === 0;
  ctx.fillStyle = blink ? RED : 'rgba(179,18,46,0.3)';
  ctx.beginPath(); ctx.arc(SX + 4, PY + PH - 46, 4, 0, TAU); ctx.fill();
  txt(ctx, 'THIS MESSAGE WILL SELF-DESTRUCT', SX + 14, PY + PH - 42, 11, RED, 'left', 'bold');
  const fp = 0.94 * (1 - Math.exp(-t / 700));
  drawFuse(ctx, SX, SX + 352, PY + PH - 24, fp, frame, { rope: '#6f5d3e' });

  // buttons
  screen.items.forEach((it, i) => {
    const sel = i === screen.sel;
    if (it.kind === 'accept') {
      const pulse = sel ? 0.5 + 0.5 * Math.sin(frame * 0.15) : 0;
      if (sel) {
        ctx.strokeStyle = rgba(RED, 0.35 + pulse * 0.4); ctx.lineWidth = 2;
        ctx.strokeRect(it.x - 5, it.y - 5, it.w + 10, it.h + 10);
      }
      ctx.fillStyle = sel ? RED : 'rgba(179,18,46,0.06)';
      ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.strokeStyle = RED; ctx.lineWidth = 2.5; ctx.strokeRect(it.x, it.y, it.w, it.h);
      ctx.lineWidth = 1; ctx.strokeRect(it.x + 4, it.y + 4, it.w - 8, it.h - 8);
      const col = sel ? '#f4ecd8' : RED;
      txt(ctx, '▶', it.x + 22, it.y + 32, 16, col, 'left', 'bold');
      spaced(ctx, it.label, it.x + 44, it.y + 32, 18, col, 1.5, 'left', 'bold');
      txt(ctx, '[ENTER]', it.x + it.w - 14, it.y + 31, 10, col, 'right', 'bold');
    } else {
      ctx.fillStyle = sel ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.03)';
      ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.strokeStyle = INK; ctx.lineWidth = sel ? 2 : 1; ctx.strokeRect(it.x, it.y, it.w, it.h);
      txt(ctx, it.label, it.x + it.w / 2, it.y + 24, 14, INK, 'center', 'bold');
      txt(ctx, 'RETURN TO HQ', it.x + it.w / 2, it.y + 39, 8, INK2, 'center', 'bold');
    }
  });
  ctx.restore();
}

// ===========================================================================
// PAUSE
// ===========================================================================
export function buildPause(app) {
  const save = app.save ?? {};
  const X = 64, W = 344;
  const items = [
    { kind: 'cmd', x: X, y: 142, w: W, h: 46, action: 'resume', label: 'RESUME', suffix: '', note: '// clock restarts the moment you move' },
    { kind: 'cmd', x: X, y: 194, w: W, h: 46, action: 'retry', label: 'NEW MATRIX', suffix: 'R', note: '// abort attempt · regenerate every trap' },
  ];
  [['sound', 'SOUND'], ['music', 'MUSIC'], ['fx', 'EFFECTS']].forEach(([key, label], i) => {
    items.push({ kind: 'chip', x: X + i * 116, y: 252, w: 110, h: 40, action: 'toggle', key, label, on: !!save[key] });
  });
  items.push({ kind: 'cmd', x: X, y: 304, w: W, h: 46, action: 'menu', label: 'ABORT TO HQ', suffix: '', note: '// mission progress is kept' });
  return { items, sel: 0, back: 'resume', kind: 'pause' };
}

export function drawPause(ctx, app, screen, frame) {
  const def = app.def ?? {};
  const run = app.run;
  const th = themeFor(def.mission ?? app.mission ?? 1);
  veil(ctx, 0.72);
  // left: command panel
  panel(ctx, 44, 64, 384, 310, th.accent, 0.82);
  spaced(ctx, 'OPERATION SUSPENDED', 64, 96, 16, C.text, 2, 'left', 'bold');
  txt(ctx, `CLOCK FROZEN AT T+${fmtTime(run?.frame ?? 0)}`, 64, 116, 10, th.accent, 'left', 'bold');
  // pause glyph
  const pa = 0.5 + 0.5 * Math.sin(frame * 0.08);
  ctx.fillStyle = rgba(th.accent, 0.4 + pa * 0.5);
  ctx.fillRect(388, 80, 6, 22); ctx.fillRect(399, 80, 6, 22);
  const age = selAge(screen, frame);
  screen.items.forEach((it, i) => {
    if (it.kind === 'chip') drawChip(ctx, it, i === screen.sel, th);
    else drawCmdItem(ctx, it, i === screen.sel, th, frame, age);
  });
  const b = selFrame(screen);
  if (b) brackets(ctx, b.x - 5, b.y - 2, b.w + 10, b.h + 4, 9, th.accent, 2);

  // right: tactical overview
  const X = 456, Y = 64, W = 460;
  panel(ctx, X, Y, W, 310, th.accent, 0.82);
  txt(ctx, 'TACTICAL OVERVIEW', X + 20, Y + 28, 12, th.accent, 'left', 'bold');
  txt(ctx, `M-${pad3(def.mission ?? 1)} · ${def.city ?? ''}, ${def.country ?? ''}`, X + W - 20, Y + 28, 10, C.dim, 'right', 'bold');
  txt(ctx, def.codename ?? '', X + 20, Y + 52, 16, C.text, 'left', 'bold');
  const TX = X + 20, TY = Y + 66, TW = W - 40, TH = 74;
  ctx.fillStyle = '#04070d'; ctx.fillRect(TX, TY, TW, TH);
  if (run && typeof app.renderer?.drawThumbnail === 'function') {
    ctx.save(); ctx.beginPath(); ctx.rect(TX, TY, TW, TH); ctx.clip();
    app.renderer.drawThumbnail(ctx, run, TX, TY, TW, TH, frame);
    ctx.restore();
  }
  ctx.strokeStyle = rgba(th.accent, 0.4); ctx.lineWidth = 1; ctx.strokeRect(TX + 0.5, TY + 0.5, TW - 1, TH - 1);
  const rows = [
    ['TRAP MATRIX', `#${def.matrix ?? '????-????'}`, C.warn],
    ['ATTEMPT', `${app.attempt ?? 1}`, C.text],
    ['DEATHS THIS MISSION', `${app.missionDeaths ?? 0}`, (app.missionDeaths ?? 0) ? C.danger : C.good],
    ['TIME / PAR', `${fmtTime(run?.frame ?? 0)} / ${fmtTime(def.par)}`, (run?.frame ?? 0) > (def.par ?? Infinity) ? C.danger : C.good],
    ['KEYCARDS', def.keysNeeded ? `${run?.keysTaken ?? 0} / ${def.keysNeeded}` : 'NONE', C.key],
    ['SCANNER', run ? (run.scan.cd > 0 ? `RECHARGING ${Math.ceil(run.scan.cd / 60)}s` : 'READY') : '—', C.scan],
  ];
  rows.forEach(([k, v, col], i) => {
    const y = TY + TH + 24 + i * 20;
    txt(ctx, k, TX, y, 10, C.dim, 'left', 'bold');
    ctx.fillStyle = rgba(th.accent, 0.12); ctx.fillRect(TX + 150, y - 3, TW - 290, 1);
    txt(ctx, v, TX + TW, y, 12, col, 'right', 'bold');
  });
  drawFingerprint(ctx, def.matrix, TX + 162, TY + TH + 14, 2, C.warn, rgba(C.warn, 0.25));

  txt(ctx, 'NOTE: choosing NEW MATRIX rebuilds every trap. Nothing you learned here will still be true.', VW / 2, 404, 10, rgba(C.dim, 0.9), 'center', 'bold');
  txt(ctx, 'ESC / P  RESUME', VW / 2, 422, 9, rgba(C.dim, 0.6), 'center', 'bold');
}

// ===========================================================================
// DEBRIEF: after-action report with a slammed stamp
// ===========================================================================
export function buildDebrief() {
  return {
    items: [
      { kind: 'primary', x: 206, y: 448, w: 232, h: 48, action: 'next', label: 'NEXT MISSION ▸' },
      { kind: 'secondary', x: 450, y: 448, w: 184, h: 48, action: 'replay', label: 'REPLAY', sub: 'NEW MATRIX' },
      { kind: 'secondary', x: 646, y: 448, w: 108, h: 48, action: 'menu', label: 'HQ', sub: 'ARCHIVE' },
    ],
    sel: 0, back: 'menu', kind: 'debrief',
  };
}

export function drawDebrief(ctx, app, screen, t) {
  const d = app.debrief ?? {};
  const def = d.def ?? app.def ?? {};
  const m = d.mission ?? def.mission ?? 1;
  const th = themeFor(m);
  const frame = app.frame ?? t;
  veil(ctx, clamp(t / 10) * 0.7);

  const IMPACT = 22;
  const shake = t >= IMPACT && t < IMPACT + 14 ? (1 - (t - IMPACT) / 14) * 7 : 0;
  const sx = shake ? (h32(t, 1) - 0.5) * shake : 0, sy = shake ? (h32(t, 2) - 0.5) * shake : 0;
  const slide = (1 - easeOut(clamp(t / 14))) * 300;
  ctx.save();
  ctx.translate(sx, sy + slide);

  const PX = 190, PY = 26, PW = 580, PH = 486;
  paper(ctx, PX, PY, PW, PH, 23);
  ctx.fillStyle = th.accent; ctx.fillRect(PX, PY, PW, 4);
  spaced(ctx, 'AFTER-ACTION REPORT', PX + 24, PY + 32, 13, INK, 2, 'left', 'bold');
  txt(ctx, `M-${pad3(m)} · ${def.codename ?? ''}`, PX + PW - 24, PY + 32, 10, INK, 'right', 'bold');
  txt(ctx, `${def.city ?? ''}, ${def.country ?? ''} · FINAL MATRIX #${def.matrix ?? ''} · EXTRACTION CONFIRMED`, PX + 24, PY + 48, 9, INK2, 'left', 'bold');
  ctx.fillStyle = INK; ctx.fillRect(PX + 22, PY + 56, PW - 44, 2);

  // the stamp
  const st = t - 12;
  if (st >= 0) {
    const k = clamp(st / (IMPACT - 12));
    const sc = lerp(3.2, 1, easeInOut(k));
    const cx = PX + PW / 2, cy = PY + 118;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(-0.09); ctx.scale(sc, sc);
    ctx.globalAlpha *= lerp(0.2, 0.92, k);
    const col = '#c0172f';
    ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.strokeRect(-200, -42, 400, 84);
    ctx.lineWidth = 1.5; ctx.strokeRect(-193, -35, 386, 70);
    spaced(ctx, 'MISSION', 0, -9, 18, col, 10, 'center', 'bold');
    spaced(ctx, 'ACCOMPLISHED', 0, 24, 30, col, 3, 'center', 'bold');
    ctx.fillStyle = C.paper;
    for (let i = 0; i < 70; i++) ctx.fillRect((h32(i, 9) - 0.5) * 396, (h32(i, 10) - 0.5) * 80, 1 + h32(i, 11) * 3, 1 + h32(i, 12) * 2);
    ctx.restore();
    if (t >= IMPACT) {
      // ink splatter
      const sp = clamp((t - IMPACT) / 5);
      ctx.fillStyle = 'rgba(192,23,47,0.75)';
      for (let i = 0; i < 18; i++) {
        const a = h32(i, 20) * TAU, r = 200 + h32(i, 21) * 40 * sp;
        const ex = cx + Math.cos(a) * r * (0.95 + 0.1 * h32(i, 22)), ey = cy + Math.sin(a) * r * 0.25;
        ctx.beginPath(); ctx.arc(ex, ey, 0.8 + h32(i, 23) * 2.6 * sp, 0, TAU); ctx.fill();
      }
    }
  }

  // stats
  const par = d.par ?? def.par ?? 0, frames = d.frames ?? 0;
  const under = frames <= par;
  const rows = [
    ['TIME', fmtTime(frames), under ? `PAR ${fmtTime(par)} · UNDER PAR` : `PAR ${fmtTime(par)} · +${fmtTime(frames - par)}`, under ? '#0f7a45' : RED],
    ['DEATHS', `${d.deaths ?? 0}`, (d.deaths ?? 0) === 0 ? 'FLAWLESS' : 'EACH ONE A DIFFERENT TRAP', (d.deaths ?? 0) ? INK2 : '#0f7a45'],
    ['TRAP MATRICES', `${d.attempts ?? 1}`, '', INK2, 'boxes'],
    ['SCANS USED', `${d.scans ?? 0}`, '', INK2],
    ['TIME ON SITE', fmtTime(d.totalFrames ?? frames), 'ALL ATTEMPTS', INK2],
    ['PERSONAL BEST', fmtTime(d.bestFrames ?? frames), d.newBestTime ? '★ NEW RECORD' : '', RED],
  ];
  const RX = PX + 30;
  rows.forEach(([k, v, note, ncol, extra], i) => {
    const rt = t - 32 - i * 7;
    if (rt < 0) return;
    const y = PY + 196 + i * 30;
    const n = Math.floor(rt * 2.5);
    txt(ctx, (k + ' ').padEnd(16, '.').slice(0, Math.min(16, n + 1)), RX, y, 12, INK2, 'left', 'bold');
    if (rt < 6) txt(ctx, scramble(v, rt * 1.5, frame, i), RX + 150, y, 16, INK, 'left', 'bold');
    else txt(ctx, v, RX + 150, y, 16, INK, 'left', 'bold');
    if (rt > 6 && note) txt(ctx, note, RX + 236, y, 10, ncol, 'left', 'bold');
    if (extra === 'boxes' && rt > 4) {
      const n2 = d.attempts ?? 1, show = Math.min(n2, 14);
      for (let j = 0; j < show; j++) {
        const bx = RX + 196 + j * 14, by = y - 11;
        const last = j === show - 1;
        ctx.strokeStyle = last ? '#0f7a45' : RED; ctx.lineWidth = 1.2;
        ctx.strokeRect(bx, by, 11, 11);
        ctx.beginPath();
        if (last) { ctx.moveTo(bx + 2, by + 6); ctx.lineTo(bx + 5, by + 9); ctx.lineTo(bx + 10, by + 2); }
        else { ctx.moveTo(bx + 2, by + 2); ctx.lineTo(bx + 9, by + 9); ctx.moveTo(bx + 9, by + 2); ctx.lineTo(bx + 2, by + 9); }
        ctx.stroke();
      }
      if (n2 > show) txt(ctx, `+${n2 - show}`, RX + 196 + show * 14 + 4, y, 10, INK2, 'left', 'bold');
    }
    ctx.fillStyle = 'rgba(0,0,0,0.08)'; ctx.fillRect(RX, y + 9, 340, 1);
  });

  // rank medal
  const rk = t - 82;
  if (rk >= 0) {
    const k = clamp(rk / 8);
    const s = lerp(2.2, 1, easeOut(k));
    const bx = PX + PW - 96, by = PY + 286;
    ctx.save();
    ctx.translate(bx, by); ctx.scale(s, s);
    drawRankBadge(ctx, d.rank ?? 'ROOKIE', 0, 0, 46, frame, k);
    ctx.restore();
    if (k >= 1) {
      txt(ctx, 'FIELD RANK', bx, by - 66, 10, INK2, 'center', 'bold');
      txt(ctx, RANK_NOTE[d.rank] ?? '', bx, by + 74, 8, INK2, 'center', 'bold');
      if (d.newBestRank && (frame >> 4) % 2 === 0) txt(ctx, '▲ NEW BEST RANK', bx, by + 88, 10, RED, 'center', 'bold');
      else if (d.bestRank && d.bestRank !== d.rank) txt(ctx, `BEST: ${d.bestRank}`, bx, by + 88, 9, INK2, 'center', 'bold');
    }
  }

  // buttons
  ctx.fillStyle = 'rgba(0,0,0,0.1)'; ctx.fillRect(PX + 22, PY + 410, PW - 44, 1);
  screen.items.forEach((it, i) => {
    const sel = i === screen.sel;
    const iy = it.y - PY - slide * 0;
    void iy;
    if (it.kind === 'primary') {
      ctx.fillStyle = sel ? '#0f7a45' : 'rgba(15,122,69,0.08)';
      ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.strokeStyle = '#0f7a45'; ctx.lineWidth = 2.5; ctx.strokeRect(it.x, it.y, it.w, it.h);
      txt(ctx, it.label, it.x + it.w / 2, it.y + 30, 16, sel ? '#f4ecd8' : '#0f7a45', 'center', 'bold');
      if (sel) { const k = 3 + Math.sin(frame * 0.15) * 2; ctx.strokeStyle = 'rgba(15,122,69,0.5)'; ctx.lineWidth = 1.5; ctx.strokeRect(it.x - k, it.y - k, it.w + 2 * k, it.h + 2 * k); }
    } else {
      ctx.fillStyle = sel ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.03)';
      ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.strokeStyle = INK; ctx.lineWidth = sel ? 2 : 1; ctx.strokeRect(it.x, it.y, it.w, it.h);
      txt(ctx, it.label, it.x + it.w / 2, it.y + 24, 14, INK, 'center', 'bold');
      txt(ctx, it.sub ?? '', it.x + it.w / 2, it.y + 39, 8, INK2, 'center', 'bold');
    }
  });
  ctx.restore();
}

// ===========================================================================
// DEATH overlay + REBUILD banner + toast
// ===========================================================================
const CAUSES = {
  spikes: ['IMPALED', 'concealed spike array'],
  fall: ['GRAVITY WON', 'fell out of the operational area'],
  crush: ['FLATTENED', 'crushed by heavy machinery'],
  laser: ['SLICED', 'laser grid contact'],
  detected: ['COMPROMISED', 'spotted by a sentry camera'],
  mine: ['VAPORIZED', 'proximity mine detonation'],
  drone: ['TERMINATED', 'hunter drone intercept'],
  walls: ['LOCKED DOWN', 'caught by the lockdown wall'],
  decoy: ['WRONG DOOR', 'the exit was a decoy'],
};

export function drawDeath(ctx, app, t, total = 42) {
  const info = app.deathInfo ?? {};
  const frame = app.frame ?? t;
  const [title, desc] = CAUSES[info.cause] ?? ['KIA', 'cause classified'];
  // red flash + darken
  const flash = Math.max(0, 1 - t / 6);
  ctx.fillStyle = `rgba(255,30,60,${0.4 * flash})`;
  ctx.fillRect(0, 0, VW, VH);
  const v = ctx.createRadialGradient(VW / 2, VH / 2, 120, VW / 2, VH / 2, VW * 0.62);
  v.addColorStop(0, `rgba(20,0,6,${0.25 * clamp(t / 6)})`); v.addColorStop(1, `rgba(40,0,10,${0.75 * clamp(t / 6)})`);
  ctx.fillStyle = v; ctx.fillRect(0, 0, VW, VH);

  // band opens from the centre
  const cy = 276, bh = 236 * easeOut(clamp(t / 7));
  const top = cy - bh / 2;
  ctx.fillStyle = 'rgba(3,2,6,0.86)';
  ctx.fillRect(0, top, VW, bh);
  ctx.fillStyle = C.danger;
  ctx.fillRect(0, top, VW, 2); ctx.fillRect(0, top + bh - 2, VW, 2);
  if (bh < 60) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, top, VW, bh); ctx.clip();

  // hex streams along the band edges: the matrix is being rewritten
  setFont(ctx, 10, 'bold');
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,46,77,0.38)';
  let s1 = '', s2 = '';
  for (let i = 0; i < 64; i++) {
    s1 += HEXD[Math.floor(h32(i, frame) * 16)] + HEXD[Math.floor(h32(i + 99, frame) * 16)] + ' ';
    s2 += HEXD[Math.floor(h32(i + 7, frame * 3) * 16)] + HEXD[Math.floor(h32(i + 55, frame) * 16)] + ' ';
  }
  ctx.fillText(s1, -((frame * 4) % 30), top + 16);
  ctx.fillText(s2, -((frame * 7) % 30), top + bh - 8);

  // AGENT DOWN
  const head = scramble('AGENT DOWN', t * 1.8, frame, 2);
  if (t < 10) {
    txt(ctx, head, VW / 2 - 4, cy - 46, 48, 'rgba(41,231,255,0.6)', 'center', 'bold');
    txt(ctx, head, VW / 2 + 4, cy - 46, 48, 'rgba(255,255,255,0.5)', 'center', 'bold');
  }
  spaced(ctx, head, VW / 2, cy - 46, 48, C.danger, 6, 'center', 'bold');
  if (t >= 4) {
    const cl = `CAUSE: ${title} — ${desc}`.toUpperCase();
    txt(ctx, cl.slice(0, Math.floor((t - 4) * 6)), VW / 2, cy - 18, 13, C.text, 'center', 'bold');
  }
  if (t >= 7 && info.taunt) {
    const s = `“${info.taunt}”`;
    txt(ctx, s.slice(0, Math.floor((t - 7) * 5)), VW / 2, cy + 6, 13, rgba(C.warn, 0.95), 'center', 'italic bold');
  }
  // matrix recalibration
  if (t >= 10) {
    const k = t - 10;
    const old = info.matrix ?? app.def?.matrix ?? '????-????';
    const ly = cy + 44;
    txt(ctx, 'MATRIX', VW / 2 - 236, ly, 11, C.dim, 'left', 'bold');
    txt(ctx, old, VW / 2 - 184, ly, 16, rgba(C.text, 0.7), 'left', 'bold');
    const ow = textW(ctx, old, 16, 'bold');
    ctx.fillStyle = C.danger;
    ctx.fillRect(VW / 2 - 188, ly - 6, (ow + 8) * clamp(k / 5), 2.5);
    if (k > 5) txt(ctx, 'COMPROMISED', VW / 2 - 184, ly + 14, 9, C.danger, 'left', 'bold');
    // arrow
    ctx.strokeStyle = C.dim; ctx.lineWidth = 1.5;
    line(ctx, VW / 2 - 40, ly - 5, VW / 2 - 6, ly - 5);
    ctx.beginPath(); ctx.moveTo(VW / 2 - 12, ly - 10); ctx.lineTo(VW / 2 - 6, ly - 5); ctx.lineTo(VW / 2 - 12, ly); ctx.stroke();
    const roll = hexRoll(frame, 3 + t);
    txt(ctx, roll, VW / 2 + 6, ly, 16, C.scan, 'left', 'bold');
    drawFingerprint(ctx, roll, VW / 2 + 102, ly - 13, 2.5, C.scan, rgba(C.scan, 0.25));
    const dots = '.'.repeat(1 + ((frame >> 3) % 3));
    txt(ctx, `RECALIBRATING TRAP MATRIX${dots}`, VW / 2 + 6, ly + 14, 9, C.scan, 'left', 'bold');
    // progress
    const p = clamp(k / Math.max(1, total - 10));
    const px = VW / 2 - 236, pw = 472, py = ly + 26;
    ctx.fillStyle = 'rgba(125,249,255,0.12)'; ctx.fillRect(px, py, pw, 5);
    ctx.fillStyle = C.scan; ctx.fillRect(px, py, pw * p, 5);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    for (let x = px + 8; x < px + pw; x += 9) ctx.fillRect(x, py, 1, 5);
    txt(ctx, `${Math.round(p * 100)}%`, px + pw + 8, py + 6, 9, C.scan, 'left', 'bold');
  }
  if (t >= 14 && (frame >> 3) % 2 === 0) txt(ctx, '[JUMP] SKIP', VW - 24, top + bh - 22, 11, C.text, 'right', 'bold');
  ctx.restore();
}

export function drawRebuild(ctx, app, p) {
  p = clamp(p);
  const a = p < 0.12 ? p / 0.12 : p > 0.62 ? (1 - p) / 0.38 : 1;
  if (a <= 0) return;
  const def = app.def ?? {};
  const th = themeFor(def.mission ?? app.mission ?? 1);
  const frame = app.frame ?? 0;
  const code = def.matrix ?? '????-????';
  const s1 = `NEW TRAP MATRIX #${code}`;
  const s2 = `ATTEMPT ${app.attempt ?? 1} · PREVIOUS LAYOUT PURGED`;
  ctx.save();
  ctx.globalAlpha = a;
  const w = 470, h = 48, x = VW / 2 - w / 2, y = 96;
  ctx.fillStyle = 'rgba(3,6,12,0.82)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = th.accent;
  ctx.fillRect(x, y, w * clamp(p / 0.5), 2);
  brackets(ctx, x - 4, y - 4, w + 8, h + 8, 10, th.accent, 1.5);
  txt(ctx, scramble(s1, p * 70, frame, 4), x + 16, y + 22, 16, th.accent, 'left', 'bold');
  txt(ctx, s2, x + 16, y + 39, 10, C.dim, 'left', 'bold');
  drawFingerprint(ctx, code, x + w - 64, y + 12, 3, C.warn, rgba(C.warn, 0.25));
  ctx.restore();
}

export function drawToast(ctx, toast) {
  if (!toast || toast.t <= 0) return;
  const a = Math.min(1, toast.t / 20, (150 - Math.min(150, toast.t)) / 8 + 0.15);
  const s = String(toast.text ?? '');
  const w = Math.min(VW - 40, textW(ctx, s, 13, 'bold') + 40);
  const x = VW / 2 - w / 2, y = 444;
  ctx.save();
  ctx.globalAlpha = clamp(a);
  ctx.fillStyle = 'rgba(3,6,12,0.88)';
  ctx.fillRect(x, y, w, 30);
  ctx.fillStyle = C.scan; ctx.fillRect(x, y, 3, 30);
  ctx.strokeStyle = rgba(C.scan, 0.4); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 29);
  txt(ctx, s, VW / 2 + 2, y + 20, 13, C.text, 'center', 'bold');
  ctx.restore();
}

// ===========================================================================
// Taunts
// ===========================================================================
const TAUNTS = {
  spikes: ['The floor had opinions. Pointy ones.', 'Those spikes were not in the brochure.', 'Pinned. Like a butterfly. A slow one.', 'Turns out the floor was also an enemy agent.'],
  fall: ['Gravity is a double agent.', 'The ground was a rumour.', 'That step was classified. So was the floor.', 'You found the basement. The hard way.'],
  crush: ['Flattened into a very thin dossier.', 'Heavy machinery: 1. Agent: 0.', 'You have been pressed for time. And everything else.', 'Pancake protocol: complete.'],
  laser: ['Sliced, not stirred.', 'Lasers don\'t negotiate.', 'Red means stop. It always meant stop.', 'Precision engineering. Applied to you.'],
  detected: ['Smile, you\'re on candid camera.', 'Stealth level: marching band.', 'The camera got your good side. Mission failed.', 'Security has your face now. And your dignity.'],
  mine: ['Watch your step. Too late.', 'That click was not your shoelace.', 'Boom. Classic.', 'Proximity: achieved.'],
  drone: ['The drone sends its regards.', 'Out-flown by a toaster with propellers.', 'Hunter: drone. Hunted: you.', 'It was programmed to love you. Violently.'],
  walls: ['The walls were closing in. Literally.', 'Lockdown means everyone. Especially you.', 'You were outrun by architecture.', 'Should have run faster than a building.'],
  decoy: ['That exit was a painting. A deadly painting.', 'The door was a lie.', 'Rule one: the obvious exit is never the exit.', 'You walked right into the decoy. It was flattered.'],
  generic: [
    'Disavowed. Again.', 'HQ is updating your obituary.', 'The secretary will disavow any knowledge of that.',
    'That was not in the briefing. Nothing ever is.', 'Your cover is blown. So is the rest of you.',
    'Good news: the next layout is different. Bad news: also deadly.', 'Memorize that. It will never happen again.',
    'The trap matrix thanks you for your service.', 'Agent down. Paperwork up.', 'Your mission, should you choose to repeat it...',
  ],
};
let lastTaunt = '';

export function pickTaunt(cause) {
  const own = TAUNTS[cause] ?? [];
  const pool = Math.random() < 0.6 && own.length ? own : [...own, ...TAUNTS.generic];
  let s = lastTaunt;
  for (let i = 0; i < 12 && s === lastTaunt; i++) s = pool[Math.floor(Math.random() * pool.length)];
  if (s === lastTaunt) s = TAUNTS.generic.find(x => x !== lastTaunt);
  lastTaunt = s;
  return s;
}
