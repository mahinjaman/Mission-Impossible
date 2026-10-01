// Procedural mission generator.
//
// generateMission(m, seed, prev) builds a complete level definition for
// mission `m` from a 32-bit seed. A level is a run of "encounters" (one trap
// set-piece each) joined by short connectors. Every encounter is built so
// that it is beatable by construction (gap widths, step heights, fuse and fall
// timings are all inside the player's physics envelope); tools/fuzz.mjs runs
// the real simulation through solver.js to prove it on thousands of seeds.
//
// No trap ever repeats: the app passes `prev` (the trap matrices of earlier
// attempts at this mission). Slot i never gets the same encounter as slot i of
// the previous attempt, and a matrix whose signature was already played is
// rejected and re-rolled.

import { Rng, matrixCode, missionIdentity } from './rng.js';

export const ROWS = 17;
const G_MIN = 9, G_MAX = 14;           // ground surface row range
const lerp = (a, b, t) => a + (b - a) * t;
const ri = Math.round;

/** 0 (mission 1) -> approaches 1. */
export function difficulty(m) { return 1 - Math.exp(-(m - 1) / 9); }

export function scanCooldown(m) { return ri(lerp(130, 230, difficulty(m))); }

class Builder {
  constructor(rng, m) {
    this.rng = rng; this.m = m; this.d = difficulty(m);
    this.ground = [];   // per column: surface row, or -1 for a pit
    this.ceil = [];     // per column: ceiling thickness (rows)
    this.ops = [];      // [ch, x, y, w, h] tile overrides
    this.traps = [];
    this.keys = [];
    this.signs = [];
    this.g = 13;        // current ground row
    this.c = 1;         // current ceiling thickness
    this.door = null;
    this.waits = 0;     // encounters that need waiting (for the par time)
  }
  get x() { return this.ground.length; }
  col(g = this.g) { this.ground.push(g); this.ceil.push(this.c); }
  flat(n) { for (let i = 0; i < n; i++) this.col(); }
  pit(n) { for (let i = 0; i < n; i++) this.col(-1); }
  put(ch, x, y, w = 1, h = 1) { this.ops.push([ch, x, y, w, h]); }
  trap(def) { const id = `t${this.traps.length}`; this.traps.push({ id, ...def }); return id; }
  sign(x, text) { this.signs.push([x, this.g - 4, text]); }

  toMap() {
    const W = this.ground.length;
    const rows = Array.from({ length: ROWS }, () => new Array(W).fill('.'));
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < this.ceil[x]; y++) rows[y][x] = '#';
      if (this.ground[x] >= 0) for (let y = this.ground[x]; y < ROWS; y++) rows[y][x] = '#';
    }
    for (const [ch, x, y, w, h] of this.ops) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        if (x + i >= 0 && x + i < W && y + j >= 0 && y + j < ROWS) rows[y + j][x + i] = ch;
      }
    }
    return rows.map(r => r.join(''));
  }
}

