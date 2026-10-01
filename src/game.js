// LevelRun: the pure, deterministic simulation of ONE attempt at one
// generated level. No DOM, no randomness, no wall-clock time.
//
// Dying ends the attempt for good: the app then generates a brand-new trap
// matrix (gen.js) and starts a fresh LevelRun on it. The headless solver
// (solver.js) drives the same class through clone() to prove levels beatable.

import { TILE, overlaps } from './physics.js';
import { parseLevel, Level } from './level.js';
import { Player, IN_SCAN } from './player.js';
import { createTraps, trapsPre, trapsPost, applyZones, doorRectAt, keyRectAt, trapDistance } from './traps.js';

// Runtime trap fields that never change after createTraps(): clones share them.
const SHARED_KEYS = new Set(['triggers', 'path']);

/**
 * Deep copy of plain runtime data (objects, arrays, primitives). `memo` maps
 * originals to copies so shared references stay shared (a trap's `hz` is the
 * same object as its entry in level.hazards, a player's `ride` is a body).
 * Prototypes are kept (Player).
 */
function copyGraph(v, memo) {
  if (v === null || typeof v !== 'object') return v;
  let out = memo.get(v);
  if (out) return out;
  if (Array.isArray(v)) {
    out = new Array(v.length);
    memo.set(v, out);
    for (let i = 0; i < v.length; i++) out[i] = copyGraph(v[i], memo);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  out = proto === Object.prototype ? { ...v } : Object.assign(Object.create(proto), v);   // spread is much faster
  memo.set(v, out);
  for (const k in out) {
    const x = out[k];
    if (x !== null && typeof x === 'object' && !SHARED_KEYS.has(k)) out[k] = copyGraph(x, memo);
  }
  return out;
}

/** Shallow-copied record (`make` = blank target) whose object fields fixRecord() then deep-copies. */
function copyRecord(v, memo, make = null) {
  const out = make ? Object.assign(make(v), v) : { ...v };
  memo.set(v, out);
  return out;
}
const linkOf = t => Object.create(Object.getPrototypeOf(t));
const blankPlayer = p => new Player(p.index, 0, 0);   // much faster than Object.create(Player.prototype)
function fixRecord(out, memo) {
  for (const k in out) {
    const v = out[k];
    if (v !== null && typeof v === 'object' && !SHARED_KEYS.has(k)) out[k] = copyGraph(v, memo);
  }
  return out;
}

export const SCAN_RADIUS = 10 * TILE;
export const SCAN_GROW = 28;            // frames for the pulse ring to reach full radius
const NEAR_MISS_PAD = 6;

export class LevelRun {
  /** @param def level definition from gen.js   @param opts { god } */
  constructor(def, opts = {}) {
    this.def = def;
    this.parsed = parseLevel(def);
    this.god = !!opts.god;
    this.events = [];
    this.frame = 0;
    this.state = 'playing';     // playing | dead | won
    this.deathInfo = null;
    this.camFx = null;
    this.level = new Level(this.parsed);
    const s = this.parsed.spawns[0];
    this.players = [new Player(0, s.tx * TILE + (TILE - 20) / 2, (s.ty + 1) * TILE - 26)];
    this.keys = this.parsed.keys.map((k, id) => ({ id, ...keyRectAt(k.tx, k.ty), taken: false }));
    const d = this.parsed.door;
    this.door = { ...doorRectAt(d.tx, d.ty), hidden: false, targets: [], speed: 0 };
    this.scan = { cd: 0, max: def.scanCooldown ?? 150, t: -1, x: 0, y: 0, held: false, uses: 0 };
    this.traps = createTraps(def.traps ?? [], this);
    this.indexTraps();
  }

  indexTraps() {
    this.trapById = {};
    for (const t of this.traps) this.trapById[t.id] = t;
  }

  emit(type, data = {}) { this.events.push({ type, ...data }); }

  get player() { return this.players[0]; }
  get keysTaken() { let n = 0; for (const k of this.keys) if (k.taken) n++; return n; }
  doorLocked() { return this.keys.some(k => !k.taken); }

  /** Advance one fixed frame with the player's input bitmask (player.js IN_*). */
  step(mask) {
    this.events.length = 0;
    if (this.state !== 'playing') return;
    this.frame++;
    const p = this.players[0];

    // 1. Traps move (lifts carry riders, blocks fall, walls chase...).
    trapsPre(this);
    this.moveDoor();
    if (this.camFx && ++this.camFx.t >= this.camFx.frames) this.camFx = null;
    if (this.level.solidsIn(p).length) { this.kill(p, 'crush'); if (this.state !== 'playing') return; }

    // 2. Scanner gadget (edge-triggered).
    const sc = this.scan, scanDown = (mask & IN_SCAN) !== 0;
    if (scanDown && !sc.held && sc.cd === 0) {
      sc.cd = sc.max; sc.t = 0; sc.x = p.cx; sc.y = p.cy; sc.uses++;
      this.emit('scan', { x: sc.x, y: sc.y });
    }
    sc.held = scanDown;
    if (sc.cd > 0) sc.cd--;

    // 3. Player moves.
    applyZones(this, p);
    p.update(mask, this.level);
    if (p.jumped) this.emit('jump', { p: 0 });
    if (p.landed) this.emit('land', { p: 0 });

    // 4. Pickups, extraction, bounds.
    if (p.y > this.level.height + 40 || p.y + p.h < -40) { this.kill(p, 'fall'); return; }
    for (const k of this.keys) {
      if (!k.taken && overlaps(p, k)) { k.taken = true; this.emit('key', { id: k.id }); }
    }
    if (!this.door.hidden && !this.doorLocked() && overlaps(p, this.door)) {
      p.done = true; this.emit('door', { p: 0 });
    }

    // 5. Triggers fire, then hazards are checked.
    trapsPost(this);
    if (!p.done) {
      const cause = this.level.hazardAt(p);
      if (cause) { this.kill(p, cause); return; }
      if (p.nearMissCd === 0) {
        const pad = { x: p.x - NEAR_MISS_PAD, y: p.y - NEAR_MISS_PAD, w: p.w + 2 * NEAR_MISS_PAD, h: p.h + 2 * NEAR_MISS_PAD };
        if (this.level.hazardAt(pad)) { p.nearMissCd = 45; this.emit('nearMiss', { p: 0 }); }
      }
    }

    // 6. Scan pulse tags every trap the expanding ring reaches.
    if (sc.t >= 0) {
      const r = SCAN_RADIUS * Math.min(1, sc.t / SCAN_GROW);
      for (const t of this.traps) {
        if (!t.tagged && trapDistance(t, sc.x, sc.y) <= r) { t.tagged = true; this.emit('tag', { id: t.id, hidden: !!t.def.hidden }); }
      }
      if (++sc.t > SCAN_GROW + 30) sc.t = -1;
    }

    if (p.done) { this.state = 'won'; this.emit('win'); }
  }

  /** Runaway doors glide through their waypoint list. */
  moveDoor() {
    const d = this.door, tg = d.targets[0];
    if (!tg) return;
    const dx = tg.x - d.x, dy = tg.y - d.y, dist = Math.hypot(dx, dy);
    if (dist <= d.speed || !d.speed) { d.x = tg.x; d.y = tg.y; d.targets.shift(); }
    else { d.x += dx / dist * d.speed; d.y += dy / dist * d.speed; }
  }

  kill(p, cause) {
    if (this.state !== 'playing') return;
    if (this.god) {
      if (cause === 'fall' || cause === 'crush') {
        const s = this.parsed.spawns[0];
        p.x = s.tx * TILE + 6; p.y = (s.ty + 1) * TILE - 26; p.vx = p.vy = 0;
      }
      return;
    }
    this.state = 'dead';
    this.deathInfo = { cause, x: p.cx, y: p.cy, gdir: p.gdir };
    this.emit('death', { p: 0, cause, x: p.cx, y: p.cy });
  }

  /**
   * Deep copy of the whole simulation state (static def / grid / trigger data
   * are shared). Hand-rolled instead of structuredClone: the solver clones
   * hundreds of thousands of runs, and this is ~10x faster.
   */
  clone() {
    const c = Object.create(LevelRun.prototype);
    c.def = this.def; c.parsed = this.parsed; c.god = this.god; c.events = [];
    const lv = this.level, memo = new Map();
    // 1. flat copies of every record that can be referenced from elsewhere
    const traps = this.traps.map(t => copyRecord(t, memo, linkOf));   // keeps the def / spec link
    const bodies = lv.bodies.map(b => copyRecord(b, memo));
    const hazards = lv.hazards.map(h => copyRecord(h, memo));
    const players = this.players.map(p => copyRecord(p, memo, blankPlayer));
    // 2. re-point / deep-copy their object fields (owner, hz, body, ride, pos, cone...)
    for (const list of [traps, bodies, hazards, players]) for (const o of list) fixRecord(o, memo);
    c.level = Object.create(Level.prototype);
    Object.assign(c.level, { cols: lv.cols, rows: lv.rows, grid: lv.grid, bodies, hazards });
    Object.assign(c, {
      frame: this.frame, state: this.state, traps, players,
      deathInfo: copyGraph(this.deathInfo, memo), camFx: copyGraph(this.camFx, memo),
      keys: copyGraph(this.keys, memo), door: copyGraph(this.door, memo), scan: copyGraph(this.scan, memo),
    });
    c.indexTraps();
    return c;
  }
}
