// World renderer: camera, particles and the "classified hologram" look.
//
// Presentation only: never mutates simulation state, so it may use
// Math.random freely. No DOM access at import time - every offscreen canvas
// is created lazily (setRun / first draw), so this module loads in Node.
//
// Performance model
//   * Static geometry (tiles, static spikes, pit haze) is painted once into
//     512px-wide chunk canvases at device resolution (lazy, LRU-capped) and
//     blitted at integer device pixels (no seams).
//   * Disguised traps (false floors, ceiling drops) are painted into the chunks
//     exactly like real geometry; when they fire, their cells are cut out of
//     the chunk and a pre-rendered sprite of the very same pixels takes over.
//   * Backdrop layers are pre-rendered strips; glows are cached radial sprites
//     drawn with 'lighter'. No getImageData / shadowBlur in the hot path.

import { TILE } from './physics.js';
import { T_SOLID, SPIKE_DIR, coneTriangle } from './level.js';
import { themeFor, rgba, FONT } from './theme.js';
import { Rng } from './rng.js';
import { SCAN_RADIUS, SCAN_GROW } from './game.js';
import { DRONE_W, DRONE_H, doorRectAt } from './traps.js';

export const VIEW_W = 960, VIEW_H = 544;

const T = TILE, TAU = Math.PI * 2;
const CHUNK_TILES = 16, CHUNK = CHUNK_TILES * T;
const CHUNK_BUDGET = 9e6;          // device pixels of cached chunks (~36 MB)
const MAX_PARTICLES = 600;
const SUIT = '#03050a', GRAV = '#4f8dff', EMPC = '#b04dff', HOT = '#ffd6de';
const SHADES = ['#101c31', '#0b1526', '#08101d', '#050b15'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t * t * (3 - 2 * t);

function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/** Stable per-cell hash -> [0, 1). */
function hash(x, y, s = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Cached sprites (module level, created on first use)
// ---------------------------------------------------------------------------
const glowCache = new Map();
function glow(color) {
  let c = glowCache.get(color);
  if (!c) {
    c = mkCanvas(64, 64);
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, rgba(color, 1));
    gr.addColorStop(0.22, rgba(color, 0.5));
    gr.addColorStop(0.55, rgba(color, 0.12));
    gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    glowCache.set(color, c);
  }
  return c;
}
/** Caller sets the composite (usually 'lighter'). Leaves globalAlpha modified. */
function drawGlow(ctx, color, x, y, r, a, ry = r) {
  if (a <= 0.004) return;
  ctx.globalAlpha = Math.min(1, a);
  ctx.drawImage(glow(color), x - r, y - ry, r * 2, ry * 2);
}

let hatchCanvas = null, noiseCanvas = null;
function hatchSprite() {
  if (!hatchCanvas) {
    hatchCanvas = mkCanvas(8, 8);
    const g = hatchCanvas.getContext('2d');
    g.strokeStyle = 'rgba(255,46,77,0.55)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(-2, 10); g.lineTo(10, -2);
    g.moveTo(-2, 2); g.lineTo(2, -2);
    g.moveTo(6, 10); g.lineTo(10, 6);
    g.stroke();
  }
  return hatchCanvas;
}
function noiseSprite() {
  if (!noiseCanvas) {
    noiseCanvas = mkCanvas(96, 96);
    const g = noiseCanvas.getContext('2d');
    for (let i = 0; i < 520; i++) {
      const r = Math.random();
      g.fillStyle = r < 0.15 ? 'rgba(255,255,255,0.8)' : r < 0.6 ? 'rgba(176,77,255,0.9)' : 'rgba(120,60,255,0.6)';
      g.fillRect((Math.random() * 96) | 0, (Math.random() * 96) | 0, 1 + ((Math.random() * 3) | 0), 1);
    }
  }
  return noiseCanvas;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
function spikePath(ctx, x, y, w, h, dir, scale) {
  const vert = dir === 'up' || dir === 'down';
  const len = vert ? w : h, n = Math.max(1, Math.round(len / 16)), sw = len / n;
  const sh = Math.min(vert ? h : w, 20) * scale;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const b = (vert ? x : y) + i * sw;
    if (dir === 'up') { ctx.moveTo(b + 1, y + h); ctx.lineTo(b + sw / 2, y + h - sh); ctx.lineTo(b + sw - 1, y + h); }
    else if (dir === 'down') { ctx.moveTo(b + 1, y); ctx.lineTo(b + sw / 2, y + sh); ctx.lineTo(b + sw - 1, y); }
    else if (dir === 'left') { ctx.moveTo(x + w, b + 1); ctx.lineTo(x + w - sh, b + sw / 2); ctx.lineTo(x + w, b + sw - 1); }
    else { ctx.moveTo(x, b + 1); ctx.lineTo(x + sh, b + sw / 2); ctx.lineTo(x, b + sw - 1); }
    ctx.closePath();
  }
}

/** Glowing red spike strip. */
function drawSpikes(ctx, x, y, w, h, dir, scale, danger, alpha = 1) {
  if (scale <= 0.02) return;
  const a0 = ctx.globalAlpha;
  spikePath(ctx, x, y, w, h, dir, scale);
  ctx.globalAlpha = a0 * alpha;
  ctx.fillStyle = '#3d0713';
  ctx.fill();
  const op = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = rgba(danger, 0.22);
  ctx.lineWidth = 4.5;
  ctx.stroke();
  ctx.globalCompositeOperation = op;
  ctx.strokeStyle = danger;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.globalAlpha = a0;
}

function arrow(ctx, x1, y1, x2, y2, head = 5) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
  ctx.moveTo(x2 - Math.cos(a - 0.5) * head, y2 - Math.sin(a - 0.5) * head);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x2 - Math.cos(a + 0.5) * head, y2 - Math.sin(a + 0.5) * head);
  ctx.stroke();
}

function lockGlyph(ctx, cx, cy, col) {
  ctx.strokeStyle = col; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(cx, cy - 3, 3.2, Math.PI, 0); ctx.stroke();
  ctx.fillStyle = col; ctx.fillRect(cx - 4.5, cy - 3, 9, 7);
  ctx.fillStyle = '#1a0006'; ctx.fillRect(cx - 0.75, cy - 1.5, 1.5, 3);
}

function hazardStripes(ctx, x, y, w, h, col, step = 12, lw = 5) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.strokeStyle = col; ctx.lineWidth = lw;
  ctx.beginPath();
  for (let k = -h; k < w + h; k += step) { ctx.moveTo(x + k, y + h + 2); ctx.lineTo(x + k + h + 4, y - 2); }
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
export class Camera {
  constructor() { this.x = 0; this.look = 0; this.shake = 0; this.offX = 0; this.offY = 0; }

  range(run) {
    const lw = run.level.width;
    if (lw <= VIEW_W) { const c = (lw - VIEW_W) / 2; return [c, c]; }
    return [0, lw - VIEW_W];
  }

  goal(run) {
    const p = run.player, [lo, hi] = this.range(run);
    return clamp(p.cx + this.look - VIEW_W / 2, lo, hi);
  }

  snap(run) {
    this.look = (run.player?.facing ?? 1) * 48;
    this.x = this.goal(run);
    this.shake = 0; this.offX = this.offY = 0;
  }

  /** One sim tick. */
  update(run) {
    const p = run.player;
    if (run.state === 'playing') {
      const want = Math.abs(p.vx) > 0.8 ? Math.sign(p.vx) * 96 : p.facing * 48;
      this.look += (want - this.look) * 0.03;
      this.x += (this.goal(run) - this.x) * 0.1;
    }
    let ox = 0, oy = 0;
    const fx = run.camFx;
    if (fx && fx.mode === 'shake') {
      const k = fx.t / fx.frames;
      ox += Math.sin(fx.t * 1.9) * fx.amp * (1 - k);
      oy += Math.cos(fx.t * 2.7) * fx.amp * (1 - k);
    }
    if (this.shake > 0.25) {
      this.shake = Math.min(this.shake, 28);
      ox += (Math.random() * 2 - 1) * this.shake;
      oy += (Math.random() * 2 - 1) * this.shake * 0.8;
      this.shake *= 0.86;
    } else this.shake = 0;
    this.offX = ox; this.offY = oy;
  }

  view(run) {
    const [lo, hi] = this.range(run);
    return { x: Math.round(clamp(this.x, lo, hi) + this.offX), y: Math.round(this.offY) };
  }
}

// ---------------------------------------------------------------------------
// Particles (world coordinates). Fixed cap; oldest slots are recycled.
// ---------------------------------------------------------------------------
const P_SQ = 0, P_SPARK = 1, P_EMBER = 2, P_DEBRIS = 3, P_RING = 4, P_SMOKE = 5, P_GLYPH = 6, P_SHARD = 7;
const ADDITIVE = [false, true, true, false, true, false, true, false];
const GLYPHS = '0123456789ABCDEF<>/#{}[]=+';

export class Particles {
  constructor() { this.list = []; this.ov = 0; this.dustColor = '#8ea3c4'; }

  add(k, x, y, vx, vy, life, size, color, g = 0, drag = 0.98) {
    const p = { k, x, y, vx, vy, life, max: life, size, color, g, drag, rot: Math.random() * TAU, vr: 0, r1: 0, lw: 1, ch: '' };
    if (this.list.length < MAX_PARTICLES) this.list.push(p);
    else { this.list[this.ov] = p; this.ov = (this.ov + 1) % MAX_PARTICLES; }
    return p;
  }

  burst(x, y, color, n = 24, speed = 5) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = (0.25 + Math.random() * 0.75) * speed;
      if (i % 3 === 0) this.add(P_SPARK, x, y, Math.cos(a) * s * 1.3, Math.sin(a) * s * 1.3, 12 + Math.random() * 14, 1.4, color, 0.1, 0.92);
      else this.add(P_SQ, x, y, Math.cos(a) * s, Math.sin(a) * s - 1, 22 + Math.random() * 22, 2 + Math.random() * 3, color, 0.16, 0.95);
    }
  }

  dust(x, y, n = 6, color = this.dustColor, dir = 1) {
    for (let i = 0; i < n; i++) {
      this.add(P_SMOKE, x + (Math.random() - 0.5) * 16, y - dir * 2, (Math.random() - 0.5) * 1.8, -Math.random() * 0.9 * dir,
        16 + Math.random() * 14, 2 + Math.random() * 2.5, color, 0.015 * dir, 0.93);
    }
  }

  sparks(x, y, color, n = 8, speed = 4, ang = -Math.PI / 2, spread = Math.PI) {
    for (let i = 0; i < n; i++) {
      const a = ang + (Math.random() - 0.5) * spread, s = (0.35 + Math.random() * 0.65) * speed;
      this.add(P_SPARK, x, y, Math.cos(a) * s, Math.sin(a) * s, 8 + Math.random() * 14, 1 + Math.random() * 0.8, color, 0.22, 0.95);
    }
  }

  embers(x, y, color, n = 8, spread = 10) {
    for (let i = 0; i < n; i++) {
      this.add(P_EMBER, x + (Math.random() - 0.5) * spread, y + (Math.random() - 0.5) * spread * 0.5,
        (Math.random() - 0.5) * 1.2, -0.3 - Math.random() * 1.4, 30 + Math.random() * 40, 1 + Math.random() * 1.6, color, -0.01, 0.98);
    }
  }

  debris(x, y, color, n = 10, speed = 5) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6, s = (0.3 + Math.random() * 0.7) * speed;
      const p = this.add(P_DEBRIS, x + (Math.random() - 0.5) * 8, y, Math.cos(a) * s, Math.sin(a) * s, 30 + Math.random() * 30, 2 + Math.random() * 4, color, 0.32, 0.985);
      p.vr = (Math.random() - 0.5) * 0.5;
    }
  }

  shards(x, y, colors, n = 18, speed = 6) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = (0.3 + Math.random() * 0.7) * speed;
      const p = this.add(P_SHARD, x + (Math.random() - 0.5) * 12, y + (Math.random() - 0.5) * 18, Math.cos(a) * s, Math.sin(a) * s - 2,
        34 + Math.random() * 30, 3 + Math.random() * 5, colors[i % colors.length], 0.25, 0.975);
      p.vr = (Math.random() - 0.5) * 0.6;
    }
  }

  ring(x, y, color, r0 = 4, r1 = 40, life = 22, lw = 2) {
    const p = this.add(P_RING, x, y, 0, 0, life, r0, color, 0, 1);
    p.r1 = r1; p.lw = lw;
    return p;
  }

  smoke(x, y, n = 6, color = '#1b2232') {
    for (let i = 0; i < n; i++) {
      this.add(P_SMOKE, x + (Math.random() - 0.5) * 20, y + (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 1.6, -0.4 - Math.random() * 1.2,
        40 + Math.random() * 30, 5 + Math.random() * 6, color, -0.005, 0.97);
    }
  }

  glyphs(x, y, color, n = 4, spread = 10) {
    for (let i = 0; i < n; i++) {
      const p = this.add(P_GLYPH, x + (Math.random() - 0.5) * spread, y + (Math.random() - 0.5) * spread,
        (Math.random() - 0.5) * 1.2, -0.2 - Math.random() * 0.8, 18 + Math.random() * 20, 8, color, 0, 0.96);
      p.ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }
  }

  update() {
    const L = this.list;
    let j = 0;
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      if (--p.life <= 0) continue;
      p.vx *= p.drag; p.vy *= p.drag; p.vy += p.g;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      L[j++] = p;
    }
    L.length = j;
    if (this.ov >= j) this.ov = 0;
  }

  draw(ctx) {
    const L = this.list;
    if (!L.length) return;
    ctx.save();
    for (let pass = 0; pass < 2; pass++) {
      ctx.globalCompositeOperation = pass ? 'lighter' : 'source-over';
      if (pass) { ctx.font = `bold 8px ${FONT}`; ctx.textAlign = 'center'; }
      for (let i = 0; i < L.length; i++) {
        const p = L[i];
        if (ADDITIVE[p.k] !== (pass === 1)) continue;
        const f = p.life / p.max;
        switch (p.k) {
          case P_SQ: {
            ctx.globalAlpha = Math.min(1, f * 1.6);
            ctx.fillStyle = p.color;
            const s = p.size * (0.4 + 0.6 * f);
            ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
            break;
          }
          case P_SPARK:
            ctx.globalAlpha = Math.min(1, f * 1.4);
            ctx.strokeStyle = p.color; ctx.lineWidth = p.size;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2); ctx.stroke();
            break;
          case P_EMBER: {
            const fl = 0.6 + 0.4 * Math.sin(p.life * 0.7 + p.rot * 5);
            drawGlow(ctx, p.color, p.x, p.y, 3 + p.size * 2, f * 0.45 * fl);
            ctx.globalAlpha = f * fl;
            ctx.fillStyle = p.color;
            ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
            break;
          }
          case P_DEBRIS: case P_SHARD: {
            ctx.globalAlpha = Math.min(1, f * 2);
            ctx.fillStyle = p.color;
            const c = Math.cos(p.rot), s = Math.sin(p.rot), r = p.size * 0.5;
            ctx.beginPath();
            if (p.k === P_DEBRIS) {
              const hx = r, hy = r * 0.6;
              ctx.moveTo(p.x + c * hx - s * hy, p.y + s * hx + c * hy);
              ctx.lineTo(p.x - c * hx - s * hy, p.y - s * hx + c * hy);
              ctx.lineTo(p.x - c * hx + s * hy, p.y - s * hx - c * hy);
              ctx.lineTo(p.x + c * hx + s * hy, p.y + s * hx - c * hy);
            } else {
              ctx.moveTo(p.x + c * r * 1.3, p.y + s * r * 1.3);
              ctx.lineTo(p.x - c * r * 0.7 - s * r * 0.6, p.y - s * r * 0.7 + c * r * 0.6);
              ctx.lineTo(p.x - c * r * 0.5 + s * r * 0.7, p.y - s * r * 0.5 - c * r * 0.7);
            }
            ctx.closePath();
            ctx.fill();
            break;
          }
          case P_RING: {
            const k = 1 - f, e = 1 - (1 - k) * (1 - k);
            ctx.globalAlpha = f;
            ctx.strokeStyle = p.color; ctx.lineWidth = p.lw * (0.4 + f);
            ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.1, lerp(p.size, p.r1, e)), 0, TAU); ctx.stroke();
            break;
          }
          case P_SMOKE: {
            ctx.globalAlpha = f * 0.4;
            ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + (1 - f) * 1.4), 0, TAU); ctx.fill();
            break;
          }
          case P_GLYPH:
            ctx.globalAlpha = f * (Math.random() < 0.15 ? 0.3 : 1);
            ctx.fillStyle = p.color;
            ctx.fillText(p.ch, p.x, p.y);
            break;
        }
      }
    }
    ctx.restore();
  }

  clear() { this.list.length = 0; this.ov = 0; }
}

// ---------------------------------------------------------------------------
// Visual grid: solid tiles + disguised trap cells (false floors fake solid
// ground all the way down; ceiling drops look like ceiling).
// vis: 0 empty, 1 solid tile, 2 disguise cell.
// ---------------------------------------------------------------------------
function buildVis(run) {
  const { cols, rows, grid } = run.level;
  const vis = new Uint8Array(cols * rows);
  for (let i = 0; i < vis.length; i++) vis[i] = grid[i] === T_SOLID ? 1 : 0;
  const regions = new Map();
  for (const t of run.traps) {
    if (t.type !== 'crumble' && t.type !== 'drop') continue;
    const r = t.rect;
    const x0 = Math.max(0, Math.floor(r.x / T + 1e-6)), x1 = Math.min(cols - 1, Math.ceil((r.x + r.w) / T - 1e-6) - 1);
    const y0 = Math.max(0, Math.floor(r.y / T + 1e-6)), y1 = Math.min(rows - 1, Math.ceil((r.y + r.h) / T - 1e-6) - 1);
    if (x1 < x0 || y1 < y0) continue;
    const cells = new Set();
    let yMax = y1;
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) cells.add(ty * cols + tx);
      if (t.type === 'crumble') {
        for (let ty = y1 + 1; ty < rows; ty++) {
          const g = grid[ty * cols + tx];
          if (g === T_SOLID || SPIKE_DIR[g]) break;
          cells.add(ty * cols + tx);
          if (ty > yMax) yMax = ty;
        }
      }
    }
    for (const i of cells) if (grid[i] !== T_SOLID && !SPIKE_DIR[grid[i]]) vis[i] = 2;
    regions.set(t.id, { t, x0, x1, y0, y1, yMax, cells, box: null, sprite: null });
  }
  return { vis, regions };
}

const TRAP_LABEL_FALLBACK = { runDoor: 'RUNAWAY EXIT' };

// ---------------------------------------------------------------------------
// World renderer
// ---------------------------------------------------------------------------
export class WorldRenderer {
  constructor() {
    this.run = null;
    this.th = themeFor(1);
    this.scale = 0;
    this.chunks = [];
    this.chunkCount = 0;
    this.now = 0;
    this.lastTick = -1;
    this.lastRunFrame = -1;
    this.labelW = new Map();
    this.pat = null;          // { ctx, hatch, noise }
    this.thumb = null;
    this.prevBottom = new Map();
  }