// ---------------------------------------------------------------------------
// Encounters. build(b) appends columns starting at b.x and must leave the
// player standing on flat ground at row b.g. Returns a variant tag.
//   wait:   needs the player to stop and time something (never right after a drone)
//   chase:  something keeps chasing for a while (next encounter must not need waiting)
// ---------------------------------------------------------------------------
const ENCOUNTERS = {
  // Floor that collapses under you.
  falseFloor: {
    min: 1, w: 3,
    build(b) {
      const { rng, d } = b;
      b.flat(rng.int(2, 3));
      const landing = d > 0.2 && rng.chance(0.45);
      if (landing) b.pit(1);
      const f = landing ? 2 : rng.int(2, 3), x0 = b.x;
      b.pit(f);
      b.trap({
        type: 'crumble', x: x0, y: b.g, w: f, h: 1, hidden: true, tell: rng.chance(0.85 - d),
        trigger: { on: 'zone', x: x0, y: b.g - 1, w: f, h: 1 }, delay: ri(lerp(8, 3, d)),
      });
      b.flat(rng.int(2, 3));
      return landing ? 'landing' : 'plain';
    },
  },

  // Hidden spikes that pop up right in front of you / visible piston spikes.
  spikes: {
    min: 1, w: 3,
    build(b) {
      const { rng, d } = b;
      // pistons need waiting: never while something is chasing you
      if (b.noWait || rng.chance(0.5)) {
        b.flat(1);
        const w = rng.int(7, 9), x0 = b.x;
        b.flat(w);
        const sw = rng.int(1, 2), sx = x0 + rng.int(3, w - sw - 2);
        // the zone starts 3 tiles ahead: at full speed the spikes pop >= ~19 frames before you reach them
        b.trap({
          type: 'spikes', x: sx, y: b.g - 1, w: sw, h: 1, dir: 'up', hidden: true,
          trigger: { on: 'zone', x: sx - 3, y: b.g - 2, w: 3, h: 2 }, delay: ri(lerp(9, 3, d)),
        });
        return 'ambush';
      }
      const n = rng.int(1, d > 0.4 ? 3 : 2), base = ri(lerp(80, 62, d)), on = ri(lerp(45, 60, d));
      b.flat(2);
      for (let i = 0; i < n; i++) {
        const sw = rng.int(3, 4), x = b.x;
        // off long enough to sprint across from a standstill with >= ~20 frames to spare
        const off = Math.max(base, ri((sw * 32 + 24) / 3.5) + 28);
        b.flat(sw);
        b.trap({ type: 'spikes', x, y: b.g - 1, w: sw, h: 1, dir: 'up', cycle: [off, on, rng.int(0, off + on - 1)], trigger: { on: 'always' } });
        b.flat(rng.int(2, 3));
      }
      b.waits++;
      return 'pistons';
    },
  },

  // Laser gates, a sweeping beam, or an invisible tripwire that sets something off.
  laser: {
    min: 1, w: 3, wait: true,
    build(b) {
      const { rng, d } = b;
      const mode = rng.pick(['gate', 'gate', 'sweep']);
      if (mode === 'gate') {
        const n = rng.int(1, d > 0.4 ? 3 : 2), off = ri(lerp(85, 58, d)), on = ri(lerp(45, 70, d));
        b.flat(2);
        for (let i = 0; i < n; i++) {
          const bx = b.x + 1;
          b.flat(3 + rng.int(0, 1));
          b.trap({ type: 'laser', x: bx + 0.4, y: b.c, w: 0.2, h: b.g - b.c, cycle: [off, on, rng.int(0, off + on - 1)] });
        }
        b.flat(1);
      } else {
        const w = rng.int(4, 5);
        b.flat(1);
        const x0 = b.x;
        b.flat(w);
        const period = ri(lerp(220, 160, d));
        b.trap({ type: 'laser', mode: 'sweep', x: x0, y: b.c, w, h: b.g - b.c, y0: b.c + 0.4, y1: b.g - 0.15, period, phase: rng.int(0, period - 1) });
        b.flat(2);
      }
      b.waits++;
      return mode;
    },
  },

  tripwire: {
    min: 2, w: 2,
    build(b) {
      const { rng, d } = b;
      b.flat(2);
      const w = rng.int(8, 10), x0 = b.x;
      b.flat(w);
      const xt = x0 + 2;
      const tw = b.trap({
        type: 'tripwire', x: xt + 0.45, y: b.g - 0.45, w: 0.1, h: 0.45, hidden: true, faint: rng.chance(0.75 - d),
      });
      const fx = rng.pick(d > 0.25 ? ['drop', 'sled', 'drone'] : ['drop', 'sled']);
      if (fx === 'drop') {
        // 3 tiles past the wire: a runner has ~19 frames to see it fall and stop
        b.trap({ type: 'drop', x: xt + 3, y: b.c, w: 2, h: 2, trigger: { on: 'trap', id: tw } });
      } else if (fx === 'sled') {
        b.trap({ type: 'sled', x: x0 + w - 2, y: b.g - 1, w: 2, h: 1, dir: 'up', vx: -lerp(3, 4.4, d), dist: w - 1, trigger: { on: 'trap', id: tw } });
      } else {
        b.trap({ type: 'drone', x: xt - 6, y: b.c + 1, w: 1, h: 1, sx: xt - 6, sy: b.c + 1, speed: lerp(2, 2.6, d), life: 170, trigger: { on: 'trap', id: tw } });
        b.chase = true;
      }
      return fx;
    },
  },

  // Ceiling camera with a sweeping vision cone. Sneak past while it looks away.
  camera: {
    min: 3, w: 2, wait: true,
    build(b) {
      const { rng, d } = b;
      b.flat(2);
      const w = 11, x0 = b.x;
      b.flat(w);
      const ay = b.g - 5;
      if (ay > b.c) b.put('#', x0 + 5, b.c, 1, ay - b.c);
      const period = ri(lerp(300, 230, d));
      b.trap({
        type: 'camera', x: x0, y: b.c, w, h: b.g - b.c, ax: x0 + 5.5, ay: ay + 0.25,
        len: (b.g - ay - 0.25) * 32 - 6, half: 9 * Math.PI / 180, amp: 62 * Math.PI / 180,
        period, phase: rng.int(0, period - 1),
      });
      b.flat(1);
      b.waits++;
      return 'sweep';
    },
  },

  // Hydraulic presses slamming from the ceiling.
  press: {
    min: 2, w: 2, wait: true,
    build(b) {
      const { rng, d } = b;
      const n = rng.int(1, d > 0.4 ? 3 : 2), cyc = [ri(lerp(95, 62, d)), 8, 26, 40], P = cyc.reduce((s, v) => s + v);
      b.flat(2);
      for (let i = 0; i < n; i++) {
        const px = b.x;
        b.flat(2);
        b.trap({ type: 'press', x: px, y: b.c, w: 2, h: b.g - b.c, up: b.g - 3, down: b.g, cyc, phase: (i * ri(P / (n + 1)) + rng.int(0, 20)) % P });
        b.flat(2 + rng.int(0, 1));
      }
      b.waits++;
      return `x${n}`;
    },
  },

  // A ceiling block that drops when you pass under it. Never stop under a ceiling.
  drop: {
    min: 4, w: 2,
    build(b) {
      const { rng, d } = b;
      const oldC = b.c;
      b.flat(1);
      b.c = Math.max(3, b.c);
      const w = rng.int(6, 8), x0 = b.x, fw = b.g - b.c >= 10 ? 2 : 1;
      const fx = x0 + rng.int(2, w - fw - 2);
      b.flat(w);
      b.put('.', fx, b.c - 2, fw, 2);
      b.trap({
        type: 'drop', x: fx, y: b.c - 2, w: fw, h: 2, hidden: true, tell: rng.chance(0.8 - d),
        trigger: { on: 'zone', x: fx, y: b.c, w: fw, h: b.g - b.c }, delay: ri(lerp(12, 6, d)),
      });
      b.c = oldC;
      b.flat(1);
      return `w${fw}`;
    },
  },

  // Proximity mines: step on one and keep running.
  mines: {
    min: 2, w: 3,
    build(b) {
      const { rng, d } = b;
      b.flat(1);
      const w = rng.int(8, 11), x0 = b.x;
      b.flat(w);
      // fuse: ~15 frames to react to the beep + ~23 to sprint out of the blast from a standstill
      const n = rng.int(1, d > 0.5 ? 3 : 2), fuse = ri(lerp(46, 38, d)), hidden = rng.chance(0.15 + d * 0.7);
      let mx = x0 + 2;
      for (let i = 0; i < n && mx <= x0 + w - 3; i++) {
        b.trap({
          type: 'mine', x: mx + 0.15, y: b.g - 0.25, w: 0.7, h: 0.25, hidden,
          trigger: { on: 'zone', x: mx + 0.1, y: b.g - 1, w: 0.8, h: 1 }, delay: fuse,
          blast: { x: mx - 0.75, y: b.g - 2, w: 2.5, h: 2 },
        });
        mx += rng.int(3, 4);
      }
      return hidden ? 'hidden' : 'visible';
    },
  },

  // Spike sled bursting out of the floor and sliding at you (or from behind).
  sled: {
    min: 2, w: 2,
    build(b) {
      const { rng, d } = b;
      b.flat(1);
      const w = rng.int(12, 14), x0 = b.x;
      b.flat(w);
      if (d > 0.3 && rng.chance(0.4)) {
        b.trap({ type: 'sled', x: x0 - 1, y: b.g - 1, w: 2, h: 1, dir: 'up', hidden: true, vx: lerp(5, 6, d), dist: w + 1, trigger: { on: 'x', gte: x0 + 4 } });
        return 'behind';
      }
      b.trap({ type: 'sled', x: x0 + w - 2, y: b.g - 1, w: 2, h: 1, dir: 'up', hidden: true, vx: -lerp(3, 4.5, d), dist: w - 1, trigger: { on: 'x', gte: x0 + 2.5 } });
      return 'front';
    },
  },

  // Anti-gravity field over a pit too wide to jump: walk the ceiling.
  gravity: {
    min: 4, w: 2,
    build(b) {
      const { rng, d } = b;
      const oldC = b.c;
      b.c = 1;
      // The field starts 5 tiles before the pit: falling up takes 30-42 frames
      // (3-4.6 tiles at full speed), so you land on the ceiling before the pit
      // and see the ceiling spikes coming instead of falling onto them.
      b.flat(6);
      const spikes = d > 0.2 && rng.chance(0.7);
      const p = spikes ? rng.int(6, 8) : rng.int(5, 7), px = b.x;
      b.pit(p);
      // dropping off the ceiling at full speed carries you ~3-5 tiles: land on solid ground
      b.flat(6);
      b.trap({ type: 'gravity', x: px - 5, y: 0, w: p + 6, h: ROWS, visible: true });
      if (spikes) {
        // >= 2 tiles of ceiling to run up before them, >= 3 tiles to land after
        const sw = Math.min(rng.int(1, 2), p - 5);
        b.put('v', px + 2 + rng.int(0, p - 4 - sw), 1, sw, 1);
      }
      b.c = oldC;
      return spikes ? 'spiked' : 'plain';
    },
  },

  // EMP jammer: reversed controls in front of a spike patch.
  emp: {
    min: 5, w: 2,
    build(b) {
      const { rng, d } = b;
      b.flat(1);
      const w = rng.int(9, 11), x0 = b.x;
      b.flat(w);
      const visible = rng.chance(1 - d * 0.7);
      b.trap({ type: 'emp', x: x0 + 1, y: 0, w: w - 2, h: ROWS, visible, hidden: !visible });
      const sw = rng.int(1, 2);
      b.put('^', x0 + rng.int(4, w - 3 - sw), b.g - 1, sw, 1);
      return visible ? 'visible' : 'hidden';
    },
  },

  // Moving lift across a wide pit, or up to a high ledge.
  lift: {
    min: 3, w: 2, wait: true,
    build(b) {
      const { rng, d } = b;
      b.flat(2);
      b.waits++;
      if (b.g - 4 >= G_MIN && b.g - 4 >= b.c + 6 && rng.chance(0.4)) {
        const px = b.x;
        b.pit(3);
        b.trap({ type: 'lift', x: px, y: b.g, w: 3, h: 0.5, path: [[0, -4]], loop: 'pingpong', speed: lerp(1.3, 2, d), wait: 40 });
        b.g -= 4;
        b.flat(3);
        return 'vertical';
      }
      const p = rng.int(6, 8), px = b.x;
      b.pit(p);
      b.trap({ type: 'lift', x: px, y: b.g, w: 2, h: 0.5, path: [[p - 2, 0]], loop: 'pingpong', speed: lerp(1.5, 2.2, d), wait: 24 });
      b.flat(2);
      return 'horizontal';
    },
  },

  // Lockdown: a spiked wall chases you down a corridor of hurdles.
  lockdown: {
    min: 5, w: 2, chaseOnly: true,
    build(b) {
      const { rng, d } = b;
      b.flat(2);
      const x0 = b.x, target = rng.int(14, 18);
      while (b.x - x0 < target) {
        const r = rng.next();
        if (r < 0.35) { b.flat(1); b.put('#', b.x, b.g - 1, 1, 1); b.flat(3); }
        else if (r < 0.65) { b.flat(1); b.pit(2); b.flat(1); }
        else b.flat(rng.int(2, 3));
      }
      const end = b.x, sx = x0 + 2 - lerp(7, 4, d);
      b.trap({
        type: 'lockdown', x: x0, y: b.c, w: end - x0, h: b.g - b.c, hidden: true,
        sx, speed: lerp(2.6, 3.05, d), dist: end + 1 - sx, trigger: { on: 'x', gte: x0 + 2 },
      });
      b.flat(2);
      b.chase = true;
      return 'chase';
    },
  },

  // Hunter drone launched from behind: outrun it.
  drone: {
    min: 5, w: 2,
    build(b) {
      const { rng, d } = b;
      b.flat(1);
      const x0 = b.x, w = rng.int(10, 13);
      b.flat(w);
      if (rng.chance(0.6)) b.put('#', x0 + rng.int(4, w - 3), b.g - 1, 1, 1);
      b.trap({
        type: 'drone', x: x0 - 5, y: b.c + 1, w: 1, h: 1, sx: x0 - 5, sy: b.c + 1, hidden: true,
        speed: lerp(2.0, 2.8, d), life: ri(lerp(170, 220, d)), trigger: { on: 'x', gte: x0 + 2 },
      });
      b.chase = true;
      return 'hunter';
    },
  },

  // Two keycards, one is a fake that arms a spike trap.
  fakeKey: {
    min: 4, w: 2, needsKeys: true,
    build(b) {
      const { rng, d } = b;
      b.flat(1);
      const x0 = b.x;
      b.flat(10);
      let real = x0 + 2 + rng.int(0, 1), fake = x0 + 6 + rng.int(0, 1);
      if (rng.chance(0.5)) [real, fake] = [fake, real];
      b.keys.push({ x: real, y: b.g - 2 });
      const fk = b.trap({ type: 'fakeKey', x: fake, y: b.g - 2, w: 1, h: 1, hidden: true });
      b.trap({ type: 'spikes', x: fake - 1, y: b.g - 1, w: 3, h: 1, dir: 'up', hidden: true, trigger: { on: 'trap', id: fk }, delay: ri(lerp(18, 10, d)) });
      return 'pair';
    },
  },
};

