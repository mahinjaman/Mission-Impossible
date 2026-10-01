// Tile map parsing + runtime collision world.
//
// A level definition (produced by gen.js) describes tiles with `map`: an
// array of strings, one char per tile:
//   '#' solid, '^' 'v' '<' '>' spikes (pointing up/down/left/right), '.' empty,
//   'P' spawn, 'K' keycard, 'D' extraction door.

import { TILE, EPS, overlaps } from './physics.js';

export const LEVEL_ROWS = 17;

export const T_EMPTY = 0, T_SOLID = 1,
  T_SPIKE_UP = 2, T_SPIKE_DOWN = 3, T_SPIKE_LEFT = 4, T_SPIKE_RIGHT = 5;

const CHAR_TILE = { '#': T_SOLID, '^': T_SPIKE_UP, 'v': T_SPIKE_DOWN, '<': T_SPIKE_LEFT, '>': T_SPIKE_RIGHT, '.': T_EMPTY };
export const SPIKE_DIR = { [T_SPIKE_UP]: 'up', [T_SPIKE_DOWN]: 'down', [T_SPIKE_LEFT]: 'left', [T_SPIKE_RIGHT]: 'right' };

/** Deadly part of a spike strip occupying `r`, pointing `dir`. Slightly forgiving at the tips. */
export function spikeBox(dir, r) {
  const d = 18, m = 3;
  switch (dir) {
    case 'down': return { x: r.x + m, y: r.y, w: r.w - 2 * m, h: d };
    case 'left': return { x: r.x + r.w - d, y: r.y + m, w: d, h: r.h - 2 * m };
    case 'right': return { x: r.x, y: r.y + m, w: d, h: r.h - 2 * m };
    default: return { x: r.x + m, y: r.y + r.h - d, w: r.w - 2 * m, h: d };
  }
}

const parsedCache = new WeakMap();

/** Parse a level definition into a static grid + spawn/key/door positions (cached). */
export function parseLevel(def) {
  if (parsedCache.has(def)) return parsedCache.get(def);
  const rows = def.map.length;
  const cols = Math.max(...def.map.map(s => s.length));
  const grid = new Uint8Array(cols * rows);
  const out = { cols, rows, grid, spawns: [], keys: [], door: null };
  def.map.forEach((line, y) => [...line].forEach((ch, x) => {
    if (ch in CHAR_TILE) grid[y * cols + x] = CHAR_TILE[ch];
    else if (ch === 'P') out.spawns[0] = { tx: x, ty: y };
    else if (ch === 'K') out.keys.push({ tx: x, ty: y });
    else if (ch === 'D') out.door = { tx: x, ty: y };
  }));
  if (!out.spawns[0]) throw new Error(`Level ${def.id}: missing player spawn 'P'`);
  if (!out.door) throw new Error(`Level ${def.id}: missing door 'D'`);
  parsedCache.set(def, out);
  return out;
}

// ---------------------------------------------------------------------------
// Cone hazards (sentry cameras): triangle vs rectangle, separating axis test.
// cone = { ax, ay, ang, half, len }  apex in px, ang = radians from straight
// down (positive swings right), half = half opening angle.
// ---------------------------------------------------------------------------
export function coneTriangle(c) {
  const a1 = c.ang - c.half, a2 = c.ang + c.half;
  return [
    [c.ax, c.ay],
    [c.ax + Math.sin(a1) * c.len, c.ay + Math.cos(a1) * c.len],
    [c.ax + Math.sin(a2) * c.len, c.ay + Math.cos(a2) * c.len],
  ];
}

export function triHitsRect(tri, r) {
  const rx0 = r.x, rx1 = r.x + r.w, ry0 = r.y, ry1 = r.y + r.h;
  // rect axes
  if (Math.max(tri[0][0], tri[1][0], tri[2][0]) <= rx0 || Math.min(tri[0][0], tri[1][0], tri[2][0]) >= rx1) return false;
  if (Math.max(tri[0][1], tri[1][1], tri[2][1]) <= ry0 || Math.min(tri[0][1], tri[1][1], tri[2][1]) >= ry1) return false;
  // triangle edge normals
  const corners = [[rx0, ry0], [rx1, ry0], [rx0, ry1], [rx1, ry1]];
  for (let i = 0; i < 3; i++) {
    const p = tri[i], q = tri[(i + 1) % 3], o = tri[(i + 2) % 3];
    const nx = q[1] - p[1], ny = p[0] - q[0];
    const side = Math.sign((o[0] - p[0]) * nx + (o[1] - p[1]) * ny);
    if (corners.every(([x, y]) => ((x - p[0]) * nx + (y - p[1]) * ny) * side <= 0)) return false;
  }
  return true;
}

/** Runtime collision world for one attempt. Traps register extra bodies/hazards. */
export class Level {
  constructor(parsed) {
    this.cols = parsed.cols;
    this.rows = parsed.rows;
    this.grid = parsed.grid;   // static: never written at runtime, shared by clones
    this.bodies = [];   // dynamic solids {x,y,w,h,enabled,owner}
    this.hazards = [];  // dynamic hazards {x,y,w,h,enabled,owner,cause,cone?}
  }

  get width() { return this.cols * TILE; }
  get height() { return this.rows * TILE; }

  tileAt(tx, ty) {
    if (tx < 0 || tx >= this.cols) return T_SOLID;   // side walls
    if (ty < 0 || ty >= this.rows) return T_EMPTY;   // open top/bottom
    return this.grid[ty * this.cols + tx];
  }

  static isSolid(t) { return t === T_SOLID; }

  addBody(owner, r) {
    const b = { x: r.x, y: r.y, w: r.w, h: r.h, enabled: true, owner };
    this.bodies.push(b);
    return b;
  }

  addHazard(owner, r, cause = 'trap') {
    const h = { x: r.x, y: r.y, w: r.w, h: r.h, enabled: true, owner, cause };
    this.hazards.push(h);
    return h;
  }

  tileRange(r) {
    return [
      Math.floor((r.x + EPS) / TILE), Math.ceil((r.x + r.w - EPS) / TILE) - 1,
      Math.floor((r.y + EPS) / TILE), Math.ceil((r.y + r.h - EPS) / TILE) - 1,
    ];
  }

  /** All solid rects overlapping r (tiles + enabled bodies except `ignore`). */
  solidsIn(r, ignore = null) {
    const out = [];
    const [x0, x1, y0, y1] = this.tileRange(r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (Level.isSolid(this.tileAt(tx, ty))) out.push({ x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
      }
    }
    for (const b of this.bodies) if (b.enabled && b !== ignore && overlaps(r, b)) out.push(b);
    return out;
  }

  /** Returns the cause string of the first hazard overlapping r, or null. */
  hazardAt(r) {
    const [x0, x1, y0, y1] = this.tileRange(r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const dir = SPIKE_DIR[this.tileAt(tx, ty)];
        if (dir && overlaps(r, spikeBox(dir, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE }))) return 'spikes';
      }
    }
    for (const h of this.hazards) {
      if (!h.enabled) continue;
      if (h.cone) { if (triHitsRect(coneTriangle(h.cone), r)) return h.cause; continue; }
      if (overlaps(r, h)) return h.cause;
    }
    return null;
  }
}