  // ------------------------------------------------------------------ setup
  setRun(run) {
    this.run = run;
    const def = run.def;
    this.th = themeFor(def.mission ?? 1);
    this.seed = (def.seed ?? 1) >>> 0;
    this.cols = run.level.cols; this.rows = run.level.rows; this.grid = run.level.grid;
    const { vis, regions } = buildVis(run);
    this.vis = vis; this.regions = regions;
    for (const reg of regions.values()) reg.box = this.regionBox(reg);
    this.spikeCells = [];
    for (let ty = 0; ty < this.rows; ty++) for (let tx = 0; tx < this.cols; tx++) {
      const dir = SPIKE_DIR[this.grid[ty * this.cols + tx]];
      if (dir) this.spikeCells.push({ tx, ty, dir, ph: hash(tx, ty, 7) * TAU });
    }
    this.scale = 0;
    this.chunks = [];
    this.chunkCount = 0;
    this.cutIds = new Set();
    this.trail = [];
    this.tagSeen = new Map();
    this.decals = [];
    this.prevBottom = new Map();
    this.alarmAt = -1e9; this.flashAt = -1e9; this.flashCol = '#ffffff'; this.flashA = 0;
    this.winAt = -1;
    this.pose = { phase: 0, squash: 0 };
    this.lastRunFrame = -1;
    this.spawn = run.parsed.spawns[0];
    this.buildBackdrop();
    this.buildSigns();
  }

  visAt(tx, ty) {
    if (ty < 0 || ty >= this.rows || tx < 0 || tx >= this.cols) return 1;
    return this.vis[ty * this.cols + tx];
  }

  regionBox(reg) {
    const P = 12;
    const x = reg.x0 * T, y = reg.y0 * T, w = (reg.x1 - reg.x0 + 1) * T, h = (reg.yMax - reg.y0 + 1) * T;
    const mx = (reg.x0 + reg.x1) >> 1, my = (reg.y0 + reg.yMax) >> 1;
    const pl = this.visAt(reg.x0 - 1, my) ? 0 : P, pr = this.visAt(reg.x1 + 1, my) ? 0 : P;
    const pt = this.visAt(mx, reg.y0 - 1) ? 0 : P, pb = this.visAt(mx, reg.yMax + 1) ? 0 : P;
    return { x: x - pl, y: y - pt, w: w + pl + pr, h: h + pt + pb, pt };
  }

  ensureScale(dev) {
    let s = clamp(dev, 1, 2);
    s = Math.max(0.5, Math.round(s * 4) / 4);
    if (s === this.scale) return;
    this.scale = s;
    this.chunks = new Array(Math.ceil(this.cols * T / CHUNK)).fill(null);
    this.chunkCount = 0;
    for (const reg of this.regions.values()) reg.sprite = null;
  }

  patterns(ctx) {
    if (!this.pat || this.pat.ctx !== ctx) {
      this.pat = {
        ctx,
        hatch: ctx.createPattern(hatchSprite(), 'repeat'),
        noise: ctx.createPattern(noiseSprite(), 'repeat'),
      };
    }
    return this.pat;
  }

  // ------------------------------------------------------------------ static geometry painting
  /** Paint tiles [tx0..tx1] x [ty0..ty1] accepted by inc() into g (world coords). */
  paintCells(g, tx0, tx1, ty0, ty1, inc, chunk) {
    const th = this.th, s = this.scale;
    const V = (x, y) => this.visAt(x, y) > 0;
    const cells = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (inc(tx, ty)) cells.push(tx, ty);

    // 1. fills with stepped depth shading (deeper = darker)
    for (let i = 0; i < cells.length; i += 2) {
      const tx = cells[i], ty = cells[i + 1];
      let d = 0;
      while (d < 3 && V(tx, ty - d - 1) && V(tx, ty + d + 1) && V(tx - d - 1, ty) && V(tx + d + 1, ty)) d++;
      g.fillStyle = SHADES[d];
      g.fillRect(tx * T, ty * T, T, T);
    }

    if (cells.length) {
      // 2. blueprint grid + details, clipped to the solid cells
      g.save();
      g.beginPath();
      for (let i = 0; i < cells.length; i += 2) g.rect(cells[i] * T, cells[i + 1] * T, T, T);
      g.clip();
      const X0 = tx0 * T, X1 = (tx1 + 1) * T, Y0 = ty0 * T, Y1 = (ty1 + 1) * T;
      g.lineWidth = 1 / s;
      g.strokeStyle = rgba(th.accent, 0.045);
      g.beginPath();
      for (let x = X0; x <= X1; x += 8) { g.moveTo(x, Y0); g.lineTo(x, Y1); }
      for (let y = Y0; y <= Y1; y += 8) { g.moveTo(X0, y); g.lineTo(X1, y); }
      g.stroke();
      g.strokeStyle = rgba(th.accent, 0.085);
      g.beginPath();
      for (let x = X0; x <= X1; x += T) { g.moveTo(x, Y0); g.lineTo(x, Y1); }
      for (let y = Y0; y <= Y1; y += T) { g.moveTo(X0, y); g.lineTo(X1, y); }
      g.stroke();
      for (let i = 0; i < cells.length; i += 2) this.cellDetail(g, cells[i], cells[i + 1], !V(cells[i], cells[i + 1] - 1));

      // inner rim light along exposed faces
      const grads = new Map();
      const grad = (key, x0, y0, x1, y1, col, a) => {
        let gr = grads.get(key);
        if (!gr) {
          gr = g.createLinearGradient(x0, y0, x1, y1);
          gr.addColorStop(0, rgba(col, a)); gr.addColorStop(1, rgba(col, 0));
          grads.set(key, gr);
        }
        return gr;
      };
      for (let i = 0; i < cells.length; i += 2) {
        const tx = cells[i], ty = cells[i + 1], x = tx * T, y = ty * T;
        if (!V(tx, ty - 1)) { g.fillStyle = grad('t' + ty, 0, y, 0, y + 14, th.accent, 0.16); g.fillRect(x, y, T, 14); }
        if (!V(tx, ty + 1)) { g.fillStyle = grad('b' + ty, 0, y + T, 0, y + T - 10, th.accent2, 0.12); g.fillRect(x, y + T - 10, T, 10); }
        if (!V(tx - 1, ty)) { g.fillStyle = grad('l' + tx, x, 0, x + 9, 0, th.accent, 0.09); g.fillRect(x, y, 9, T); }
        if (!V(tx + 1, ty)) { g.fillStyle = grad('r' + tx, x + T, 0, x + T - 9, 0, th.accent, 0.09); g.fillRect(x + T - 9, y, 9, T); }
      }
      g.restore();

      // 3. neon edges on exposed faces (top brightest)
      const top = [], bot = [], left = [], right = [];
      const has = (tx, ty) => tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1 && inc(tx, ty);
      for (let ty = ty0; ty <= ty1; ty++) {
        let a = -1, b = -1;
        for (let tx = tx0; tx <= tx1 + 1; tx++) {
          const et = has(tx, ty) && !V(tx, ty - 1), eb = has(tx, ty) && !V(tx, ty + 1);
          if (et && a < 0) a = tx;
          if (!et && a >= 0) { top.push(a, tx, ty); a = -1; }
          if (eb && b < 0) b = tx;
          if (!eb && b >= 0) { bot.push(b, tx, ty); b = -1; }
        }
      }
      for (let tx = tx0; tx <= tx1; tx++) {
        let a = -1, b = -1;
        for (let ty = ty0; ty <= ty1 + 1; ty++) {
          const el = has(tx, ty) && !V(tx - 1, ty), er = has(tx, ty) && !V(tx + 1, ty);
          if (el && a < 0) a = ty;
          if (!el && a >= 0) { left.push(a, ty, tx); a = -1; }
          if (er && b < 0) b = ty;
          if (!er && b >= 0) { right.push(b, ty, tx); b = -1; }
        }
      }
      const pathH = (segs, dy) => { g.beginPath(); for (let i = 0; i < segs.length; i += 3) { const y = segs[i + 2] * T + dy; g.moveTo(segs[i] * T, y); g.lineTo(segs[i + 1] * T, y); } };
      // glow = wide faint strokes under a thin bright one (no shadowBlur: chunks are painted during play)
      g.save();
      g.lineCap = 'butt';
      pathH(bot, T - 0.6);
      g.strokeStyle = rgba(th.accent2, 0.08); g.lineWidth = 5; g.stroke();
      g.strokeStyle = rgba(th.accent2, 0.5); g.lineWidth = 1.2; g.stroke();
      g.beginPath();
      for (let i = 0; i < left.length; i += 3) { const x = left[i + 2] * T + 0.6; g.moveTo(x, left[i] * T); g.lineTo(x, left[i + 1] * T); }
      for (let i = 0; i < right.length; i += 3) { const x = right[i + 2] * T + T - 0.6; g.moveTo(x, right[i] * T); g.lineTo(x, right[i + 1] * T); }
      g.strokeStyle = rgba(th.accent, 0.09); g.lineWidth = 5; g.stroke();
      g.strokeStyle = rgba(th.accent, 0.5); g.lineWidth = 1.2; g.stroke();
      pathH(top, 1);
      g.strokeStyle = rgba(th.accent, 0.07); g.lineWidth = 10; g.stroke();
      g.strokeStyle = rgba(th.accent, 0.16); g.lineWidth = 5; g.stroke();
      g.strokeStyle = rgba(th.accent, 0.95); g.lineWidth = 2; g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 0.7;
      g.stroke();
      // ruler ticks + corner nodes along the walkable surfaces
      g.strokeStyle = rgba(th.accent, 0.3); g.lineWidth = 1 / s;
      g.beginPath();
      for (let i = 0; i < top.length; i += 3) {
        const y = top[i + 2] * T + 2;
        for (let x = top[i] * T + 8; x < top[i + 1] * T; x += 8) { g.moveTo(x, y); g.lineTo(x, y + ((x & 31) === 0 ? 4 : 2)); }
      }
      g.stroke();
      g.fillStyle = th.accent;
      for (let i = 0; i < top.length; i += 3) {
        const y = top[i + 2] * T;
        if (!V(top[i] - 1, top[i + 2])) g.fillRect(top[i] * T - 0.5, y - 0.5, 3, 3);
        if (!V(top[i + 1], top[i + 2])) g.fillRect(top[i + 1] * T - 2.5, y - 0.5, 3, 3);
      }
      g.restore();
    }

    if (!chunk) return;
    // 4. static spike tiles
    for (const sc of this.spikeCells) {
      if (sc.tx < tx0 || sc.tx > tx1) continue;
      const x = sc.tx * T, y = sc.ty * T;
      g.fillStyle = '#0a0d14';
      if (sc.dir === 'up') g.fillRect(x, y + T - 3, T, 3);
      else if (sc.dir === 'down') g.fillRect(x, y, T, 3);
      else if (sc.dir === 'left') g.fillRect(x + T - 3, y, 3, T);
      else g.fillRect(x, y, 3, T);
      drawSpikes(g, x, y, T, T, sc.dir, 1, th.danger);
    }
    // 5. pit haze: a red kill-plane glow at the bottom of bottomless columns
    const H = this.rows * T;
    const hz = g.createLinearGradient(0, H - 90, 0, H);
    hz.addColorStop(0, rgba(th.danger, 0)); hz.addColorStop(1, rgba(th.danger, 0.16));
    g.fillStyle = hz;
    g.beginPath();
    let anyPit = false;
    for (let tx = Math.max(0, tx0); tx <= Math.min(this.cols - 1, tx1); tx++) {
      if (this.visAt(tx, this.rows - 1) === 0) { g.rect(tx * T, H - 90, T, 90); anyPit = true; }
    }
    if (anyPit) {
      g.fill();
      g.strokeStyle = rgba(th.danger, 0.45); g.lineWidth = 1;
      g.setLineDash([3, 5]);
      g.beginPath();
      for (let tx = Math.max(0, tx0); tx <= Math.min(this.cols - 1, tx1); tx++) {
        if (this.visAt(tx, this.rows - 1) === 0) { g.moveTo(tx * T, H - 1.5); g.lineTo(tx * T + T, H - 1.5); }
      }
      g.stroke();
      g.setLineDash([]);
    }
  }