// End pieces: where (and what) the extraction point is.
const ENDINGS = {
  plain: {
    min: 1, w: 3,
    build(b) { b.flat(3); const x0 = b.x; b.flat(6); b.door = { x: x0 + 3, y: b.g - 1 }; return 'plain'; },
  },
  decoy: {
    min: 3, w: 2,
    build(b) {
      const { rng } = b;
      b.flat(3);
      const x0 = b.x;
      b.flat(10);
      const fakeFirst = rng.chance(0.65), a = x0 + 3, c = x0 + 7;
      b.door = { x: fakeFirst ? c : a, y: b.g - 1 };
      b.trap({ type: 'fakeDoor', x: fakeFirst ? a : c, y: b.g - 1, hidden: true });
      return fakeFirst ? 'fakeFirst' : 'realFirst';
    },
  },
  runaway: {
    min: 4, w: 2,
    build(b) {
      const { rng } = b;
      b.flat(2);
      const x0 = b.x;
      b.flat(12);
      b.door = { x: x0 + 9, y: b.g - 1 };
      let to;
      if (rng.chance(0.5)) {
        b.put('#', x0 + 2, b.g - 2, 3, 1);
        to = [{ x: x0 + 9, y: b.g - 5 }, { x: x0 + 3, y: b.g - 3 }];
      } else {
        to = [{ x: x0 + 9, y: b.g - 4 }, { x: x0 + 1, y: b.g - 1 }];
      }
      b.trap({ type: 'runDoor', hidden: true, x: x0 + 7, y: b.g - 2, w: 1, h: 2, to, speed: 7, trigger: { on: 'x', gte: x0 + 7 } });
      return to.length === 2 && to[1].y === b.g - 3 ? 'ledge' : 'behind';
    },
  },
};

// Lying (and sometimes honest) holo-signs.
const SIGNS = ['TRUST NOTHING', 'SAFE ZONE', 'NO TRAPS AHEAD', 'KEEP MOVING', 'SCAN IT', 'DON\'T STOP', 'ALMOST THERE', 'LOOK UP', 'RUN'];

function connector(b, opts = {}) {
  const { rng, d } = b;
  // ceiling variation (always leaves >= 6 rows of headroom)
  if (rng.chance(0.4)) b.c = Math.min(rng.int(1, 3), b.g - 6);
  const r = rng.next();
  if (r < 0.22 && b.g - 1 >= G_MIN && b.g - 1 >= b.c + 6) { b.flat(1); b.g -= 1; b.flat(rng.int(2, 3)); }
  else if (r < 0.44 && b.g + 1 <= G_MAX) { b.flat(1); b.g += 1; b.flat(rng.int(2, 3)); }
  else if (r < 0.62 && !opts.noPit) { b.flat(2); b.pit(2); b.flat(2); }
  else {
    const n = rng.int(3, 4), x0 = b.x;
    b.flat(n);
    // late missions: a lone false tile that only kills you if you hesitate on it
    if (!opts.noTrap && rng.chance(d * 0.5)) {
      const fx = x0 + 1 + rng.int(0, n - 3);
      b.ground[fx] = -1;
      b.trap({ type: 'crumble', x: fx, y: b.g, w: 1, h: 1, hidden: true, trigger: { on: 'zone', x: fx, y: b.g - 1, w: 1, h: 1 }, delay: 16 });
    }
  }
}