  cellDetail(g, tx, ty, surface) {
    const th = this.th, h = hash(tx, ty, this.seed), x = tx * T, y = ty * T;
    if (h < 0.08) {
      g.fillStyle = rgba(th.accent, 0.2);
      g.fillRect(x + 3, y + 3, 1.5, 1.5); g.fillRect(x + T - 4.5, y + 3, 1.5, 1.5);
      g.fillRect(x + 3, y + T - 4.5, 1.5, 1.5); g.fillRect(x + T - 4.5, y + T - 4.5, 1.5, 1.5);
    } else if (h < 0.14) {
      g.strokeStyle = rgba(th.accent, 0.13); g.lineWidth = 0.75;
      g.strokeRect(x + 4.5, y + (surface ? 7.5 : 4.5), T - 9, T - (surface ? 12 : 9));
    } else if (h < 0.18) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      for (let i = 0; i < 3; i++) g.fillRect(x + 8, y + 10 + i * 5, T - 16, 2);
      g.fillStyle = rgba(th.accent, 0.08);
      for (let i = 0; i < 3; i++) g.fillRect(x + 8, y + 12 + i * 5, T - 16, 0.6);
    } else if (h < 0.205) {
      g.fillStyle = rgba(th.accent, 0.28);
      g.font = `5px ${FONT}`;
      g.fillText(`${'ABCDEFGHKMNPRSTX'[(h * 1e4) & 15]}-${((h * 1e6) | 0) % 90 + 10}`, x + 4, y + T - 5);
    } else if (h < 0.245) {
      g.strokeStyle = rgba(th.accent, 0.16); g.lineWidth = 0.75;
      const yy = y + 8 + ((h * 1e5) | 0) % 16;
      g.beginPath(); g.moveTo(x, yy); g.lineTo(x + 12, yy); g.lineTo(x + 18, yy + 6); g.lineTo(x + T, yy + 6); g.stroke();
      g.fillStyle = rgba(th.accent, 0.35); g.fillRect(x + 11, yy - 1, 2, 2);
    } else if (h < 0.26 && surface) {
      g.fillStyle = rgba(th.accent2, 0.45);
      g.fillRect(x + T - 7, y + 6, 2, 2);
    }
  }

  buildChunk(ci) {
    const s = this.scale, x0 = ci * CHUNK;
    const c = mkCanvas(CHUNK * s, this.rows * T * s);
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, -x0 * s, 0);
    const tx0 = ci * CHUNK_TILES - 1, tx1 = tx0 + CHUNK_TILES + 1;
    const cols = this.cols;
    this.paintCells(g, tx0, tx1, 0, this.rows - 1, (tx, ty) => tx >= 0 && tx < cols && this.visAt(tx, ty) > 0, true);
    for (const id of this.cutIds) { const b = this.regions.get(id).box; g.clearRect(b.x, b.y, b.w, b.h); }
    this.chunkCount++;
    return c;
  }

  sprite(reg) {
    if (!reg.sprite) {
      const b = reg.box, s = this.scale;
      const c = mkCanvas(b.w * s, b.h * s), g = c.getContext('2d');
      g.setTransform(s, 0, 0, s, -b.x * s, -b.y * s);
      const cols = this.cols;
      this.paintCells(g, reg.x0, reg.x1, reg.y0, reg.yMax, (tx, ty) => reg.cells.has(ty * cols + tx), false);
      reg.sprite = c;
    }
    return reg.sprite;
  }

  /** Disguised trap fired: remove its pixels from the static chunks (sprite takes over). */
  applyCuts(run) {
    for (const reg of this.regions.values()) {
      if (reg.t.state === 'idle' || this.cutIds.has(reg.t.id)) continue;
      this.sprite(reg);
      this.cutIds.add(reg.t.id);
      const b = reg.box;
      const c0 = Math.max(0, Math.floor(b.x / CHUNK)), c1 = Math.min(this.chunks.length - 1, Math.floor((b.x + b.w) / CHUNK));
      for (let ci = c0; ci <= c1; ci++) {
        const c = this.chunks[ci];
        if (!c) continue;
        const g = c.getContext('2d');
        g.setTransform(this.scale, 0, 0, this.scale, -ci * CHUNK * this.scale, 0);
        g.clearRect(b.x, b.y, b.w, b.h);
      }
    }
  }

  /** Blit visible chunks at integer device pixels (seam-free). */
  drawChunks(ctx, view, dev, clipA, clipB, alpha = 1, comp = 'source-over') {
    const n = this.chunks.length;
    if (!n) return;
    const c0 = Math.max(0, Math.floor(view.x / CHUNK)), c1 = Math.min(n - 1, Math.floor((view.x + VIEW_W) / CHUNK));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = comp;
    if (clipA !== undefined) {
      ctx.beginPath();
      ctx.rect(Math.round(clipA * dev), 0, Math.max(0, Math.round((clipB - clipA) * dev)), ctx.canvas.height);
      ctx.clip();
    }
    const dy0 = Math.round(-view.y * dev), dy1 = Math.round((this.rows * T - view.y) * dev);
    for (let ci = c0; ci <= c1; ci++) {
      if (!this.chunks[ci]) this.chunks[ci] = this.buildChunk(ci);
      const dx0 = Math.round((ci * CHUNK - view.x) * dev), dx1 = Math.round(((ci + 1) * CHUNK - view.x) * dev);
      ctx.drawImage(this.chunks[ci], dx0, dy0, dx1 - dx0, dy1 - dy0);
    }
    ctx.restore();
    if (clipA === undefined) this.manageChunks(c0, c1, view);
  }

  /** Prefetch one chunk ahead per frame; evict far chunks over the memory budget. */
  manageChunks(c0, c1, view) {
    const ahead = this.run.player.vx < -0.5 ? c0 - 1 : c1 + 1;
    if (ahead >= 0 && ahead < this.chunks.length && !this.chunks[ahead]) this.chunks[ahead] = this.buildChunk(ahead);
    const per = CHUNK * this.scale * this.rows * T * this.scale;
    if (this.chunkCount * per <= CHUNK_BUDGET) return;
    const mid = (view.x + VIEW_W / 2) / CHUNK;
    let far = -1, fd = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (!this.chunks[i] || (i >= c0 - 1 && i <= c1 + 1)) continue;
      const d = Math.abs(i + 0.5 - mid);
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) { this.chunks[far].width = 1; this.chunks[far] = null; this.chunkCount--; }
  }

  // ------------------------------------------------------------------ backdrop
  buildBackdrop() {
    const th = this.th, rng = new Rng((this.seed ^ 0x9e3779b9) >>> 0);
    const bd = this.bd = { layers: [], motes: [], shafts: [] };

    // Layers are horizontally tileable strips. Vertical-only gradients (sky,
    // fog) and the hex lattice are baked into them: fewer full-screen blits.
    let gr;

    // hex lattice (baked into the near layer; also used inside the scanner pulse)
    const hex = bd.hex = mkCanvas(VIEW_W + 48, 680), gh = hex.getContext('2d');
    {
      const r = 16, hh = Math.sqrt(3) * r;
      gh.strokeStyle = th.accent; gh.lineWidth = 1;
      gh.beginPath();
      for (let i = 0; i * 24 <= VIEW_W + 72; i++) {
        for (let j = -1; j * hh <= 680 + hh; j++) {
          const cx = i * 24, cy = j * hh + (i & 1 ? hh / 2 : 0), rr = r - 1.5;
          gh.moveTo(cx + rr, cy);
          for (let k = 1; k <= 6; k++) gh.lineTo(cx + Math.cos(k * Math.PI / 3) * rr, cy + Math.sin(k * Math.PI / 3) * rr);
        }
      }
      gh.stroke();
    }

    // skyline layers
    const building = (g, x, w, h, st, lights) => {
      const y = VIEW_H - h;
      g.fillStyle = st.fill; g.fillRect(x, y, w, h);
      let topY = y;
      if (rng.chance(0.45)) {
        const cw = Math.max(6, Math.round(w * rng.float(0.35, 0.7))), ch = rng.int(8, 36), cx = x + rng.int(0, w - cw);
        g.fillRect(cx, y - ch, cw, ch);
        g.fillStyle = rgba(th.accent, st.rim); g.fillRect(cx, y - ch, cw, 1);
        topY = y - ch;
        if (rng.chance(0.4)) { g.fillStyle = rgba(th.accent, st.rim * 2); g.fillRect(cx + cw / 2 - 0.5, y - ch, 1, ch); }
      }
      if (rng.chance(st.antenna)) {
        const ax = x + rng.int(2, Math.max(2, w - 3)), ah = rng.int(12, 46);
        g.fillStyle = st.fill; g.fillRect(ax, topY - ah, 1.5, ah);
        lights.push({ x: ax - 0.5, y: topY - ah - 2, w: 2.5, h: 2.5, col: th.danger, per: rng.int(70, 150), on: 12, ph: rng.int(0, 300), glow: 1 });
      }
      g.fillStyle = rgba(th.accent, st.rim); g.fillRect(x, y, w, 1);
      g.fillStyle = rgba(th.accent, st.rim * 0.6); g.fillRect(x, y, 1, h);
      if (rng.chance(0.25)) { g.fillStyle = rgba(th.accent2, st.rim * 1.5); g.fillRect(x + w - 2, y + 4, 1, h - 4); }
      const [cw, ch, gx, gy] = st.win;
      for (let wy = y + 6; wy < VIEW_H - 4; wy += ch + gy) {
        for (let wx = x + 3; wx < x + w - cw - 2; wx += cw + gx) {
          const r = rng.next();
          if (r < st.lit) {
            g.fillStyle = rng.chance(0.65) ? rgba(th.accent, rng.float(0.12, 0.38)) : rgba('#ffd9a0', rng.float(0.1, 0.3));
            g.fillRect(wx, wy, cw, ch);
          } else if (r < st.lit + st.live) {
            lights.push({ x: wx, y: wy, w: cw, h: ch, col: rng.chance(0.6) ? th.accent : '#ffd9a0', per: rng.int(160, 520), on: rng.int(60, 300), ph: rng.int(0, 500), glow: 0 });
          }
        }
      }
      if (st.billboard && rng.chance(st.billboard) && w > 50) {
        const bw = rng.int(26, Math.min(70, w - 12)), bh = rng.int(14, 26), bx = x + rng.int(4, w - bw - 4), by = y + rng.int(16, Math.max(17, h * 0.4));
        g.fillStyle = rgba(th.accent2, 0.1); g.fillRect(bx, by, bw, bh);
        g.strokeStyle = rgba(th.accent2, 0.35); g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        g.fillStyle = rgba(th.accent, 0.3);
        for (let i = 0; i < 3; i++) g.fillRect(bx + 4, by + 4 + i * 4, rng.int(6, bw - 8), 1.5);
      }
    };
    const skyline = (W, st, wRange, hRange) => {
      const c = mkCanvas(W + 220, VIEW_H), g2 = c.getContext('2d'), lights = [];
      let x = rng.int(0, 20);
      while (x < W) {
        const w = rng.int(wRange[0], wRange[1]);
        building(g2, x, w, rng.int(hRange[0], hRange[1]), st, lights);
        x += w + rng.int(0, 12);
      }
      g2.drawImage(c, W, 0, 220, VIEW_H, 0, 0, 220, VIEW_H);   // wrap the overflow
      for (const l of lights) if (l.x >= W) l.x -= W;
      return { c, g: g2, lights };
    };

    // far: opaque sky (gradient, aurora band, stars) + distant skyline
    {
      const W = 1700, far = skyline(W, { fill: '#0a1526', rim: 0.1, antenna: 0.25, win: [2, 3, 4, 5], lit: 0.07, live: 0.008 }, [24, 80], [120, 330]);
      const c = mkCanvas(W, VIEW_H), g = c.getContext('2d');
      gr = g.createLinearGradient(0, 0, 0, VIEW_H);
      gr.addColorStop(0, th.bg0); gr.addColorStop(0.45, th.bg1); gr.addColorStop(1, th.bg2);
      g.fillStyle = gr; g.fillRect(0, 0, W, VIEW_H);
      gr = g.createLinearGradient(0, VIEW_H * 0.3, 0, VIEW_H);
      gr.addColorStop(0, rgba(th.accent2, 0)); gr.addColorStop(1, rgba(th.accent2, 0.2));
      g.fillStyle = gr; g.fillRect(0, 0, W, VIEW_H);
      gr = g.createLinearGradient(0, 40, 0, 220);
      gr.addColorStop(0, rgba(th.accent, 0)); gr.addColorStop(0.5, rgba(th.accent, 0.05)); gr.addColorStop(1, rgba(th.accent, 0));
      g.fillStyle = gr; g.fillRect(0, 40, W, 180);
      for (let i = 0; i < 190; i++) {
        g.fillStyle = rgba('#cfe3ff', rng.float(0.08, 0.5));
        const s = rng.chance(0.1) ? 1.5 : 1;
        g.fillRect(rng.float(0, W - 2), rng.float(0, VIEW_H * 0.55), s, s);
      }
      g.drawImage(far.c, 0, 0, W, VIEW_H, 0, 0, W, VIEW_H);
      far.c.width = 1;
      bd.layers.push({ c, w: W, par: 0.08, lights: far.lights });
    }

    // mid skyline with the city haze baked over it
    {
      const W = 2000, mid = skyline(W, { fill: '#060d19', rim: 0.2, antenna: 0.35, win: [3, 4, 6, 7], lit: 0.05, live: 0.006, billboard: 0.35 }, [50, 140], [190, 430]);
      gr = mid.g.createLinearGradient(0, 0, 0, VIEW_H);
      gr.addColorStop(0, rgba(th.accent2, 0)); gr.addColorStop(0.55, rgba(th.accent2, 0.03)); gr.addColorStop(1, rgba(th.accent2, 0.12));
      mid.g.fillStyle = gr; mid.g.fillRect(0, 0, W + 220, VIEW_H);
      bd.layers.push({ c: mid.c, w: W, par: 0.2, lights: mid.lights });
    }

    // near structures: girders, server racks, catwalks, cables (+ hex lattice)
    {
      const W = 1632, c = mkCanvas(W + 220, VIEW_H), g2 = c.getContext('2d'), lights = [];   // W = 34 hex periods
      const ink = '#04080f', rim = rgba(th.accent, 0.07);
      const cy = rng.int(70, 130);
      g2.fillStyle = ink; g2.fillRect(0, cy, W + 220, 5);
      g2.fillStyle = rim; g2.fillRect(0, cy, W + 220, 1);
      g2.strokeStyle = ink; g2.lineWidth = 1.2; g2.beginPath();
      g2.moveTo(0, cy - 12); g2.lineTo(W + 220, cy - 12);
      for (let x = 0; x < W + 220; x += 14) { g2.moveTo(x, cy - 12); g2.lineTo(x, cy); }
      g2.stroke();
      let x = rng.int(0, 60);
      while (x < W) {
        const kind = rng.pick(['girder', 'girder', 'rack', 'pipe', 'rack']);
        if (kind === 'girder') {
          const w = rng.int(14, 24);
          g2.fillStyle = ink; g2.fillRect(x, 0, 3, VIEW_H); g2.fillRect(x + w - 3, 0, 3, VIEW_H);
          g2.strokeStyle = ink; g2.lineWidth = 1.6; g2.beginPath();
          for (let y = 0; y < VIEW_H; y += 36) { g2.moveTo(x, y); g2.lineTo(x + w, y + 36); g2.moveTo(x + w, y); g2.lineTo(x, y + 36); }
          g2.stroke();
          g2.fillStyle = rim; g2.fillRect(x, 0, 1, VIEW_H);
          x += w + rng.int(70, 200);
        } else if (kind === 'rack') {
          const w = rng.int(34, 54), h = rng.int(130, 260), y = VIEW_H - h;
          g2.fillStyle = '#03070d'; g2.fillRect(x, y, w, h);
          g2.fillStyle = rim; g2.fillRect(x, y, w, 1); g2.fillRect(x, y, 1, h);
          g2.fillStyle = 'rgba(255,255,255,0.025)';
          for (let yy = y + 6; yy < VIEW_H; yy += 9) g2.fillRect(x + 4, yy, w - 8, 5);
          for (let yy = y + 8; yy < VIEW_H - 6; yy += 9) {
            if (rng.chance(0.5)) lights.push({ x: x + w - 8, y: yy, w: 2, h: 1.5, col: rng.pick([th.accent, th.good, th.accent, th.warn]), per: rng.int(8, 90), on: rng.int(3, 40), ph: rng.int(0, 90), glow: 0 });
          }
          x += w + rng.int(60, 180);
        } else {
          const w = rng.int(5, 8);
          g2.fillStyle = ink; g2.fillRect(x, 0, w, VIEW_H);
          for (let y = rng.int(20, 80); y < VIEW_H; y += rng.int(60, 140)) g2.fillRect(x - 2, y, w + 4, 5);
          g2.fillStyle = rim; g2.fillRect(x, 0, 1, VIEW_H);
          x += w + rng.int(50, 160);
        }
      }
      g2.strokeStyle = ink; g2.lineWidth = 1.5; g2.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = rng.int(0, W), b = a + rng.int(80, 260), sag = rng.int(40, 160);
        g2.moveTo(a, cy + 5); g2.quadraticCurveTo((a + b) / 2, cy + 5 + sag, b, cy + 5);
      }
      g2.stroke();
      g2.drawImage(c, W, 0, 220, VIEW_H, 0, 0, 220, VIEW_H);
      for (const l of lights) if (l.x >= W) l.x -= W;
      g2.globalAlpha = 0.04;
      for (let x = 0; x < W + 220; x += 960) g2.drawImage(hex, 0, 0, 960, VIEW_H, x, 0, 960, VIEW_H);
      g2.globalAlpha = 1;
      bd.layers.push({ c, w: W, par: 0.45, lights });
    }

    // volumetric light shafts
    const shaft = bd.shaft = mkCanvas(160, VIEW_H), gs = shaft.getContext('2d');
    gr = gs.createLinearGradient(0, 0, 160, 0);
    gr.addColorStop(0, rgba(th.accent, 0)); gr.addColorStop(0.5, rgba(th.accent, 1)); gr.addColorStop(1, rgba(th.accent, 0));
    gs.fillStyle = gr; gs.fillRect(0, 0, 160, VIEW_H);
    gs.globalCompositeOperation = 'destination-in';
    gr = gs.createLinearGradient(0, 0, 0, VIEW_H);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.75, 'rgba(0,0,0,0)');
    gs.fillStyle = gr; gs.fillRect(0, 0, 160, VIEW_H);
    for (let i = 0; i < 4; i++) bd.shafts.push({ x: rng.float(0, 2200), w: rng.float(60, 160), ph: rng.float(0, TAU), a: rng.float(0.03, 0.06) });

    for (let i = 0; i < 70; i++) {
      bd.motes.push({ x: rng.float(0, VIEW_W + 40), y: rng.float(0, VIEW_H), vx: rng.float(-0.15, 0.15), vy: rng.float(-0.12, 0.05),
        s: rng.chance(0.2) ? 2 : 1, a: rng.float(0.15, 0.5), ph: rng.float(0, TAU), par: rng.float(0.5, 0.9) });
    }

    // the mission city on a slowly turning wireframe globe
    bd.globe = { x: rng.float(560, 820), y: rng.float(100, 170), r: rng.float(90, 130), tilt: rng.float(0.1, 0.35) };
  }

  drawBackdrop(ctx, view, f) {
    const bd = this.bd, th = this.th;
    for (let li = 0; li < bd.layers.length; li++) {
      const L = bd.layers[li];
      const off = ((view.x * L.par) % L.w + L.w) % L.w;
      ctx.drawImage(L.c, 0, 0, L.w, VIEW_H, -off, 0, L.w, VIEW_H);
      if (L.w - off < VIEW_W) ctx.drawImage(L.c, 0, 0, L.w, VIEW_H, L.w - off, 0, L.w, VIEW_H);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const l of L.lights) {
        if ((f + l.ph) % l.per >= l.on) continue;
        let x = l.x - off;
        if (x < -8) x += L.w;
        if (x > VIEW_W + 8) continue;
        ctx.globalAlpha = l.glow ? 0.9 : 0.55;
        ctx.fillStyle = l.col;
        ctx.fillRect(x, l.y, l.w, l.h);
        if (l.glow) drawGlow(ctx, l.col, x + 1, l.y + 1, 7, 0.5);
      }
      ctx.restore();
      if (li === 0) {
        // sky objects between the far skyline and the city: globe + light shafts
        this.drawGlobe(ctx, view, f);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const s of bd.shafts) {
          let x = (s.x - view.x * 0.3) % 2200;
          if (x < 0) x += 2200;
          x -= 300;
          if (x > VIEW_W + 200) continue;
          ctx.globalAlpha = s.a * (0.7 + 0.3 * Math.sin(f * 0.01 + s.ph));
          ctx.save();
          ctx.translate(x, 0);
          ctx.transform(1, 0, -0.32, 1, 0, 0);
          ctx.drawImage(bd.shaft, 0, 0, s.w, VIEW_H);
          ctx.restore();
        }
        ctx.restore();
      }
    }

    // dust motes
    ctx.fillStyle = rgba(th.accent, 0.7);
    const W = VIEW_W + 40;
    for (const m of bd.motes) {
      let x = (m.x + f * m.vx - view.x * m.par) % W;
      if (x < 0) x += W;
      let y = (m.y + f * m.vy + Math.sin(f * 0.012 + m.ph) * 8) % VIEW_H;
      if (y < 0) y += VIEW_H;
      ctx.globalAlpha = m.a * (0.6 + 0.4 * Math.sin(f * 0.03 + m.ph));
      ctx.fillRect(x - 20, y, m.s, m.s);
    }
    ctx.globalAlpha = 1;
  }

  drawGlobe(ctx, view, f) {
    const gl = this.bd.globe, th = this.th, def = this.run.def;
    const cx = gl.x - view.x * 0.02, cy = gl.y, R = gl.r;
    if (cx < -R * 1.5 || cx > VIEW_W + R * 1.5) return;
    const rot = f * 0.0025 + view.x * 0.0004;
    ctx.save();
    let gr = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R * 1.05);
    gr.addColorStop(0, rgba(th.accent2, 0.1)); gr.addColorStop(1, rgba(th.accent2, 0));
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.05, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba(th.accent, 0.13); ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const lam = i * Math.PI / 12 + rot;
      const rx = Math.abs(Math.sin(lam)) * R;
      if (rx > 0.5) { ctx.moveTo(cx + rx, cy); ctx.ellipse(cx, cy, rx, R, 0, 0, TAU); }
    }
    for (let k = -2; k <= 2; k++) {
      const phi = k * Math.PI / 6, y = cy - Math.sin(phi) * R, hw = Math.cos(phi) * R;
      ctx.moveTo(cx + hw, y); ctx.ellipse(cx, y, hw, hw * gl.tilt, 0, 0, TAU);
    }
    ctx.stroke();
    ctx.strokeStyle = rgba(th.accent, 0.3); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
    // orbit ring + satellite
    ctx.strokeStyle = rgba(th.accent, 0.18);
    ctx.setLineDash([2, 6]); ctx.lineDashOffset = -f * 0.3;
    ctx.beginPath(); ctx.ellipse(cx, cy, R * 1.4, R * 0.32, -0.32, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    const sa = f * 0.008, sx = Math.cos(sa) * R * 1.4, sy = Math.sin(sa) * R * 0.32;
    const c = Math.cos(-0.32), s = Math.sin(-0.32);
    ctx.fillStyle = th.text;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(cx + sx * c - sy * s - 1, cy + sx * s + sy * c - 1, 2, 2);
    ctx.globalAlpha = 1;
    // target city
    if (def.lat !== undefined) {
      const lam = (def.lon ?? 0) * Math.PI / 180 + rot, phi = def.lat * Math.PI / 180;
      if (Math.cos(lam) > 0) {
        const x = cx + R * Math.cos(phi) * Math.sin(lam), y = cy - R * Math.sin(phi);
        const p = (f % 90) / 90;
        ctx.strokeStyle = rgba(th.danger, 0.7 * (1 - p)); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, 2 + p * 12, 0, TAU); ctx.stroke();
        ctx.fillStyle = th.danger; ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        ctx.font = `7px ${FONT}`; ctx.fillStyle = rgba(th.danger, 0.6);
        ctx.fillText(def.city ?? 'TARGET', x + 6, y - 4);
      }
    }
    ctx.restore();
  }

  buildSigns() {
    this.signs = [];
    for (const [sx, sy, text] of this.run.def.signs ?? []) {
      const probe = mkCanvas(4, 4).getContext('2d');
      probe.font = `bold 9px ${FONT}`;
      const tw = probe.measureText(text).width || text.length * 6;
      const w = Math.ceil(tw + 22), h = 18, S = 2;
      const c = mkCanvas((w + 4) * S, (h + 4) * S), g = c.getContext('2d');
      g.scale(S, S); g.translate(2, 2);
      const th = this.th;
      g.fillStyle = rgba(th.accent, 0.08); g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      for (let y = 1; y < h; y += 2) g.fillRect(0, y, w, 1);
      g.strokeStyle = rgba(th.accent, 0.55); g.lineWidth = 1; g.strokeRect(0.5, 0.5, w - 1, h - 1);
      g.strokeStyle = th.accent; g.lineWidth = 1.5; g.beginPath();
      g.moveTo(0, 5); g.lineTo(0, 0); g.lineTo(5, 0); g.moveTo(w - 5, 0); g.lineTo(w, 0); g.lineTo(w, 5);
      g.moveTo(0, h - 5); g.lineTo(0, h); g.lineTo(5, h); g.moveTo(w - 5, h); g.lineTo(w, h); g.lineTo(w, h - 5);
      g.stroke();
      g.fillStyle = th.warn; g.fillRect(4, h / 2 - 2, 3, 4);
      g.font = `bold 9px ${FONT}`; g.textBaseline = 'middle'; g.fillStyle = th.text;
      g.fillText(text, 11, h / 2 + 0.5);
      let fy = sy + 1;
      while (fy < this.rows && this.visAt(sx, fy) === 0) fy++;
      this.signs.push({ c, x: sx * T + T / 2 - w / 2 - 2, y: sy * T + 6, w: w + 4, h: h + 4, cx: sx * T + T / 2, baseY: fy * T, ph: hash(sx, sy, 3) * 100 });
    }
  }

  drawSigns(ctx, f, x0, x1) {
    for (const s of this.signs) {
      if (s.x > x1 || s.x + s.w < x0) continue;
      const fl = hash((f >> 2) + (s.ph | 0), 1) < 0.06 ? 0.35 : 0.9;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = this.th.accent;
      ctx.beginPath();
      ctx.moveTo(s.cx - 2, s.baseY); ctx.lineTo(s.x + 6, s.y + s.h - 2); ctx.lineTo(s.x + s.w - 6, s.y + s.h - 2); ctx.lineTo(s.cx + 2, s.baseY);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = fl;
      const jx = fl < 0.5 ? (Math.random() - 0.5) * 6 : 0;
      ctx.drawImage(s.c, s.x + jx, s.y + Math.sin(f * 0.04 + s.ph) * 1.5, s.w, s.h);
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ per-tick ambient effects
  tickFx(run, P, view) {
    const th = this.th, x0 = view.x - 40, x1 = view.x + VIEW_W + 40;
    const p = run.player;
    if (p && run.frame !== this.lastRunFrame) {
      this.lastRunFrame = run.frame;
      this.trail.push({ x: p.x, y: p.y, facing: p.facing, gdir: p.gdir, phase: this.pose.phase, air: !p.grounded, vy: p.vy, vx: p.vx, squash: 0 });
      if (this.trail.length > 7) this.trail.shift();
      if (p.grounded && Math.abs(p.vx) > 0.25) this.pose.phase += Math.abs(p.vx) * 0.24;
      this.pose.squash *= 0.78;
    }
    for (const t of run.traps) {
      switch (t.type) {
        case 'laser': {
          if (!t.on || Math.random() > 0.3) break;
          const r = t.rect;
          if (t.def.mode === 'sweep') {
            if (r.x < x1 && r.x + r.w > x0) P.sparks(Math.random() < 0.5 ? r.x + 4 : r.x + r.w - 4, t.beamY, th.danger, 1, 2.5, 0, TAU);
          } else if (r.x > x0 && r.x < x1) P.sparks(r.x + r.w / 2, r.y + r.h - 6, th.danger, 1, 2.5, -Math.PI / 2, 2);
          break;
        }
        case 'sled':
          if (t.hz.enabled && t.pos.x > x0 && t.pos.x < x1) {
            const dir = Math.sign(t.def.vx ?? -1), bx = dir < 0 ? t.pos.x + t.pos.w : t.pos.x;
            P.sparks(bx, t.pos.y + t.pos.h - 1, th.warn, 2, 3.5, dir < 0 ? -0.35 : Math.PI + 0.35, 0.8);
          }
          break;
        case 'lockdown':
          if (t.hz.enabled && t.pos.x + t.pos.w > x0 && t.pos.x < x1) {
            const fx = t.pos.x + t.pos.w;
            P.sparks(fx - 4, t.pos.y + t.pos.h - 1, th.warn, 2, 4, -2.2, 0.9);
            P.sparks(fx - 4, t.pos.y + 1, th.warn, 1, 3, 2.2, 0.9);
            if (Math.random() < 0.3) P.dust(fx - 10, t.pos.y + t.pos.h, 1);
          }
          break;
        case 'drop':
          if (t.state === 'pending' && Math.random() < 0.7) P.debris(t.pos.x + Math.random() * t.pos.w, t.pos.y + t.pos.h, '#22314a', 1, 1);
          break;
        case 'crumble':
          if (t.state === 'pending') P.dust(t.rect.x + Math.random() * t.rect.w, t.rect.y + T, 1, rgba(th.accent, 0.6), -1);
          break;
        case 'drone':
          if (t.state === 'active' && !t.dead && Math.random() < 0.5) {
            P.add(P_EMBER, t.pos.x + DRONE_W / 2 + (Math.random() - 0.5) * 10, t.pos.y + DRONE_H, (Math.random() - 0.5) * 0.4, 0.8, 12, 1, th.danger, 0, 0.95);
          }
          break;
        case 'mine':
          if (t.state === 'pending' && (run.frame - t.firedAt) % 8 === 0) P.ring(t.rect.x + t.rect.w / 2, t.rect.y + t.rect.h - 3, th.danger, 2, 18, 12, 1.2);
          break;
      }
    }
    const d = run.door;
    if (d.targets && d.targets.length && !d.hidden) P.sparks(d.x + d.w / 2, d.y + d.h / 2, th.good, 2, 2, 0, TAU);
  }

  // ------------------------------------------------------------------ main draw
  draw(ctx, run, cam, particles, opts = {}) {
    if (run !== this.run) this.setRun(run);
    const f = opts.frame ?? 0;
    this.now = f;
    const dev = (ctx.canvas && ctx.canvas.width ? ctx.canvas.width : VIEW_W) / VIEW_W;
    this.ensureScale(dev);
    const view = cam.view(run);
    if (f !== this.lastTick) { this.lastTick = f; this.tickFx(run, particles, view); }
    const x0 = view.x - 96, x1 = view.x + VIEW_W + 96;
    const pt = this.patterns(ctx);

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.drawBackdrop(ctx, view, f);

    ctx.save();
    ctx.translate(-view.x, -view.y);
    this.drawFields(ctx, run, f, x0, x1, pt);
    this.drawCones(ctx, run, f, x0, x1);
    this.drawSigns(ctx, f, x0, x1);
    this.drawRails(ctx, run, x0, x1);
    ctx.restore();

    this.applyCuts(run);
    this.drawChunks(ctx, view, dev);

    ctx.save();
    ctx.translate(-view.x, -view.y);
    this.drawStaticGlow(ctx, f, x0, x1);
    this.drawDecals(ctx, f, x0, x1);
    this.drawSpawn(ctx, f);
    this.drawTraps(ctx, run, f, x0, x1);
    this.drawPickups(ctx, run, f, x0, x1);
    this.drawPlayer(ctx, run, f);
    this.drawBeams(ctx, run, f, x0, x1);
    particles.draw(ctx);
    this.drawScan(ctx, run, f);
    this.drawTags(ctx, run, f, view, pt);
    if (opts.zones) this.drawZones(ctx, run);
    ctx.restore();

    this.drawScreenFx(ctx, f);
    if (opts.rebuild !== undefined && opts.rebuild >= 0) this.drawRebuild(ctx, run, view, dev, opts.rebuild, f, particles);
    ctx.restore();
  }

  // ------------------------------------------------------------------ world layers
  drawFields(ctx, run, f, x0, x1, pt) {
    for (const t of run.traps) {
      if (t.type !== 'gravity' && t.type !== 'emp') continue;
      const show = t.def.visible || t.tagged;
      if (!show) continue;
      const r = t.rect;
      if (r.x > x1 || r.x + r.w < x0) continue;
      const a = t.def.visible ? 1 : 0.7;
      if (t.type === 'gravity') this.gravityField(ctx, r, f, a);
      else this.empField(ctx, r, f, a, pt);
    }
  }

  gravityField(ctx, r, f, a) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    ctx.fillStyle = rgba(GRAV, 0.045 + 0.015 * Math.sin(f * 0.05));
    ctx.fillRect(r.x, r.y, r.w, r.h);
    for (const side of [0, 1]) {
      const x = side ? r.x + r.w : r.x, gr = ctx.createLinearGradient(x, 0, x + (side ? -22 : 22), 0);
      gr.addColorStop(0, rgba(GRAV, 0.28)); gr.addColorStop(1, rgba(GRAV, 0));
      ctx.fillStyle = gr;
      ctx.fillRect(side ? x - 22 : x, r.y, 22, r.h);
    }
    const step = 40, off = (f * 1.3) % step;
    const band = (f * 2.2) % (r.h + 120) - 60;
    ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = rgba(GRAV, pass ? 0.55 : 0.16);
      ctx.beginPath();
      for (let x = r.x + 20; x < r.x + r.w - 8; x += step) {
        for (let y = r.y + r.h - off; y > r.y; y -= step) {
          const near = Math.abs(r.y + r.h - y - band) < 50;
          if (near !== (pass === 1)) continue;
          ctx.moveTo(x - 6, y + 4); ctx.lineTo(x, y - 2); ctx.lineTo(x + 6, y + 4);
        }
      }
      ctx.stroke();
    }
    ctx.fillStyle = rgba('#bcd4ff', 0.5);
    for (let k = 0; k < 18; k++) {
      const x = r.x + hash(k, 1, 99) * r.w, y = r.y + r.h - ((f * (1 + hash(k, 2, 99) * 1.5) + hash(k, 3, 99) * r.h) % r.h);
      ctx.fillRect(x, y, 1, 5);
    }
    ctx.strokeStyle = rgba(GRAV, 0.5); ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]); ctx.lineDashOffset = f * 0.8;
    ctx.beginPath(); ctx.moveTo(r.x + 0.5, r.y); ctx.lineTo(r.x + 0.5, r.y + r.h); ctx.moveTo(r.x + r.w - 0.5, r.y); ctx.lineTo(r.x + r.w - 0.5, r.y + r.h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  empField(ctx, r, f, a, pt) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    ctx.fillStyle = rgba(EMPC, 0.05);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (pt.noise) {
      const ox = (Math.random() * 96) | 0, oy = (Math.random() * 96) | 0;
      ctx.globalAlpha = a * 0.16;
      ctx.fillStyle = pt.noise;
      ctx.translate(ox, oy);
      ctx.fillRect(r.x - ox, r.y - oy, r.w, r.h);
      ctx.translate(-ox, -oy);
    }
    ctx.globalAlpha = a;
    for (let k = 0; k < 3; k++) {
      const y = r.y + ((f * 2.4 + k * 181) % r.h);
      ctx.fillStyle = rgba(EMPC, 0.1);
      ctx.fillRect(r.x, y, r.w, 5);
    }
    ctx.font = `bold 10px ${FONT}`; ctx.textAlign = 'center';
    for (let gx = 0; gx * 96 < r.w; gx++) {
      for (let gy = 1; gy * 96 < r.h; gy++) {
        if (hash(gx, gy, (f >> 3) + 11) < 0.45) continue;
        ctx.fillStyle = rgba(EMPC, 0.3 + 0.2 * hash(gx, gy, f));
        ctx.fillText(hash(gx, gy, 5) < 0.7 ? 'EMP' : '<//>', r.x + 48 + gx * 96 + (Math.random() - 0.5) * 2, r.y + gy * 96);
      }
    }
    ctx.strokeStyle = rgba(EMPC, 0.55); ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of [r.x, r.x + r.w]) {
      ctx.moveTo(x, r.y);
      for (let y = r.y; y < r.y + r.h; y += 12) ctx.lineTo(x + (Math.random() - 0.5) * 6, y + 12);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawCones(ctx, run, f, x0, x1) {
    const th = this.th;
    for (const t of run.traps) {
      if (t.type !== 'camera' || !t.hz?.cone) continue;
      const c = t.hz.cone;
      if (c.ax + c.len < x0 || c.ax - c.len > x1) continue;
      const tri = coneTriangle(c);
      const mx = (tri[1][0] + tri[2][0]) / 2, my = (tri[1][1] + tri[2][1]) / 2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const gr = ctx.createLinearGradient(c.ax, c.ay, mx, my);
      gr.addColorStop(0, 'rgba(255,225,232,0.34)');
      gr.addColorStop(0.25, rgba(th.danger, 0.2));
      gr.addColorStop(1, rgba(th.danger, 0.07));
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.moveTo(tri[0][0], tri[0][1]); ctx.lineTo(tri[1][0], tri[1][1]); ctx.lineTo(tri[2][0], tri[2][1]); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba(th.danger, 0.45); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(tri[1][0], tri[1][1]); ctx.lineTo(tri[0][0], tri[0][1]); ctx.lineTo(tri[2][0], tri[2][1]); ctx.stroke();
      ctx.strokeStyle = rgba(th.danger, 0.85); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tri[1][0], tri[1][1]); ctx.lineTo(tri[2][0], tri[2][1]); ctx.stroke();
      drawGlow(ctx, th.danger, mx, my, 34, 0.35, 10);
      const k = ((f * 2.2) % c.len) / c.len;
      ctx.globalAlpha = 0.35 * (1 - k);
      ctx.strokeStyle = HOT; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lerp(tri[0][0], tri[1][0], k), lerp(tri[0][1], tri[1][1], k));
      ctx.lineTo(lerp(tri[0][0], tri[2][0], k), lerp(tri[0][1], tri[2][1], k));
      ctx.stroke();
      ctx.restore();
    }
  }

  drawRails(ctx, run, x0, x1) {
    const th = this.th;
    for (const t of run.traps) {
      if (t.type !== 'lift' || !t.path || t.path.length < 2) continue;
      const b = t.body, a = t.path[0], z = t.path[t.path.length - 1];
      if (Math.max(a.x, z.x) + b.w < x0 || Math.min(a.x, z.x) > x1) continue;
      ctx.save();
      ctx.strokeStyle = rgba(th.accent2, 0.28); ctx.lineWidth = 1;
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x + b.w / 2, a.y + b.h / 2);
      for (let i = 1; i < t.path.length; i++) ctx.lineTo(t.path[i].x + b.w / 2, t.path[i].y + b.h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = rgba(th.accent2, 0.6);
      for (const q of t.path) ctx.fillRect(q.x + b.w / 2 - 2, q.y + b.h / 2 - 2, 4, 4);
      ctx.restore();
    }
  }

  drawStaticGlow(ctx, f, x0, x1) {
    const th = this.th;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const sc of this.spikeCells) {
      const x = sc.tx * T;
      if (x < x0 || x > x1) continue;
      const cy = sc.ty * T + (sc.dir === 'up' ? T - 6 : sc.dir === 'down' ? 6 : T / 2);
      drawGlow(ctx, th.danger, x + T / 2, cy, 24, 0.12 + 0.06 * Math.sin(f * 0.08 + sc.ph), 14);
    }
    ctx.restore();
  }

  drawDecals(ctx, f, x0, x1) {
    if (!this.decals.length) return;
    const th = this.th;
    this.decals = this.decals.filter(d => f - d.t0 < 600);
    for (const d of this.decals) {
      if (d.x < x0 || d.x > x1) continue;
      const age = f - d.t0;
      ctx.globalAlpha = 0.55 * Math.min(1, (600 - age) / 120);
      ctx.fillStyle = '#000000';
      ctx.beginPath(); ctx.ellipse(d.x, d.y - 1, 24, 4, 0, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      if (age < 160) drawGlow(ctx, th.warn, d.x, d.y - 2, 22, 0.45 * (1 - age / 160), 5);
      if (age < 14) drawGlow(ctx, '#ffffff', d.x, d.y - 20, 110, 0.6 * (1 - age / 14));
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  drawSpawn(ctx, f) {
    const s = this.spawn;
    if (!s) return;
    const cx = s.tx * T + T / 2, y = (s.ty + 1) * T, th = this.th;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(th.accent, 0.35); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx, y - 1, 16, 3, 0, 0, TAU); ctx.stroke();
    const k = (f % 80) / 80;
    ctx.strokeStyle = rgba(th.accent, 0.4 * (1 - k));
    ctx.beginPath(); ctx.ellipse(cx, y - 1, 16 + k * 10, 3 + k * 2, 0, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ traps
  drawTraps(ctx, run, f, x0, x1) {
    for (const t of run.traps) {
      const b = t.pos ?? t.body ?? t.rect;
      if (t.type !== 'drone' && (b.x > x1 || b.x + b.w < x0)) continue;
      switch (t.type) {
        case 'crumble': this.trCrumble(ctx, t, run); break;
        case 'drop': this.trDrop(ctx, t, run); break;
        case 'spikes': this.trSpikes(ctx, t, f); break;
        case 'sled': this.trSled(ctx, t); break;
        case 'press': this.trPress(ctx, t, f); break;
        case 'laser': this.trLaser(ctx, t, f); break;
        case 'tripwire': this.trTripwire(ctx, t, run, f); break;
        case 'camera': this.trCamera(ctx, t, f); break;
        case 'mine': this.trMine(ctx, t, run, f); break;
        case 'drone': this.trDrone(ctx, t, run, f, x0, x1); break;
        case 'lift': this.trLift(ctx, t, f); break;
        case 'lockdown': this.trLockdown(ctx, t, f); break;
      }
    }
  }

  holeEdges(ctx, reg, a) {
    if (a <= 0) return;
    const th = this.th, cols = this.cols;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = th.accent; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let ty = reg.y0; ty <= reg.yMax; ty++) {
      if (reg.cells.has(ty * cols + reg.x0) && this.visAt(reg.x0 - 1, ty) === 1) { ctx.moveTo(reg.x0 * T - 0.6, ty * T); ctx.lineTo(reg.x0 * T - 0.6, ty * T + T); }
      if (reg.cells.has(ty * cols + reg.x1) && this.visAt(reg.x1 + 1, ty) === 1) { ctx.moveTo((reg.x1 + 1) * T + 0.6, ty * T); ctx.lineTo((reg.x1 + 1) * T + 0.6, ty * T + T); }
    }
    for (let tx = reg.x0; tx <= reg.x1; tx++) {
      if (this.visAt(tx, reg.y0 - 1) === 1) { ctx.moveTo(tx * T, reg.y0 * T - 0.6); ctx.lineTo(tx * T + T, reg.y0 * T - 0.6); }
    }
    ctx.stroke();
    ctx.restore();
  }

  crack(ctx, x, y, w, down, seed) {
    // hairline fracture: dark line with a faint lit edge
    ctx.save();
    ctx.lineWidth = 1;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? rgba(this.th.accent, 0.3) : 'rgba(0,0,0,0.9)';
      ctx.beginPath();
      let px = x + w * (0.25 + hash(seed, 1) * 0.2), py = y;
      ctx.moveTo(px + pass * 0.7, py);
      for (let i = 0; i < 5; i++) {
        px += (hash(seed, i + 2) - 0.3) * 7; py += down * (2 + hash(seed, i + 9) * 3);
        ctx.lineTo(px + pass * 0.7, py);
      }
      ctx.moveTo(px - 3 + pass * 0.7, py - down * 6);
      ctx.lineTo(px - 8 + pass * 0.7, py - down * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  trCrumble(ctx, t, run) {
    const reg = this.regions.get(t.id);
    if (!reg) return;
    if (t.state === 'idle') {
      if (t.def.tell) this.crack(ctx, t.rect.x, t.rect.y + 2, t.rect.w, 1, reg.x0 * 31 + reg.y0);
      return;
    }
    const sp = this.sprite(reg), b = reg.box, s = this.scale, plateH = b.pt + T;
    if (t.state === 'pending') {
      ctx.globalAlpha = Math.random() < 0.25 ? 0.65 : 1;
      ctx.drawImage(sp, b.x + (Math.random() - 0.5) * 3, b.y + (Math.random() - 0.5) * 1.5, b.w, b.h);
      ctx.globalAlpha = 1;
      if (t.def.tell) this.crack(ctx, t.rect.x, t.rect.y + 2, t.rect.w, 1, reg.x0 * 31 + reg.y0);
      return;
    }
    const age = run.frame - t.activeAt;
    // the holographic "ground" under the plate glitches out
    const k = 1 - age / 20;
    const fh = b.h - plateH;
    if (k > 0 && fh > 0) {
      const n = 7;
      for (let i = 0; i < n; i++) {
        const sy = fh * i / n, sh = fh / n;
        ctx.globalAlpha = k * (0.4 + 0.6 * Math.random());
        ctx.drawImage(sp, 0, Math.floor((plateH + sy) * s), sp.width, Math.max(1, Math.floor(sh * s)),
          b.x + (Math.random() - 0.5) * 18 * (1 - k), b.y + plateH + sy, b.w, sh);
      }
      ctx.globalAlpha = 1;
    }
    this.holeEdges(ctx, reg, clamp(age / 24, 0, 0.7));
    // the real plate drops
    if (t.drop < 560) {
      const a = clamp(1 - t.drop / 280, 0, 1);
      if (a > 0) {
        ctx.globalAlpha = a;
        ctx.drawImage(sp, 0, 0, sp.width, Math.min(sp.height, Math.round(plateH * s)), b.x, b.y + t.drop, b.w, plateH);
        ctx.strokeStyle = rgba(this.th.danger, 0.7); ctx.lineWidth = 1;
        ctx.strokeRect(t.rect.x + 0.5, t.rect.y + t.drop + 0.5, t.rect.w - 1, T - 1);
        ctx.globalAlpha = 1;
      }
    }
  }

  trDrop(ctx, t, run) {
    const reg = this.regions.get(t.id);
    if (!reg) return;
    if (t.state === 'idle') {
      if (t.def.tell) this.crack(ctx, t.rect.x, t.rect.y + t.rect.h - 2, t.rect.w, -1, reg.x0 * 17 + reg.y0);
      return;
    }
    const th = this.th, sp = this.sprite(reg), b = reg.box, p = t.pos;
    const dy = p.y - t.rect.y;
    const jx = t.state === 'pending' ? (Math.random() - 0.5) * 3 : 0;
    this.holeEdges(ctx, reg, 0.6);
    ctx.drawImage(sp, b.x + jx, b.y + dy, b.w, b.h);
    if (t.state !== 'active') return;
    ctx.save();
    if (!t.landed) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(th.danger, 0.85); ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x + 0.75, p.y + 0.75, p.w - 1.5, p.h - 1.5);
      ctx.strokeStyle = rgba(th.danger, 0.25); ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = p.x + 4; x < p.x + p.w; x += 7) { ctx.moveTo(x, p.y); ctx.lineTo(x, p.y - Math.min(60, t.v * 4)); }
      ctx.stroke();
      drawGlow(ctx, th.danger, p.x + p.w / 2, p.y + p.h, p.w * 0.7, 0.4, 10);
    } else {
      ctx.strokeStyle = rgba(th.accent, 0.6); ctx.lineWidth = 1.2;
      ctx.strokeRect(p.x + 0.6, p.y + 0.6, p.w - 1.2, p.h - 1.2);
      ctx.fillStyle = rgba(th.accent, 0.9); ctx.fillRect(p.x, p.y, p.w, 1.5);
    }
    ctx.restore();
  }

  trSpikes(ctx, t, f) {
    const r = t.rect, th = this.th, cyc = !!t.def.cycle;
    const vert = t.dir === 'up' || t.dir === 'down';
    if ((cyc || !t.def.hidden) && vert) {
      const by = t.dir === 'up' ? r.y + r.h : r.y, n = Math.max(1, Math.round(r.w / 16)), sw = r.w / n;
      ctx.fillStyle = '#010204';
      for (let i = 0; i < n; i++) ctx.fillRect(r.x + i * sw + sw / 2 - 5, t.dir === 'up' ? by : by - 2.5, 10, 2.5);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const warn = cyc && t.warn;
      const col = warn ? th.warn : th.danger;
      const a = warn ? 0.55 + 0.4 * Math.sin(f * 1.3) : 0.18;
      ctx.fillStyle = rgba(col, a);
      for (let i = 0; i < n; i++) {
        const cx = r.x + i * sw + sw / 2;
        ctx.fillRect(cx - 4, t.dir === 'up' ? by : by - 1.2, 8, 1.2);
        if (warn) drawGlow(ctx, th.warn, cx, by - (t.dir === 'up' ? 3 : -3), 12, a * 0.6, 6);
      }
      ctx.restore();
    }
    if (t.pop > 0) drawSpikes(ctx, r.x, r.y, r.w, r.h, t.dir, ease(Math.min(1, t.pop)), th.danger);
  }

  trSled(ctx, t) {
    if (!t.hz.enabled) return;
    const p = t.pos, th = this.th;
    const grow = clamp((t.moved / Math.max(1, Math.abs(t.def.vx ?? 3)) + 1) / 5, 0, 1);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, th.danger, p.x + p.w / 2, p.y + p.h - 6, p.w * 0.8, 0.4, 14);
    const dir = Math.sign(t.def.vx ?? -1);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = th.warn;
    ctx.fillRect(dir < 0 ? p.x + p.w : p.x - 26, p.y + p.h - 2, 26, 1.5);
    ctx.restore();
    drawSpikes(ctx, p.x, p.y, p.w, p.h - 3, t.dir, ease(grow), th.danger);
    ctx.fillStyle = '#140a06';
    ctx.fillRect(p.x, p.y + p.h - 4, p.w, 4);
    hazardStripes(ctx, p.x, p.y + p.h - 4, p.w, 4, rgba(th.warn, 0.8), 8, 3);
  }

  trPress(ctx, t, f) {
    const th = this.th, x = t.rect.x, w = t.rect.w, top = t.top, bot = t.bottom, headH = 14;
    const prev = this.prevBottom.get(t.id) ?? bot, vel = bot - prev;
    this.prevBottom.set(t.id, bot);
    // landing zone marker
    const blink = (f >> 3) & 1;
    ctx.save();
    ctx.strokeStyle = rgba(th.danger, t.warn ? (blink ? 0.85 : 0.35) : 0.18); ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x + 2, t.downB - 1.5); ctx.lineTo(x + w - 2, t.downB - 1.5); ctx.stroke();
    ctx.setLineDash([]);
    const near = clamp((bot - t.upB) / Math.max(1, t.downB - t.upB), 0, 1);
    ctx.fillStyle = `rgba(0,0,0,${0.2 + 0.45 * near})`;
    ctx.beginPath(); ctx.ellipse(x + w / 2, t.downB - 1, w * (0.35 + 0.2 * near), 3, 0, 0, TAU); ctx.fill();
    // body
    const bodyB = bot - headH;
    if (bodyB > top) {
      ctx.fillStyle = '#0a1220'; ctx.fillRect(x + 4, top, w - 8, bodyB - top);
      ctx.fillStyle = rgba(th.accent, 0.16);
      ctx.fillRect(x + 9, top, 1, bodyB - top); ctx.fillRect(x + w - 10, top, 1, bodyB - top);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      for (let y = bodyB - 18; y > top; y -= 22) ctx.fillRect(x + 4, y, w - 8, 2);
      ctx.strokeStyle = rgba(th.accent, 0.35); ctx.lineWidth = 1;
      ctx.strokeRect(x + 4.5, top, w - 9, bodyB - top);
    }
    // head with hazard stripes
    ctx.fillStyle = '#16100a'; ctx.fillRect(x, bodyB, w, headH);
    hazardStripes(ctx, x, bodyB + 1, w, headH - 4, rgba(th.warn, 0.85), 12, 5);
    ctx.strokeStyle = rgba(th.warn, 0.6); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, bodyB + 0.5, w - 1, headH - 1);
    ctx.fillStyle = th.danger; ctx.fillRect(x, bot - 2.5, w, 2.5);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, th.danger, x + w / 2, bot, w * 0.75, 0.35 + (vel > 1 ? 0.3 : 0), 8);
    if (vel > 2) {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = HOT; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) { const xx = x + 6 + k * (w - 12) / 3; ctx.moveTo(xx, bodyB - 4); ctx.lineTo(xx, bodyB - 4 - vel * 3); }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    // housing + warning lamp
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0d1626'; ctx.fillRect(x - 3, top, w + 6, 9);
    ctx.strokeStyle = rgba(th.accent, 0.4); ctx.strokeRect(x - 2.5, top + 0.5, w + 5, 8);
    const lamp = t.warn ? (blink ? 1 : 0.25) : 0.15;
    ctx.fillStyle = rgba(th.warn, Math.max(0.3, lamp)); ctx.fillRect(x + w / 2 - 3, top + 2.5, 6, 4);
    if (t.warn) { ctx.globalCompositeOperation = 'lighter'; drawGlow(ctx, th.warn, x + w / 2, top + 5, 26, lamp * 0.8); }
    ctx.restore();
  }

  trLaser(ctx, t, f) {
    const th = this.th, r = t.rect, d = t.def;
    const lens = t.on ? th.danger : t.warn ? (((f >> 2) & 1) ? th.warn : '#5a3a10') : '#3a1018';
    ctx.save();
    if (d.mode === 'sweep') {
      const ya = (d.y0 ?? 0) * T, yb = (d.y1 ?? 0) * T;
      for (const x of [r.x + 1, r.x + r.w - 4]) {
        ctx.fillStyle = '#121a29'; ctx.fillRect(x, ya - 2, 3, yb - ya + 4);
        ctx.fillStyle = rgba(th.danger, 0.2); ctx.fillRect(x + 1, ya, 1, yb - ya);
      }
      const by = t.beamY ?? ya;
      for (const [x, dir] of [[r.x - 2, 1], [r.x + r.w - 6, -1]]) {
        ctx.fillStyle = '#1a2335'; ctx.fillRect(x, by - 5, 8, 10);
        ctx.strokeStyle = rgba(th.accent, 0.4); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, by - 4.5, 7, 9);
        ctx.fillStyle = lens; ctx.fillRect(dir > 0 ? x + 6 : x, by - 1.5, 2, 3);
      }
    } else {
      const cx = r.x + r.w / 2;
      ctx.fillStyle = '#141c2b';
      ctx.fillRect(cx - 6, r.y, 12, 6); ctx.fillRect(cx - 6, r.y + r.h - 6, 12, 6);
      ctx.strokeStyle = rgba(th.accent, 0.4); ctx.lineWidth = 1;
      ctx.strokeRect(cx - 5.5, r.y + 0.5, 11, 5); ctx.strokeRect(cx - 5.5, r.y + r.h - 5.5, 11, 5);
      ctx.fillStyle = lens;
      ctx.fillRect(cx - 2, r.y + 5, 4, 2); ctx.fillRect(cx - 2, r.y + r.h - 7, 4, 2);
      if (t.warn) {
        ctx.globalCompositeOperation = 'lighter';
        const a = 0.25 + 0.25 * Math.sin(f * 0.9);
        drawGlow(ctx, th.warn, cx, r.y + 6, 10, a); drawGlow(ctx, th.warn, cx, r.y + r.h - 6, 10, a);
      }
    }
    ctx.restore();
  }

  drawBeams(ctx, run, f, x0, x1) {
    const th = this.th;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const t of run.traps) {
      if (t.type !== 'laser') continue;
      const r = t.rect;
      if (r.x > x1 || r.x + r.w < x0) continue;
      if (t.def.mode === 'sweep') {
        if (t.on) this.beam(ctx, r.x + 6, t.beamY, r.x + r.w - 6, t.beamY);
        continue;
      }
      const cx = r.x + r.w / 2;
      if (t.on) this.beam(ctx, cx, r.y + 6, cx, r.y + r.h - 6);
      else if (t.warn) {
        ctx.globalAlpha = 0.2 + Math.random() * 0.4;
        ctx.strokeStyle = th.danger; ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]); ctx.lineDashOffset = -f;
        ctx.beginPath(); ctx.moveTo(cx, r.y + 6); ctx.lineTo(cx, r.y + r.h - 6); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  beam(ctx, xa, ya, xb, yb) {
    const th = this.th, fl = 0.82 + Math.random() * 0.18;
    const vert = xa === xb, j = (Math.random() - 0.5) * 0.8;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = rgba(th.danger, 0.11 * fl); ctx.lineWidth = 13;
    ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke();
    ctx.strokeStyle = rgba(th.danger, 0.42 * fl); ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = HOT; ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (vert) { ctx.moveTo(xa + j, ya); ctx.lineTo(xb + j, yb); } else { ctx.moveTo(xa, ya + j); ctx.lineTo(xb, yb + j); }
    ctx.stroke();
    drawGlow(ctx, th.danger, xa, ya, 14, 0.7 * fl);
    drawGlow(ctx, th.danger, xb, yb, 16, 0.8 * fl);
    ctx.globalAlpha = 1;
  }

  trTripwire(ctx, t, run, f) {
    const r = t.rect, x = r.x + r.w / 2, th = this.th;
    if (t.state !== 'idle') {
      const age = run.frame - t.activeAt;
      if (age >= 0 && age < 24) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 1 - age / 24;
        ctx.strokeStyle = th.danger; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x + 3, r.y + r.h * 0.4); ctx.moveTo(x, r.y + r.h); ctx.lineTo(x - 3, r.y + r.h * 0.6); ctx.stroke();
        ctx.restore();
      }
      return;
    }
    if (t.tagged || !t.def.faint) return;   // tagged: drawn by the scanner overlay
    ctx.save();
    ctx.globalAlpha = 0.14 + 0.06 * Math.sin(f * 0.07);
    ctx.strokeStyle = th.danger; ctx.lineWidth = 1;
    ctx.setLineDash([1.5, 2.5]);
    ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = th.danger; ctx.fillRect(x - 1, r.y - 1, 2, 2);
    ctx.restore();
  }

  trCamera(ctx, t, f) {
    const th = this.th, d = t.def, ax = d.ax * T, ay = d.ay * T, ang = t.hz.cone.ang;
    ctx.save();
    ctx.fillStyle = '#0d1626';
    ctx.fillRect(ax - 3, ay - 9, 6, 9);
    ctx.strokeStyle = rgba(th.accent, 0.4); ctx.lineWidth = 1; ctx.strokeRect(ax - 2.5, ay - 8.5, 5, 8);
    ctx.translate(ax, ay);
    ctx.rotate(-ang);
    ctx.fillStyle = '#121d30'; ctx.fillRect(-5.5, -3, 11, 14);
    ctx.strokeStyle = rgba(th.accent, 0.55); ctx.strokeRect(-5, -2.5, 10, 13);
    ctx.fillStyle = '#05080e'; ctx.fillRect(-4, 10, 8, 4);
    ctx.fillStyle = th.danger; ctx.fillRect(-2.5, 11, 5, 3);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, th.danger, 0, 13, 9, 0.8);
    if (f % 50 < 10) { ctx.globalAlpha = 1; ctx.fillStyle = th.danger; ctx.fillRect(2, -1, 2, 2); drawGlow(ctx, th.danger, 3, 0, 6, 0.8); }
    ctx.restore();
  }

  trMine(ctx, t, run, f) {
    if (t.state === 'active') return;
    if (t.def.hidden && t.state === 'idle') return;   // revealed by the scanner overlay when tagged
    const th = this.th, r = t.rect, cx = r.x + r.w / 2, by = r.y + r.h;
    ctx.save();
    ctx.fillStyle = '#0a0e15'; ctx.fillRect(cx - r.w * 0.45, by - 2, r.w * 0.9, 2);
    ctx.fillStyle = '#161d2a';
    ctx.beginPath(); ctx.ellipse(cx, by - 2, r.w * 0.36, 5, 0, Math.PI, 0); ctx.fill();
    ctx.strokeStyle = rgba(th.danger, 0.55); ctx.lineWidth = 1; ctx.stroke();
    const pending = t.state === 'pending';
    const on = pending ? ((run.frame - t.firedAt) >> 2) % 2 === 0 : f % 70 < 8;
    ctx.fillStyle = on ? th.danger : '#4a0f19';
    ctx.fillRect(cx - 1.5, by - 8, 3, 2);
    if (on) { ctx.globalCompositeOperation = 'lighter'; drawGlow(ctx, th.danger, cx, by - 7, pending ? 22 : 10, pending ? 0.9 : 0.5); }
    ctx.restore();
  }

  trDrone(ctx, t, run, f, x0, x1) {
    if (t.state !== 'active' || t.dead) return;
    const th = this.th, p = t.pos, cx = p.x + DRONE_W / 2, cy = p.y + DRONE_H / 2;
    if (cx < x0 - 40 || cx > x1 + 40) return;
    const pl = run.player;
    ctx.save();
    // searchlight towards the target
    const dx = pl.cx - cx, dy = pl.cy - cy, dist = Math.hypot(dx, dy) || 1;
    if (dist < 420) {
      const nx = -dy / dist, ny = dx / dist, w = 6 + dist * 0.12;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba(th.danger, 0.06);
      ctx.beginPath(); ctx.moveTo(cx, cy + 2); ctx.lineTo(pl.cx + nx * w, pl.cy + ny * w); ctx.lineTo(pl.cx - nx * w, pl.cy - ny * w); ctx.closePath(); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.translate(cx, cy);
    ctx.rotate(clamp(t.vx * 0.12, -0.45, 0.45));
    ctx.strokeStyle = '#1b2539'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-11, -4); ctx.lineTo(11, -4); ctx.stroke();
    for (const sx of [-10, 10]) {
      ctx.fillStyle = 'rgba(200,220,255,0.16)';
      ctx.beginPath(); ctx.ellipse(sx, -6, 7, 1.6, 0, 0, TAU); ctx.fill();
      const a = f * 0.9 + sx;
      ctx.strokeStyle = 'rgba(220,235,255,0.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx - Math.cos(a) * 6.5, -6); ctx.lineTo(sx + Math.cos(a) * 6.5, -6); ctx.stroke();
    }
    ctx.fillStyle = '#0d1320';
    ctx.beginPath();
    ctx.moveTo(-8, -3); ctx.lineTo(8, -3); ctx.lineTo(10, 1); ctx.lineTo(6, 6); ctx.lineTo(-6, 6); ctx.lineTo(-10, 1); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = rgba(th.danger, 0.75); ctx.lineWidth = 1; ctx.stroke();
    const ex = clamp(dx / dist, -1, 1) * 3, critical = t.life < 45;
    const eyeOn = !critical || ((f >> 2) & 1);
    ctx.fillStyle = eyeOn ? th.danger : '#ffffff';
    ctx.beginPath(); ctx.arc(ex, 1.5, 2.6, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, critical && !eyeOn ? '#ffffff' : th.danger, ex, 1.5, critical ? 16 : 11, 0.85);
    ctx.restore();
  }

  trLift(ctx, t, f) {
    const th = this.th, b = t.body;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const fl = 0.7 + 0.3 * Math.sin(f * 0.6);
    drawGlow(ctx, th.accent2, b.x + 7, b.y + b.h + 3, 10, 0.55 * fl, 7);
    drawGlow(ctx, th.accent2, b.x + b.w - 7, b.y + b.h + 3, 10, 0.55 * fl, 7);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0c1628'; ctx.fillRect(b.x, b.y, b.w, b.h);
    hazardStripes(ctx, b.x, b.y + b.h - 4, b.w, 4, rgba(th.warn, 0.7), 8, 3);
    ctx.strokeStyle = rgba(th.accent, 0.5); ctx.lineWidth = 1; ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    ctx.fillStyle = rgba(th.accent, 0.8); ctx.fillRect(b.x + 6, b.y + 6, 3, 2); ctx.fillRect(b.x + b.w - 9, b.y + 6, 3, 2);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(th.accent, 0.3); ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(b.x, b.y + 1); ctx.lineTo(b.x + b.w, b.y + 1); ctx.stroke();
    ctx.strokeStyle = th.accent; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }

  trLockdown(ctx, t, f) {
    if (!t.hz.enabled) return;
    const th = this.th, p = t.pos, bw = p.w - 12;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, th.danger, p.x + p.w + 10, p.y + p.h / 2, 70, 0.4, p.h * 0.6);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#12060a'; ctx.fillRect(p.x, p.y, bw, p.h);
    hazardStripes(ctx, p.x, p.y, bw, p.h, rgba(th.danger, 0.22), 16, 6);
    ctx.fillStyle = rgba(th.danger, 0.5 + 0.5 * ((f >> 3) & 1));
    ctx.fillRect(p.x + bw / 2 - 1.5, p.y + 4, 3, p.h - 8);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (let y = p.y + 24; y < p.y + p.h; y += 32) ctx.fillRect(p.x, y, bw, 3);
    ctx.strokeStyle = th.danger; ctx.lineWidth = 1.5; ctx.strokeRect(p.x + 0.75, p.y + 0.75, bw - 1.5, p.h - 1.5);
    drawSpikes(ctx, p.x + bw, p.y, 12, p.h, 'right', 1, th.danger);
    ctx.restore();
  }

  // ------------------------------------------------------------------ pickups + exits
  drawPickups(ctx, run, f, x0, x1) {
    const vis = r => r.x + r.w > x0 && r.x < x1;
    for (const k of run.keys) if (!k.taken && vis(k)) this.keycard(ctx, k, f);
    for (const t of run.traps) {
      if (t.type === 'fakeKey' && vis(t.rect)) {
        if (t.state !== 'active') this.keycard(ctx, t.rect, f);
        else {
          const age = run.frame - t.activeAt;
          if (age >= 0 && age < 26) this.decoyRemnant(ctx, t.rect, age, f);
        }
      }
    }
    const locked = run.doorLocked();
    for (const t of run.traps) if (t.type === 'fakeDoor' && vis(t.rect)) this.extract(ctx, t.rect, locked, f);
    if (!run.door.hidden && vis(run.door)) this.extract(ctx, run.door, locked, f);
  }

  keycard(ctx, r, f) {
    const th = this.th, cx = r.x + r.w / 2, cy = r.y + r.h / 2 + Math.sin(f * 0.07) * 2;
    const sx = Math.cos(f * 0.045), w = 14 * Math.max(0.1, Math.abs(sx)), h = 18;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, th.key, cx, cy, 20, 0.35);
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = th.key;
    ctx.beginPath(); ctx.moveTo(cx - 2, cy + 18); ctx.lineTo(cx - w / 2, cy + h / 2); ctx.lineTo(cx + w / 2, cy + h / 2); ctx.lineTo(cx + 2, cy + 18); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgba(th.key, sx > 0 ? 0.24 : 0.12);
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    ctx.strokeStyle = th.key; ctx.lineWidth = 1.2;
    ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
    if (Math.abs(sx) > 0.3) {
      const k = sx;
      ctx.fillStyle = sx > 0 ? '#ffe9a0' : rgba(th.key, 0.6);
      if (sx > 0) ctx.fillRect(cx - 4 * k, cy - 5, 4 * k, 3.5);           // chip
      ctx.fillStyle = rgba(th.key, 0.7);
      ctx.fillRect(cx - 5 * Math.abs(k), cy + 2, 10 * Math.abs(k), 1.2);  // mag stripe
      ctx.fillRect(cx - 5 * Math.abs(k), cy + 5, 6 * Math.abs(k), 1);
    }
    ctx.globalCompositeOperation = 'lighter';
    const sh = ((f * 0.9) % 40) / 40;
    ctx.globalAlpha = 0.5 * (1 - sh);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - w / 2, cy - h / 2 + sh * h, w, 1);
    ctx.restore();
  }

  decoyRemnant(ctx, r, age, f) {
    const th = this.th, k = 1 - age / 26, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      ctx.globalAlpha = k * Math.random();
      ctx.fillStyle = i & 1 ? th.danger : th.key;
      ctx.fillRect(cx - 9 + (Math.random() - 0.5) * 16 * (1 - k), cy - 9 + i * 3, 18 * Math.random() + 3, 2);
    }
    ctx.globalAlpha = k;
    ctx.font = `bold 8px ${FONT}`; ctx.textAlign = 'center'; ctx.fillStyle = th.danger;
    ctx.fillText('DECOY', cx, cy - 14 - age * 0.5);
    ctx.restore();
  }

  extract(ctx, r, locked, f) {
    const th = this.th, cx = r.x + r.w / 2, by = r.y + r.h;
    const col = locked ? th.danger : th.good;
    ctx.save();
    // pylons + lintel + base pad
    ctx.fillStyle = '#0a1422';
    ctx.fillRect(r.x - 6, r.y - 4, 5, r.h + 4); ctx.fillRect(r.x + r.w + 1, r.y - 4, 5, r.h + 4);
    ctx.fillRect(r.x - 6, r.y - 7, r.w + 12, 4);
    ctx.fillStyle = '#060b12'; ctx.fillRect(r.x - 8, by - 3, r.w + 16, 3);
    ctx.fillStyle = rgba(col, locked ? 0.45 : 0.9);
    ctx.fillRect(r.x - 4, r.y, 1.2, r.h - 4); ctx.fillRect(r.x + r.w + 2.8, r.y, 1.2, r.h - 4);
    ctx.fillRect(r.x - 4, r.y - 5.5, r.w + 8, 1.2);
    ctx.globalCompositeOperation = 'lighter';
    // running lights in the pylons
    ctx.fillStyle = locked ? th.danger : '#eafff5';
    for (let k = 0; k < 2; k++) {
      const y = by - 4 - ((f * (locked ? 0.4 : 1.2) + k * r.h / 2) % (r.h - 4));
      ctx.globalAlpha = 0.9;
      ctx.fillRect(r.x - 4.5, y, 2.2, 3); ctx.fillRect(r.x + r.w + 2.3, y, 2.2, 3);
    }
    // the beam
    const flick = 0.92 + 0.08 * Math.sin(f * 0.9);
    const a = (locked ? 0.2 : 0.62) * flick;
    const gr = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
    gr.addColorStop(0, rgba(col, 0)); gr.addColorStop(0.5, rgba(col, 1)); gr.addColorStop(1, rgba(col, 0));
    ctx.globalAlpha = a * 0.55;
    ctx.fillStyle = gr; ctx.fillRect(r.x, r.y - 2, r.w, r.h + 2);
    if (!locked) {
      ctx.globalAlpha = 0.7 * flick; ctx.fillStyle = '#eafff5';
      ctx.fillRect(cx - 1, r.y, 2, r.h);
      const g2 = ctx.createLinearGradient(0, r.y - 60, 0, r.y);
      g2.addColorStop(0, rgba(col, 0)); g2.addColorStop(1, rgba(col, 0.35));
      ctx.globalAlpha = flick; ctx.fillStyle = g2; ctx.fillRect(cx - 4, r.y - 60, 8, 60);
    }
    drawGlow(ctx, col, cx, by - 2, r.w * 1.1, locked ? 0.25 : 0.55, 8);
    drawGlow(ctx, col, cx, r.y + r.h / 2, r.w * 1.2, locked ? 0.08 : 0.22, r.h * 0.7);
    // rotating rings
    ctx.strokeStyle = col; ctx.lineWidth = 1.2;
    for (let i = 0; i < 2; i++) {
      const k = ((f * (locked ? 0.25 : 0.7) + i * 0.5 * (r.h + 8)) % (r.h + 8)) / (r.h + 8);
      ctx.globalAlpha = (locked ? 0.35 : 0.85) * Math.sin(k * Math.PI);
      ctx.beginPath(); ctx.ellipse(cx, by - 2 - k * (r.h + 6), r.w / 2 + 4, 3 + Math.sin(f * 0.05 + i) * 0.8, 0, 0, TAU); ctx.stroke();
    }
    if (!locked) {
      ctx.fillStyle = '#eafff5';
      for (let i = 0; i < 6; i++) {
        const k = ((f * 1.3 + i * 23) % (r.h + 14)) / (r.h + 14);
        ctx.globalAlpha = 0.8 * (1 - k);
        ctx.fillRect(cx + Math.sin(f * 0.05 + i * 2.1) * r.w * 0.32, by - k * (r.h + 14), 1.5, 1.5);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.font = `bold 7px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillStyle = rgba(col, 0.9);
    ctx.fillText(locked ? 'LOCKED' : 'EXTRACT', cx, r.y - 11);
    if (locked) lockGlyph(ctx, cx, r.y + r.h * 0.45 + Math.sin(f * 0.08), th.danger);
    ctx.restore();
  }

  // ------------------------------------------------------------------ the agent
  drawPlayer(ctx, run, f) {
    const p = run.player;
    if (!p || run.state === 'dead') return;
    const th = this.th;
    const feetY = p.gdir > 0 ? p.y + p.h : p.y;
    const st = {
      facing: p.facing || 1, gdir: p.gdir, phase: this.pose.phase, air: !p.grounded,
      vy: p.vy, vx: p.vx, squash: this.pose.squash,
    };
    ctx.save();
    if (p.done) {
      const el = this.winAt < 0 ? 0 : f - this.winAt;
      const a = clamp(1 - el / 26, 0, 1);
      ctx.globalCompositeOperation = 'lighter';
      const gr = ctx.createLinearGradient(p.cx - 14, 0, p.cx + 14, 0);
      gr.addColorStop(0, rgba(th.good, 0)); gr.addColorStop(0.5, rgba(th.good, 0.7)); gr.addColorStop(1, rgba(th.good, 0));
      ctx.globalAlpha = clamp(1 - el / 45, 0, 1);
      ctx.fillStyle = gr; ctx.fillRect(p.cx - 14, 0, 28, feetY);
      ctx.globalCompositeOperation = 'source-over';
      if (a > 0) {
        st.squash = -el * 0.05;
        this.agent(ctx, p.cx, feetY, st, 0, a);
      }
      ctx.restore();
      return;
    }
    const fast = Math.abs(p.vx) > 3.1 || Math.abs(p.vy) > 7;
    if (fast && this.trail.length > 2) {
      ctx.globalCompositeOperation = 'lighter';
      const n = this.trail.length;
      for (let i = 0; i < n - 1; i += 1) {
        const tr = this.trail[i];
        this.agent(ctx, tr.x + p.w / 2, tr.gdir > 0 ? tr.y + p.h : tr.y, tr, 1, 0.05 + 0.05 * (i / n), th.accent);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, th.accent, p.cx, p.cy, 30, 0.1);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.agent(ctx, p.cx, feetY, st, 0, 1, null, run.scan.cd === 0);
    if (p.reversed) {
      // EMP: glitchy purple static all over the agent
      ctx.globalCompositeOperation = 'lighter';
      const j = (Math.random() - 0.5) * 5;
      this.agent(ctx, p.cx + 2 + j, feetY, st, 1, 0.35, EMPC);
      this.agent(ctx, p.cx - 2 - j, feetY, st, 1, 0.25, '#4dd9ff');
      ctx.globalAlpha = 0.8;
      for (let i = 0; i < 7; i++) {
        ctx.fillStyle = Math.random() < 0.3 ? '#ffffff' : EMPC;
        ctx.fillRect(p.x - 4 + Math.random() * (p.w + 8), p.y + Math.random() * p.h, 1 + Math.random() * 6, 1);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }

  /** Spy silhouette with feet at (fx, fy). mode 0 = full, 1 = flat ghost in `col`. */
  agent(ctx, fx, fy, st, mode, alpha, col = null, ready = true) {
    const th = this.th;
    const running = !st.air && Math.abs(st.vx) > 0.3;
    const ph = st.phase;
    const sq = st.squash || 0;
    const stretch = st.air ? clamp(Math.abs(st.vy) / 12, 0, 1) * 0.12 : 0;
    const syy = 1 - sq + stretch, sxx = 1 + sq * 0.7 - stretch * 0.5;
    ctx.save();
    ctx.translate(fx, fy);
    ctx.scale((st.facing || 1) * sxx, (st.gdir || 1) * syy);
    ctx.globalAlpha = alpha;
    const bob = running ? -Math.abs(Math.sin(ph)) * 1.2 : st.air ? 0 : Math.sin(this.now * 0.06) * 0.35;
    const lean = running ? clamp(Math.abs(st.vx) * 0.5, 0, 2) : 0;
    const hipX = 0, hipY = -9 + bob, shX = 0.5 + lean, shY = -17.2 + bob, hdX = 1.3 + lean, hdY = -21.6 + bob;
    let f1x, f1y, k1x, k1y, f2x, f2y, k2x, k2y, h1x, h1y, e1x, e1y, h2x, h2y, e2x, e2y;
    if (st.air) {
      const up = st.vy * (st.gdir || 1) < 0;
      if (up) { f1x = 4; f1y = -3; k1x = 4.8; k1y = -6.5; f2x = -3; f2y = -1; k2x = -0.5; k2y = -5; }
      else { f1x = 2.5; f1y = 0; k1x = 3.6; k1y = -4.6; f2x = -3.5; f2y = -0.6; k2x = -1.5; k2y = -4.5; }
      h1x = shX + 5; h1y = shY - (up ? 4 : 0.5); e1x = shX + 3; e1y = shY + 1;
      h2x = shX - 5; h2y = shY + 3; e2x = shX - 2.5; e2y = shY + 3.5;
    } else if (running) {
      const a = Math.sin(ph), b = -a, ca = Math.cos(ph), cb = -ca;
      f1x = a * 6; f1y = -Math.max(0, ca) * 3.2; k1x = a * 3 + 2; k1y = -4.6 + f1y * 0.3;
      f2x = b * 6; f2y = -Math.max(0, cb) * 3.2; k2x = b * 3 + 2; k2y = -4.6 + f2y * 0.3;
      h1x = shX - a * 5; h1y = shY + 7.5 - Math.abs(a) * 1.5; e1x = shX - a * 2.5 - 0.5; e1y = shY + 4;
      h2x = shX - b * 5; h2y = shY + 7.5 - Math.abs(b) * 1.5; e2x = shX - b * 2.5 - 0.5; e2y = shY + 4;
    } else {
      f1x = 2.6; f1y = 0; k1x = 2.6; k1y = -4.5; f2x = -2.6; f2y = 0; k2x = -2.1; k2y = -4.5;
      h1x = shX + 2; h1y = shY + 8; e1x = shX + 2.3; e1y = shY + 4; h2x = shX - 2.5; h2y = shY + 8; e2x = shX - 2.7; e2y = shY + 4;
    }
    const limbs = lw => {
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(hipX, hipY); ctx.lineTo(k2x, k2y); ctx.lineTo(f2x, f2y);
      ctx.moveTo(hipX, hipY); ctx.lineTo(k1x, k1y); ctx.lineTo(f1x, f1y);
      ctx.moveTo(shX, shY + 1); ctx.lineTo(e2x, e2y); ctx.lineTo(h2x, h2y);
      ctx.moveTo(shX, shY + 1); ctx.lineTo(e1x, e1y); ctx.lineTo(h1x, h1y);
      ctx.stroke();
    };
    const torso = () => {
      ctx.beginPath();
      ctx.moveTo(shX - 3.6, shY - 0.4); ctx.lineTo(shX + 3.6, shY - 0.4);
      ctx.lineTo(hipX + 3, hipY + 0.5); ctx.lineTo(hipX - 3, hipY + 0.5); ctx.closePath();
    };
    const head = () => { ctx.beginPath(); ctx.arc(hdX, hdY, 4.3, 0, TAU); };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (mode === 1) {
      ctx.strokeStyle = ctx.fillStyle = col || th.accent;
      limbs(3.4); torso(); ctx.fill(); head(); ctx.fill();
    } else {
      const rim = rgba(th.accent, 0.55);
      ctx.strokeStyle = rim;
      limbs(5.2);
      torso(); ctx.lineWidth = 2.2; ctx.stroke();
      head(); ctx.lineWidth = 2.2; ctx.stroke();
      ctx.strokeStyle = SUIT; ctx.fillStyle = SUIT;
      limbs(3.2); torso(); ctx.fill(); head(); ctx.fill();
      // collar + tie
      ctx.fillStyle = '#cfd8e6';
      ctx.beginPath(); ctx.moveTo(shX + 1.2, shY - 0.3); ctx.lineTo(shX + 3.4, shY - 0.3); ctx.lineTo(shX + 2.3, shY + 2.6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#05070c'; ctx.fillRect(shX + 2, shY + 0.3, 0.8, 2.6);
      // back-pack scanner light (bright = scanner ready)
      ctx.fillStyle = ready ? th.scan : rgba(th.scan, 0.25);
      ctx.fillRect(shX - 4.6, shY + 1.5, 1.6, 3);
      // visor
      ctx.strokeStyle = rgba(th.accent, 0.35); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(hdX - 0.2, hdY - 0.7); ctx.lineTo(hdX + 4.4, hdY - 0.7); ctx.stroke();
      ctx.strokeStyle = th.accent; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(hdX + 1.6, hdY - 1); ctx.lineTo(hdX + 4.2, hdY - 1); ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ scanner + intel tags
  drawScan(ctx, run, f) {
    const sc = run.scan;
    if (!sc || sc.t < 0) return;
    const th = this.th;
    const k = Math.min(1, sc.t / SCAN_GROW), r = Math.max(1, SCAN_RADIUS * k);
    const fade = sc.t <= SCAN_GROW ? 1 : clamp(1 - (sc.t - SCAN_GROW) / 30, 0, 1);
    if (fade <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // hex lattice inside the pulse
    ctx.save();
    ctx.beginPath(); ctx.arc(sc.x, sc.y, r, 0, TAU); ctx.clip();
    ctx.globalAlpha = 0.16 * fade;
    const hx = this.bd.hex, sz = Math.min(2 * r, hx.height);
    ctx.drawImage(hx, 0, 0, sz, sz, sc.x - sz / 2, sc.y - sz / 2, sz, sz);
    const gr = ctx.createRadialGradient(sc.x, sc.y, r * 0.15, sc.x, sc.y, r);
    gr.addColorStop(0, rgba(th.scan, 0)); gr.addColorStop(0.8, rgba(th.scan, 0.05)); gr.addColorStop(1, rgba(th.scan, 0.18));
    ctx.globalAlpha = fade;
    ctx.fillStyle = gr;
    ctx.fillRect(sc.x - r, sc.y - r, 2 * r, 2 * r);
    // sweep wedge
    const a = sc.t * 0.22;
    for (let i = 0; i < 6; i++) {
      ctx.globalAlpha = fade * 0.05 * (i + 1);
      ctx.fillStyle = th.scan;
      ctx.beginPath(); ctx.moveTo(sc.x, sc.y); ctx.arc(sc.x, sc.y, r, a - 0.9 + i * 0.15, a - 0.75 + i * 0.15); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = fade;
    ctx.strokeStyle = rgba(th.scan, 0.18); ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(sc.x, sc.y, r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = th.scan; ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = rgba(th.scan, 0.5); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 36; i++) {
      const aa = i * TAU / 36 - a * 0.3, c = Math.cos(aa), s = Math.sin(aa), l = i % 3 === 0 ? 8 : 4;
      ctx.moveTo(sc.x + c * (r + 3), sc.y + s * (r + 3)); ctx.lineTo(sc.x + c * (r + 3 + l), sc.y + s * (r + 3 + l));
    }
    ctx.stroke();
    ctx.restore();
  }

  tagRect(t, run) {
    switch (t.type) {
      case 'drop': case 'sled': case 'drone': return t.pos;
      case 'lockdown': return t.state === 'idle' ? t.rect : t.pos;
      case 'lift': return t.body;
      case 'runDoor': return run.door;
      default: return t.rect;
    }
  }

  drawTags(ctx, run, f, view, pt) {
    const th = this.th;
    const vx0 = view.x - 40, vx1 = view.x + VIEW_W + 40;
    let labels = null;
    for (const t of run.traps) {
      if (!t.tagged) continue;
      if (!this.tagSeen.has(t.id)) this.tagSeen.set(t.id, f);
      const r = this.tagRect(t, run);
      if (!r || r.x > vx1 || r.x + r.w < vx0) continue;
      const age = f - this.tagSeen.get(t.id);
      ctx.save();
      this.drawGhost(ctx, t, run, f, pt);
      // lock-on brackets collapsing onto the target
      const k = ease(Math.min(1, age / 14));
      const pad = 3 + (1 - k) * 26, L = 6 + (1 - k) * 6;
      const bx = r.x - pad, by = r.y - pad, bw = r.w + pad * 2, bh = r.h + pad * 2;
      ctx.globalAlpha = 0.35 + 0.65 * k;
      ctx.strokeStyle = th.danger; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx, by + L); ctx.lineTo(bx, by); ctx.lineTo(bx + L, by);
      ctx.moveTo(bx + bw - L, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + L);
      ctx.moveTo(bx, by + bh - L); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + L, by + bh);
      ctx.moveTo(bx + bw - L, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - L);
      ctx.stroke();
      if (k >= 1) {
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([5, 4]); ctx.lineDashOffset = -f * 0.6;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x - 2.5, r.y - 2.5, r.w + 5, r.h + 5);
        if (t.def.hidden) {
          ctx.strokeStyle = th.scan; ctx.globalAlpha = 0.45;
          for (const tr of t.triggers) {
            if (tr.rect) ctx.strokeRect(tr.rect.x + 0.5, tr.rect.y + 0.5, tr.rect.w - 1, tr.rect.h - 1);
            else if (tr.on === 'x') {
              const xx = (tr.gte ?? tr.lte) * T;
              ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, this.rows * T); ctx.stroke();
            }
          }
        }
        // chain links: this trap is fired by another one
        for (const tr of t.triggers) {
          if (tr.on !== 'trap') continue;
          const src = run.trapById[tr.id];
          if (!src) continue;
          const sr = this.tagRect(src, run);
          ctx.strokeStyle = th.scan; ctx.globalAlpha = 0.5;
          ctx.setLineDash([2, 4]);
          ctx.beginPath(); ctx.moveTo(sr.x + sr.w / 2, sr.y + sr.h / 2); ctx.lineTo(r.x + r.w / 2, r.y + r.h / 2); ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      ctx.restore();
      (labels ??= []).push({ t, r, age });
    }
    if (labels) this.drawLabels(ctx, labels, view);
  }

  drawLabels(ctx, labels, view) {
    const th = this.th, placed = [];
    ctx.save();
    ctx.font = `bold 8px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const { t, r, age } of labels) {
      const text = t.spec?.label ?? TRAP_LABEL_FALLBACK[t.type] ?? t.type.toUpperCase();
      let tw = this.labelW.get(text);
      if (tw === undefined) { tw = ctx.measureText(text).width || text.length * 5; this.labelW.set(text, tw); }
      const w = tw + 12, h = 12;
      let x = clamp(r.x + r.w / 2 - w / 2, view.x + 4, view.x + VIEW_W - w - 4);
      let y = r.y - h - 7;
      if (y < 4) y = Math.max(4, r.y + 6);
      for (let tries = 0; tries < 8; tries++) {
        const hit = placed.find(b => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y);
        if (!hit) break;
        y = hit.y + hit.h + 2;
      }
      placed.push({ x, y, w, h });
      const n = Math.min(text.length, Math.floor(age * 0.9));
      const ax = r.x + r.w / 2, ay = y < r.y ? r.y - 2 : r.y + r.h + 2;
      ctx.globalAlpha = Math.min(1, age / 6);
      ctx.strokeStyle = rgba(th.danger, 0.6); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(clamp(ax, x, x + w), y + h / 2); ctx.lineTo(ax, ay); ctx.stroke();
      ctx.fillStyle = 'rgba(3,5,10,0.85)'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = th.danger; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.fillStyle = th.danger; ctx.fillRect(x, y, 2, h);
      ctx.fillStyle = th.scan;
      ctx.fillText(text.slice(0, n) + (n < text.length && (age & 2) ? '_' : ''), x + 6, y + h / 2 + 0.5);
    }
    ctx.restore();
  }

  /** Make a tagged hidden trap clearly visible. */
  drawGhost(ctx, t, run, f, pt) {
    const th = this.th, pulse = 0.6 + 0.4 * Math.sin(f * 0.15);
    switch (t.type) {
      case 'crumble': {
        if (t.state !== 'idle') return;
        const reg = this.regions.get(t.id);
        if (!reg) return;
        const w = (reg.x1 - reg.x0 + 1) * T;
        if (reg.yMax > reg.y0) {   // x-ray: the "ground" below is a hologram over a pit
          ctx.fillStyle = 'rgba(2,4,8,0.62)';
          ctx.fillRect(reg.x0 * T, (reg.y0 + 1) * T, w, (reg.yMax - reg.y0) * T);
          ctx.strokeStyle = rgba(th.danger, 0.4 * pulse); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
          ctx.strokeRect(reg.x0 * T + 0.5, (reg.y0 + 1) * T, w - 1, (reg.yMax - reg.y0) * T);
          ctx.setLineDash([]);
        }
        ctx.globalAlpha = 0.5 + 0.4 * pulse;
        ctx.fillStyle = pt.hatch ?? rgba(th.danger, 0.3);
        ctx.fillRect(t.rect.x, t.rect.y, t.rect.w, t.rect.h);
        ctx.globalAlpha = 1;
        return;
      }
      case 'drop': {
        if (t.state !== 'idle') return;
        ctx.globalAlpha = 0.5 + 0.4 * pulse;
        ctx.fillStyle = pt.hatch ?? rgba(th.danger, 0.3);
        ctx.fillRect(t.rect.x, t.rect.y, t.rect.w, t.rect.h);
        ctx.strokeStyle = th.danger; ctx.lineWidth = 1.5;
        const cx = t.rect.x + t.rect.w / 2, y = t.rect.y + t.rect.h + 4;
        arrow(ctx, cx, y, cx, y + 16 + pulse * 4);
        ctx.globalAlpha = 1;
        return;
      }
      case 'spikes':
        if (t.pop > 0.05) return;
        spikePath(ctx, t.rect.x, t.rect.y, t.rect.w, t.rect.h, t.dir, 1);
        ctx.globalAlpha = 0.45 + 0.45 * pulse;
        ctx.fillStyle = rgba(th.danger, 0.15); ctx.fill();
        ctx.strokeStyle = th.danger; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        return;
      case 'sled': {
        if (t.state !== 'idle') return;
        const r = t.rect, dir = Math.sign(t.def.vx ?? -1);
        spikePath(ctx, r.x, r.y, r.w, r.h, t.dir, 1);
        ctx.globalAlpha = 0.4 + 0.4 * pulse;
        ctx.strokeStyle = th.danger; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]);
        const y = r.y + r.h / 2, xs = dir < 0 ? r.x : r.x + r.w;
        ctx.lineWidth = 1.5;
        arrow(ctx, xs, y, xs + dir * Math.min(t.maxDist, 3 * T), y, 6);
        ctx.globalAlpha = 1;
        return;
      }
      case 'mine': {
        if (t.state !== 'idle') return;
        const r = t.rect, cx = r.x + r.w / 2, by = r.y + r.h;
        ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.strokeStyle = th.danger; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.ellipse(cx, by - 2, r.w * 0.36, 5, 0, Math.PI, 0); ctx.closePath(); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = th.danger; ctx.fillRect(cx - 1.5, by - 8, 3, 2);
        ctx.globalAlpha = 1;
        return;
      }
      case 'tripwire': {
        if (t.state !== 'idle') return;
        const r = t.rect, x = r.x + r.w / 2;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.strokeStyle = th.danger; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
        drawGlow(ctx, th.danger, x, r.y + r.h / 2, 10, 0.6 * pulse, r.h * 0.7);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = th.danger; ctx.fillRect(x - 1.5, r.y - 1.5, 3, 3);
        return;
      }
      case 'drone': {
        if (t.state !== 'idle') return;
        const cx = t.pos.x + DRONE_W / 2, cy = t.pos.y + DRONE_H / 2;
        ctx.globalAlpha = 0.45 + 0.45 * pulse;
        ctx.strokeStyle = th.danger; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(cx - 8, cy - 3); ctx.lineTo(cx + 8, cy - 3); ctx.lineTo(cx + 10, cy + 1); ctx.lineTo(cx + 6, cy + 6); ctx.lineTo(cx - 6, cy + 6); ctx.lineTo(cx - 10, cy + 1); ctx.closePath(); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = th.danger; ctx.beginPath(); ctx.arc(cx, cy + 1.5, 2, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
        return;
      }
      case 'lockdown': {
        if (t.state !== 'idle') return;
        const p = t.pos;
        ctx.globalAlpha = 0.4 + 0.4 * pulse;
        ctx.strokeStyle = th.danger; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
        ctx.setLineDash([]);
        ctx.lineWidth = 2;
        const y = p.y + p.h / 2;
        arrow(ctx, p.x + p.w + 4, y, p.x + p.w + 4 + 3 * T, y, 7);
        ctx.globalAlpha = 1;
        return;
      }
      case 'fakeKey': {
        if (t.state === 'active') return;
        const r = t.rect;
        ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.strokeStyle = th.danger; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(r.x - 2, r.y - 2); ctx.lineTo(r.x + r.w + 2, r.y + r.h + 2); ctx.moveTo(r.x + r.w + 2, r.y - 2); ctx.lineTo(r.x - 2, r.y + r.h + 2); ctx.stroke();
        ctx.globalAlpha = 1;
        return;
      }
      case 'fakeDoor': {
        const r = t.rect;
        ctx.fillStyle = rgba(th.danger, 0.18 + 0.12 * pulse);
        ctx.fillRect(r.x - 6, r.y - 7, r.w + 12, r.h + 7);
        ctx.strokeStyle = th.danger; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(r.x, r.y); ctx.lineTo(r.x + r.w, r.y + r.h); ctx.moveTo(r.x + r.w, r.y); ctx.lineTo(r.x, r.y + r.h); ctx.stroke();
        return;
      }
      case 'runDoor': {
        if (t.state !== 'idle') return;
        const d = run.door;
        ctx.strokeStyle = th.good; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.5 + 0.4 * pulse;
        ctx.setLineDash([3, 4]); ctx.lineDashOffset = -f * 0.5;
        let px = d.x + d.w / 2, py = d.y + d.h / 2;
        for (const w of [].concat(t.def.to ?? [])) {
          const q = doorRectAt(w.x, w.y), qx = q.x + q.w / 2, qy = q.y + q.h / 2;
          arrow(ctx, px, py, qx, qy, 6);
          ctx.strokeRect(q.x + 0.5, q.y + 0.5, q.w - 1, q.h - 1);
          px = qx; py = qy;
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        return;
      }
    }
  }

  // ------------------------------------------------------------------ debug
  drawZones(ctx, run) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = `9px ${FONT}`;
    ctx.textAlign = 'left';
    for (const t of run.traps) {
      const r = t.pos ?? t.body ?? t.rect;
      ctx.setLineDash([]);
      ctx.strokeStyle = t.state === 'active' ? '#ff4f4f' : t.state === 'pending' ? '#ffd84a' : '#9aa7bd';
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      if (t.hz?.cone) {
        const tri = coneTriangle(t.hz.cone);
        ctx.beginPath(); ctx.moveTo(tri[0][0], tri[0][1]); ctx.lineTo(tri[1][0], tri[1][1]); ctx.lineTo(tri[2][0], tri[2][1]); ctx.closePath(); ctx.stroke();
      }
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(`${t.id} ${t.type} ${t.state}${t.def.hidden ? ' [H]' : ''}`, r.x + 2, Math.max(10, r.y - 3));
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#6ee7a0'; ctx.fillStyle = '#6ee7a0';
      for (const tr of t.triggers) {
        if (tr.rect) { ctx.strokeRect(tr.rect.x + 0.5, tr.rect.y + 0.5, tr.rect.w - 1, tr.rect.h - 1); ctx.fillText(`${t.id}:${tr.on}`, tr.rect.x + 2, tr.rect.y + 10); }
        if (tr.on === 'x') {
          const xx = (tr.gte ?? tr.lte) * T;
          ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, this.rows * T); ctx.stroke();
          ctx.fillText(`${t.id}:x`, xx + 2, 20);
        }
      }
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,0,255,0.7)';
    for (const h of run.level.hazards) if (h.enabled && !h.cone) ctx.strokeRect(h.x, h.y, h.w, h.h);
    ctx.restore();
  }

  // ------------------------------------------------------------------ screen-space effects
  flash(col, a) { this.flashAt = this.now; this.flashCol = col; this.flashA = a; }

  drawScreenFx(ctx, f) {
    const th = this.th;
    const fe = f - this.flashAt;
    if (fe >= 0 && fe < 10) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = this.flashA * (1 - fe / 10);
      ctx.fillStyle = this.flashCol;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.restore();
    }
    const ae = f - this.alarmAt;
    if (ae >= 0 && ae < 66) {
      const a = (1 - ae / 66) * (0.5 + 0.5 * Math.sin(ae * 0.42));
      if (!this.rim) {
        this.rim = mkCanvas(240, 136);
        const g = this.rim.getContext('2d');
        const gr = g.createRadialGradient(120, 68, 40, 120, 68, 150);
        gr.addColorStop(0, 'rgba(255,46,77,0)'); gr.addColorStop(0.6, 'rgba(255,46,77,0.08)'); gr.addColorStop(1, 'rgba(255,46,77,0.75)');
        g.fillStyle = gr; g.fillRect(0, 0, 240, 136);
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * 0.9;
      ctx.drawImage(this.rim, 0, 0, VIEW_W, VIEW_H);
      ctx.globalAlpha = a * 0.6;
      ctx.fillStyle = th.danger;
      ctx.fillRect(0, 0, VIEW_W, 2); ctx.fillRect(0, VIEW_H - 2, VIEW_W, 2);
      ctx.restore();
    }
  }

  /** New trap matrix materialising: scan line sweeps left -> right. */
  drawRebuild(ctx, run, view, dev, p, f, P) {
    const th = this.th;
    const sx = lerp(-40, VIEW_W + 40, ease(clamp(p, 0, 1)));
    ctx.save();
    // not yet materialised: dark void with a flickering wireframe of the new geometry
    if (sx < VIEW_W) {
      ctx.fillStyle = rgba(th.bg0, 0.94);
      ctx.fillRect(Math.max(0, sx), 0, VIEW_W - Math.max(0, sx), VIEW_H);
      ctx.save();
      ctx.beginPath(); ctx.rect(Math.max(0, sx), 0, VIEW_W, VIEW_H); ctx.clip();
      ctx.translate(-view.x, -view.y);
      ctx.strokeStyle = rgba(th.accent, 0.12 + 0.1 * Math.random()); ctx.lineWidth = 1;
      ctx.beginPath();
      const tx0 = Math.max(0, Math.floor((view.x + sx) / T) - 1), tx1 = Math.min(this.cols - 1, Math.ceil((view.x + VIEW_W) / T));
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let ty = 0; ty < this.rows; ty++) {
          if (this.visAt(tx, ty) === 0) continue;
          const x = tx * T, y = ty * T;
          if (!this.visAt(tx, ty - 1)) { ctx.moveTo(x, y + 0.5); ctx.lineTo(x + T, y + 0.5); }
          if (!this.visAt(tx - 1, ty)) { ctx.moveTo(x + 0.5, y); ctx.lineTo(x + 0.5, y + T); }
          if (!this.visAt(tx + 1, ty)) { ctx.moveTo(x + T - 0.5, y); ctx.lineTo(x + T - 0.5, y + T); }
          if (!this.visAt(tx, ty + 1)) { ctx.moveTo(x, y + T - 0.5); ctx.lineTo(x + T, y + T - 0.5); }
          if (((tx + ty) & 3) === 0) { ctx.moveTo(x, y); ctx.lineTo(x + T, y + T); }
        }
      }
      ctx.stroke();
      ctx.restore();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 26; i++) {
        const nx = sx + Math.random() * (VIEW_W - sx), ny = Math.random() * VIEW_H;
        ctx.globalAlpha = Math.random() * 0.25;
        ctx.fillStyle = Math.random() < 0.8 ? th.accent : th.danger;
        ctx.fillRect(nx, ny, 3 + Math.random() * 40, 1 + Math.random() * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    // freshly materialised band glows
    this.drawChunks(ctx, view, dev, Math.max(0, sx - 70), Math.max(0, sx), 0.4, 'lighter');
    // the scan line
    ctx.globalCompositeOperation = 'lighter';
    const gr = ctx.createLinearGradient(sx - 80, 0, sx, 0);
    gr.addColorStop(0, rgba(th.accent, 0)); gr.addColorStop(1, rgba(th.accent, 0.2));
    ctx.fillStyle = gr; ctx.fillRect(sx - 80, 0, 80, VIEW_H);
    ctx.fillStyle = rgba(th.accent, 0.35); ctx.fillRect(sx - 4, 0, 8, VIEW_H);
    ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.9; ctx.fillRect(sx - 1, 0, 2, VIEW_H);
    ctx.globalAlpha = 1;
    ctx.fillStyle = th.accent;
    ctx.beginPath(); ctx.moveTo(sx - 6, 0); ctx.lineTo(sx + 6, 0); ctx.lineTo(sx, 8); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(sx - 6, VIEW_H); ctx.lineTo(sx + 6, VIEW_H); ctx.lineTo(sx, VIEW_H - 8); ctx.closePath(); ctx.fill();
    ctx.restore();
    if (f !== this.lastRebuildFx) {
      this.lastRebuildFx = f;
      for (let i = 0; i < 5; i++) P.glyphs(view.x + sx + (Math.random() - 0.5) * 6, view.y + Math.random() * VIEW_H, Math.random() < 0.75 ? th.accent : th.scan, 1, 4);
      const s = this.spawn;
      if (s && Math.abs(view.x + sx - (s.tx * T + T / 2)) < 12) {
        P.ring(s.tx * T + T / 2, (s.ty + 1) * T - 13, th.accent, 4, 40, 22, 2);
        P.glyphs(s.tx * T + T / 2, (s.ty + 1) * T - 13, th.accent, 8, 20);
      }
    }
  }

  // ------------------------------------------------------------------ events
  onEvent(e, run, P, cam) {
    const th = this.th, p = run.player;
    const feetY = p ? (p.gdir > 0 ? p.y + p.h : p.y) : 0;
    switch (e.type) {
      case 'jump':
        P.dust(p.cx, feetY, 5, undefined, p.gdir);
        break;
      case 'land': {
        const vy = this.trail.length ? Math.abs(this.trail[this.trail.length - 1].vy) : 6;
        const imp = clamp(vy / 12, 0.2, 1);
        this.pose.squash = 0.1 + 0.22 * imp;
        P.dust(p.cx, feetY, 3 + Math.round(imp * 6), undefined, p.gdir);
        break;
      }
      case 'key': {
        const k = run.keys[e.id];
        if (!k) break;
        const cx = k.x + k.w / 2, cy = k.y + k.h / 2;
        P.burst(cx, cy, th.key, 22, 4.5);
        P.ring(cx, cy, th.key, 4, 46, 24, 2.5);
        P.glyphs(cx, cy, th.key, 6, 18);
        this.flash(th.key, 0.06);
        break;
      }
      case 'fakeKey': {
        const t = run.traps.find(t => t.type === 'fakeKey' && t.state === 'active' && t.activeAt === run.frame)
          ?? run.traps.find(t => t.type === 'fakeKey' && t.state === 'active');
        const cx = t ? t.rect.x + t.rect.w / 2 : p.cx, cy = t ? t.rect.y + t.rect.h / 2 : p.cy;
        P.shards(cx, cy, [th.key, th.danger, th.danger], 14, 4);
        P.ring(cx, cy, th.danger, 4, 36, 18, 2);
        P.glyphs(cx, cy, th.danger, 6, 16);
        cam.shake += 3;
        this.flash(th.danger, 0.1);
        break;
      }
      case 'trap': this.trapFx(e, run, P, cam); break;
      case 'nearMiss':
        P.sparks(p.cx, p.cy, th.accent, 8, 3.5, 0, TAU);
        P.ring(p.cx, p.cy, th.accent, 6, 28, 14, 1.5);
        break;
      case 'door': {
        const d = run.door, cx = d.x + d.w / 2, cy = d.y + d.h / 2;
        P.burst(cx, cy, th.good, 34, 5);
        P.ring(cx, cy, th.good, 6, 70, 30, 3);
        P.embers(cx, d.y + d.h, '#eafff5', 14, d.w);
        this.flash(th.good, 0.16);
        break;
      }
      case 'win':
        this.winAt = this.now;
        break;
      case 'death': {
        const x = e.x ?? p.cx, y = e.y ?? p.cy;
        P.shards(x, y, [SUIT, th.accent, th.danger, SUIT, th.accent], 26, 6.5);
        P.burst(x, y, th.danger, 18, 5);
        P.sparks(x, y, th.accent, 10, 6, 0, TAU);
        P.ring(x, y, th.danger, 6, 70, 26, 3);
        P.ring(x, y, th.accent, 2, 40, 18, 1.5);
        P.glyphs(x, y, th.accent, 8, 24);
        cam.shake += 10;
        this.flash(th.danger, 0.22);
        break;
      }
      case 'scan':
        P.ring(e.x, e.y, th.scan, 4, 36, 16, 2);
        P.glyphs(e.x, e.y, th.scan, 5, 20);
        break;
      case 'tag': {
        const t = run.trapById?.[e.id];
        if (!t) break;
        const r = this.tagRect(t, run);
        const cx = r.x + r.w / 2, cy = r.y + Math.min(r.h, 64) / 2;
        P.ring(cx, cy, e.hidden ? th.danger : th.scan, 2, 22, 16, 1.5);
        P.sparks(cx, cy, th.scan, e.hidden ? 8 : 4, 2.5, 0, TAU);
        break;
      }
      case 'boom': {
        const x = e.x, y = e.y, harmless = !!e.harmless;
        const big = harmless ? 0.6 : 1;
        P.ring(x, y, '#ffffff', 4, 90 * big, 18, 4);
        P.ring(x, y, th.warn, 6, 60 * big, 26, 3);
        P.sparks(x, y, th.warn, Math.round(22 * big), 8 * big, -Math.PI / 2, Math.PI * 1.6);
        P.debris(x, y, '#1d2433', Math.round(12 * big), 6 * big);
        P.embers(x, y - 8, th.warn, Math.round(16 * big), 26);
        P.smoke(x, y - 10, Math.round(8 * big));
        P.burst(x, y, th.danger, Math.round(12 * big), 4);
        cam.shake += harmless ? 5 : 13;
        this.flash(harmless ? th.warn : '#ffffff', harmless ? 0.12 : 0.3);
        if (!harmless) this.decals.push({ x, y, t0: this.now });
        break;
      }
      case 'alarm':
        this.alarmAt = this.now;
        break;
      case 'slam': {
        const s = e.soft;
        P.dust(e.x, e.y, s ? 8 : 16);
        P.debris(e.x, e.y - 2, '#22314a', s ? 3 : 8, s ? 3 : 5);
        if (!s) P.ring(e.x, e.y, th.accent, 6, 50, 18, 2);
        cam.shake += s ? 2.5 : 7;
        break;
      }
    }
  }

  trapFx(e, run, P, cam) {
    const th = this.th, t = run.trapById?.[e.id];
    if (!t) return;
    const r = t.pos ?? t.rect;
    switch (t.type) {
      case 'crumble':
        P.glyphs(r.x + r.w / 2, r.y + 4, th.accent, 8, r.w);
        P.dust(r.x + r.w / 2, r.y + T, 6, undefined, -1);
        break;
      case 'spikes':
        for (let x = r.x + 6; x < r.x + r.w; x += 12) P.sparks(x, r.y + r.h - 4, th.danger, 2, 4);
        break;
      case 'sled':
        P.dust(r.x + r.w / 2, r.y + r.h, 10);
        P.sparks(r.x + r.w / 2, r.y + r.h - 4, th.warn, 10, 5);
        cam.shake += 2;
        break;
      case 'drop':
        P.debris(r.x + r.w / 2, r.y + r.h, '#22314a', 8, 2);
        P.glyphs(r.x + r.w / 2, r.y + r.h, th.danger, 4, r.w);
        break;
      case 'drone':
        P.ring(r.x + r.w / 2, r.y + r.h / 2, th.danger, 4, 40, 20, 2);
        P.glyphs(r.x + r.w / 2, r.y + r.h / 2, th.danger, 5, 20);
        break;
      case 'lockdown':
        P.dust(r.x + r.w, r.y + r.h, 16);
        P.sparks(r.x + r.w, r.y + r.h, th.warn, 14, 6);
        cam.shake += 6;
        this.flash(th.danger, 0.12);
        break;
      case 'runDoor': {
        const d = run.door;
        P.glyphs(d.x + d.w / 2, d.y + d.h / 2, th.good, 8, 20);
        P.ring(d.x + d.w / 2, d.y + d.h / 2, th.good, 4, 34, 18, 2);
        break;
      }
      case 'tripwire':
        P.sparks(r.x + r.w / 2, r.y + r.h / 2, th.danger, 8, 3, 0, TAU);
        break;
    }
  }

  // ------------------------------------------------------------------ briefing thumbnail
  /** "Satellite intel scan" of the whole level (hidden traps are NOT shown). */
  drawThumbnail(ctx, run, x, y, w, h, t = 0) {
    const th = themeFor(run.def.mission ?? 1);
    const dev = (ctx.canvas && ctx.canvas.width ? ctx.canvas.width : VIEW_W) / VIEW_W;
    const cw = Math.max(16, Math.min(2048, Math.round(w * dev))), ch = Math.max(16, Math.min(2048, Math.round(h * dev)));
    if (!this.thumb || this.thumb.def !== run.def || this.thumb.cw !== cw || this.thumb.ch !== ch) {
      this.thumb = this.buildThumb(run, th, cw, ch);
    }
    const tb = this.thumb, kx = w / cw, ky = h / ch;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.drawImage(tb.c, x, y, w, h);
    // moving scan line that lights up the terrain it passes
    const sx = ((t * 2.4) % (w + 80)) - 40;
    ctx.globalCompositeOperation = 'lighter';
    const band = 46;
    const a0 = Math.max(0, sx - band), a1 = Math.min(w, sx);
    if (a1 > a0) {
      ctx.globalAlpha = 0.7;
      ctx.drawImage(tb.c, a0 / kx, 0, (a1 - a0) / kx, ch, x + a0, y, a1 - a0, h);
      const gr = ctx.createLinearGradient(x + sx - band, 0, x + sx, 0);
      gr.addColorStop(0, rgba(th.scan, 0)); gr.addColorStop(1, rgba(th.scan, 0.22));
      ctx.globalAlpha = 1;
      ctx.fillStyle = gr; ctx.fillRect(x + sx - band, y, band, h);
    }
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = th.scan; ctx.fillRect(x + sx - 0.75, y, 1.5, h);
    // blips
    for (const b of tb.blips) {
      const bx = x + b.x * kx, by = y + b.y * ky;
      const k = ((t + b.ph) % 60) / 60;
      ctx.globalAlpha = 0.8 * (1 - k);
      ctx.strokeStyle = b.col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(bx, by, 2 + k * 9, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = b.col; ctx.fillRect(bx - 1.5, by - 1.5, 3, 3);
    }
    ctx.globalCompositeOperation = 'source-over';
    // frame + readouts
    ctx.globalAlpha = 1;
    ctx.strokeStyle = rgba(th.accent, 0.8); ctx.lineWidth = 1.5;
    const L = 10;
    ctx.beginPath();
    ctx.moveTo(x + 1, y + L); ctx.lineTo(x + 1, y + 1); ctx.lineTo(x + L, y + 1);
    ctx.moveTo(x + w - L, y + 1); ctx.lineTo(x + w - 1, y + 1); ctx.lineTo(x + w - 1, y + L);
    ctx.moveTo(x + 1, y + h - L); ctx.lineTo(x + 1, y + h - 1); ctx.lineTo(x + L, y + h - 1);
    ctx.moveTo(x + w - L, y + h - 1); ctx.lineTo(x + w - 1, y + h - 1); ctx.lineTo(x + w - 1, y + h - L);
    ctx.stroke();
    ctx.font = `7px ${FONT}`; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = rgba(th.accent, 0.75);
    ctx.textAlign = 'left';
    ctx.fillText(`SAT-INTEL // ${run.def.city ?? 'SECTOR'} ${(t >> 4) & 1 ? '●' : ' '}`, x + 5, y + 9);
    ctx.textAlign = 'right';
    const def = run.def;
    if (def.lat !== undefined) ctx.fillText(`${Math.abs(def.lat).toFixed(2)}${def.lat >= 0 ? 'N' : 'S'} ${Math.abs(def.lon).toFixed(2)}${def.lon >= 0 ? 'E' : 'W'}`, x + w - 5, y + h - 4);
    ctx.restore();
  }

  buildThumb(run, th, cw, ch) {
    const c = mkCanvas(cw, ch), g = c.getContext('2d');
    const { vis } = buildVis(run);
    const cols = run.level.cols, rows = run.level.rows, lw = cols * T, lh = rows * T;
    const u = ch / 136;   // unit relative to a typical thumbnail height
    g.fillStyle = '#02060c'; g.fillRect(0, 0, cw, ch);
    let gr = g.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, Math.max(cw, ch) * 0.7);
    gr.addColorStop(0, rgba(th.accent2, 0.12)); gr.addColorStop(1, rgba(th.accent2, 0));
    g.fillStyle = gr; g.fillRect(0, 0, cw, ch);
    // grid
    const step = Math.max(6, Math.round(14 * u));
    g.strokeStyle = rgba(th.accent, 0.07); g.lineWidth = 1;
    g.beginPath();
    for (let gx = 0.5; gx < cw; gx += step) { g.moveTo(gx, 0); g.lineTo(gx, ch); }
    for (let gy = 0.5; gy < ch; gy += step) { g.moveTo(0, gy); g.lineTo(cw, gy); }
    g.stroke();
    // wrap the level into k stacked bands to use the space
    const m = Math.round(8 * u), gap = Math.round(9 * u), top = Math.round(12 * u);
    const aw = cw - 2 * m, ah = ch - top - m;
    let best = { k: 1, s: 0 };
    for (let k = 1; k <= 6; k++) {
      const s = Math.min(aw / (lw / k), (ah - gap * (k - 1)) / (k * lh));
      if (s > best.s) best = { k, s };
    }
    const { k: K, s } = best;
    const segW = Math.ceil(cols / K);
    const bandH = lh * s, totalH = K * bandH + (K - 1) * gap;
    const oy0 = top + (ah - totalH) / 2, ox = m + (aw - segW * T * s) / 2;
    const map = (wx, wy) => {
      const b = Math.min(K - 1, Math.floor(wx / (segW * T)));
      return [ox + (wx - b * segW * T) * s, oy0 + b * (bandH + gap) + wy * s];
    };
    const cs = T * s;
    for (let b = 0; b < K; b++) {
      const by = oy0 + b * (bandH + gap);
      g.strokeStyle = rgba(th.accent, 0.18); g.lineWidth = 1;
      g.strokeRect(ox - 1.5, by - 1.5, segW * cs + 3, bandH + 3);
      g.fillStyle = rgba(th.accent, 0.55);
      g.font = `${Math.max(6, Math.round(6 * u))}px ${FONT}`;
      g.fillText(`S${b + 1}`, ox - 1.5, by - 3);
    }
    const cell = (tx, ty, col) => {
      const [px, py] = map(tx * T, ty * T);
      g.fillStyle = col; g.fillRect(px, py, cs + 0.35, cs + 0.35);
    };
    for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
      const v = vis[ty * cols + tx];
      if (v) cell(tx, ty, rgba(th.accent, 0.28));
      const sd = SPIKE_DIR[run.level.grid[ty * cols + tx]];
      if (sd) cell(tx, ty, rgba(th.danger, 0.85));
    }
    g.fillStyle = th.accent;
    for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
      if (!vis[ty * cols + tx] || (ty > 0 && vis[(ty - 1) * cols + tx])) continue;
      if (ty === 0) continue;
      const [px, py] = map(tx * T, ty * T);
      g.fillRect(px, py, cs + 0.35, Math.max(1, cs * 0.18));
    }
    // visible threats only
    const blips = [];
    const R = (r, col) => { const [px, py] = map(r.x, r.y); g.fillStyle = col; g.fillRect(px, py, Math.max(1, r.w * s), Math.max(1, r.h * s)); };
    for (const t of run.traps) {
      const d = t.def;
      switch (t.type) {
        case 'laser':
          if (d.mode === 'sweep') { const [px, py] = map(t.rect.x, t.rect.y); g.strokeStyle = rgba(th.danger, 0.8); g.lineWidth = 1; g.strokeRect(px, py, t.rect.w * s, t.rect.h * s); }
          else R({ x: t.rect.x + t.rect.w / 2 - 1 / s, y: t.rect.y, w: 2 / s, h: t.rect.h }, rgba(th.danger, 0.9));
          break;
        case 'camera': {
          const tri = coneTriangle({ ...t.hz.cone, ang: 0, half: d.amp + d.half });
          const p0 = map(tri[0][0], tri[0][1]), p1 = map(tri[1][0], tri[1][1]), p2 = map(tri[2][0], tri[2][1]);
          g.fillStyle = rgba(th.danger, 0.22);
          g.beginPath(); g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.closePath(); g.fill();
          g.fillStyle = th.danger; g.fillRect(p0[0] - 1.5, p0[1] - 1.5, 3, 3);
          break;
        }
        case 'press': R({ x: t.rect.x, y: t.rect.y, w: t.rect.w, h: t.upB - t.rect.y }, rgba(th.warn, 0.55)); break;
        case 'spikes': if (!d.hidden || d.cycle) R(t.rect, rgba(th.danger, 0.7)); break;
        case 'mine': if (!d.hidden) R(t.rect, th.danger); break;
        case 'lift': R(t.body, th.accent2); break;
        case 'gravity': if (d.visible) R(t.rect, rgba(GRAV, 0.2)); break;
        case 'emp': if (d.visible) R(t.rect, rgba(EMPC, 0.2)); break;
        case 'fakeKey': { const [px, py] = map(t.rect.x + t.rect.w / 2, t.rect.y + t.rect.h / 2); blips.push({ x: px, y: py, col: th.key, ph: blips.length * 13 }); break; }
        case 'fakeDoor': { const [px, py] = map(t.rect.x + t.rect.w / 2, t.rect.y + t.rect.h / 2); blips.push({ x: px, y: py, col: th.good, ph: 7 }); break; }
      }
    }
    for (const k of run.keys) { const [px, py] = map(k.x + k.w / 2, k.y + k.h / 2); blips.push({ x: px, y: py, col: th.key, ph: blips.length * 13 }); }
    { const d = run.door, [px, py] = map(d.x + d.w / 2, d.y + d.h / 2); blips.push({ x: px, y: py, col: th.good, ph: 0 }); }
    const sp = run.parsed.spawns[0];
    if (sp) { const [px, py] = map(sp.tx * T + T / 2, (sp.ty + 1) * T - 13); blips.push({ x: px, y: py, col: th.accent, ph: 30 }); }
    // scanlines baked in
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let yy = 0; yy < ch; yy += 3) g.fillRect(0, yy, cw, 1);
    return { c, def: run.def, cw, ch, blips };
  }
}