/** Trap matrix signature: which encounter/variant sits in which slot. */
function signature(slots) { return slots.join('|'); }

/**
 * Build mission `m` from `seed`.
 * @param prev  array of previous signatures for this mission (most recent last)
 */
export function generateMission(m, seed, prev = []) {
  const prevSlots = prev.length ? prev[prev.length - 1].split('|').map(s => s.split(':')[0]) : [];
  let oldest = null, oldestAt = Infinity;
  for (let attempt = 0; attempt < 64; attempt++) {
    const def = build(m, (seed + attempt * 0x9E3779B1) >>> 0, prevSlots);
    const at = prev.lastIndexOf(def.signature);
    if (at < 0) return def;
    // Mission 1's small pool (~50 matrices) can run dry after dozens of deaths:
    // then replay the matrix seen longest ago (still a new seed = new layout).
    if (at < oldestAt) { oldest = def; oldestAt = at; }
  }
  return oldest;
}

function build(m, seed, prevSlots) {
  const rng = new Rng(seed);
  const b = new Builder(rng, m);
  const d = b.d;
  const keysNeeded = m >= 4 && rng.chance(0.25 + d * 0.35);

  // spawn pad
  b.g = rng.int(11, 13);
  b.flat(4);
  const spawn = { x: 1, y: b.g - 1 };

  const n = Math.min(3 + Math.floor((m - 1) * 0.6), 12);
  const pool = Object.entries(ENCOUNTERS).filter(([, e]) => e.min <= m && (!e.needsKeys || keysNeeded));
  const slots = [], spans = [];   // spans[i] = [first, last] column of slot i (incl. its connector)
  let last = null, chase = false, usedFakeKey = false;
  for (let i = 0; i < n; i++) {
    let cands = pool.filter(([name, e]) =>
      name !== last && name !== prevSlots[i] &&
      !(chase && e.wait) && !(name === 'fakeKey' && usedFakeKey));
    // (never empty in practice; if it were, keep the fairness rule and drop the variety ones)
    if (!cands.length) cands = pool.filter(([name, e]) => name !== last && !(chase && e.wait));
    if (!cands.length) cands = pool.filter(([name]) => name !== last);
    // prefer encounters not used yet in this level (variety within one matrix too)
    const used = nm => slots.filter(s => s.startsWith(nm + ':')).length;
    const [name, enc] = rng.weighted(cands.map(([nm, e]) => ({ w: e.w / (1 + 3 * used(nm)), v: [nm, e] }))).v;
    const sx = b.x;
    // no lone false tile where the player may stand and wait (camera / laser / press / lift / pistons)
    const waits = enc.wait || name === 'spikes';
    connector(b, { noPit: chase, noTrap: chase || waits });
    if (rng.chance(0.18)) b.sign(b.x - 1, rng.pick(SIGNS));
    b.chase = false;
    b.noWait = chase;   // encounters with a waiting variant pick another one while chased
    const variant = enc.build(b);
    chase = !!b.chase;
    if (name === 'fakeKey') usedFakeKey = true;
    slots.push(`${name}:${variant}`);
    spans.push([sx, b.x - 1]);
    last = name;
  }

  if (keysNeeded && !b.keys.length) {
    const sx = b.x;
    connector(b, { noTrap: true });
    const x0 = b.x;
    b.flat(4);
    b.keys.push({ x: x0 + 2, y: b.g - 2 });
    slots.push('keycard');
    spans.push([sx, b.x - 1]);
  }

  const ex = b.x;
  connector(b, { noPit: chase, noTrap: true });
  // rotate endings between attempts when there is a choice (missions 1-2 only have the plain one)
  const eligible = Object.entries(ENDINGS).filter(([, e]) => e.min <= m);
  const fresh = eligible.filter(([name]) => `end-${name}` !== prevSlots[slots.length]);
  const ends = fresh.length ? fresh : eligible;
  const [endName, end] = rng.weighted(ends.map(([nm, e]) => ({ w: e.w, v: [nm, e] }))).v;
  const endVariant = end.build(b);
  slots.push(`end-${endName}:${endVariant}`);
  b.flat(2);
  spans.push([ex, b.x - 1]);

  // stamp markers
  b.put('P', spawn.x, spawn.y);
  b.put('D', b.door.x, b.door.y);
  for (const k of b.keys) b.put('K', k.x, k.y);

  const map = b.toMap();
  const W = map[0].length;
  const id = missionIdentity(m);
  const sig = signature(slots);
  return {
    id: `M${String(m).padStart(3, '0')}-${matrixCode(seed)}`,
    mission: m, seed, difficulty: d,
    matrix: matrixCode(seed),
    signature: sig,
    slots, spans,
    ...id,
    map, traps: b.traps, signs: b.signs,
    keysNeeded: b.keys.length,
    scanCooldown: scanCooldown(m),
    par: ri((W * 32 / 3.5) * 1.15 + b.waits * 70 + 90),
    threat: Math.min(5, 1 + Math.floor(d * 5)),
  };
}
