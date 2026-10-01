// Data-driven trap system (simulation only - all drawing lives in render.js).
//
// A trap definition (produced by gen.js) looks like:
//   { id: 't3', type: 'mine', x, y, w, h,          // area in tiles (fractions allowed)
//     trigger: { on: 'zone', x, y, w, h },          // or an array (any fires)
//     delay: 0,                                     // frames between trigger and effect
//     hidden: true,                                 // concealed until scanned / fired
//     ...type specific params }
//
// Trigger kinds ("on"):
//   always            fires on the first frame
//   zone  x,y,w,h     the player overlaps the zone
//   touch             the player overlaps the trap's own rect
//   x     gte|lte     player centre x (tiles) >= / <= value
//   jump  [zone]      the player jumps (optionally inside zone)
//   land  [zone]      the player lands (optionally inside zone)
//   timer frames      level time (frames) reached
//   key   [count]     keycards collected >= count (default 1)
//   trap  id          another trap became active (chains)
//   idle  frames      the player stood still for N frames
//
// Trap lifecycle: idle -> (trigger) -> pending -> (delay) -> active.
//
// Runtime traps are plain data (plus non-enumerable `def` / `spec` links on a
// per-trap prototype, see attachTrap), so a whole LevelRun can be deep-copied
// cheaply (game.js clone, used by solver.js to prove every generated level is
// beatable).

import { TILE, EPS, overlaps, moveX, moveY } from './physics.js';
import { spikeBox } from './level.js';

const T = TILE;
export const DOOR_W = 28, DOOR_H = 44, KEY_W = 18, KEY_H = 22;
export const DRONE_W = 22, DRONE_H = 14;

export function tileRect(o, defW = 1, defH = 1) {
  return { x: (o.x ?? 0) * T, y: (o.y ?? 0) * T, w: (o.w ?? defW) * T, h: (o.h ?? defH) * T };
}
export function doorRectAt(tx, ty) {
  return { x: tx * T + (T - DOOR_W) / 2, y: (ty + 1) * T - DOOR_H, w: DOOR_W, h: DOOR_H };
}
export function keyRectAt(tx, ty) {
  return { x: tx * T + (T - KEY_W) / 2, y: ty * T + (T - KEY_H) / 2, w: KEY_W, h: KEY_H };
}
const setRect = (o, r) => { o.x = r.x; o.y = r.y; o.w = r.w; o.h = r.h; };
const inRect = (px, py, r) => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;

/**
 * Move a dynamic solid body, carrying riders and pushing anyone in its way.
 * Players squeezed into other solids are crushed (checked by the run).
 */
export function moveBody(run, body, dx, dy) {
  if (dx === 0 && dy === 0) return;
  const riders = run.players.filter(p => !p.done && p.ride === body);
  body.x += dx; body.y += dy;
  for (const p of run.players) {
    if (p.done) continue;
    if (riders.includes(p)) {
      moveX(p, dx, run.level, body);
      moveY(p, dy, run.level, body);
    } else if (body.enabled && overlaps(p, body)) {
      if (Math.abs(dx) >= Math.abs(dy)) p.x = dx > 0 ? body.x + body.w : body.x - p.w;
      else p.y = dy > 0 ? body.y + body.h : body.y - p.h;
    }
  }
}

// ---------------------------------------------------------------------------
// Trap type registry. Hooks (all optional):
//   init(t, run)      create bodies/hazards
//   activate(t, run)  effect starts
//   update(t, run)    every frame before the player moves (motion)
//   modify(t, p)      zone traps: apply modifier to a player inside the zone
// Flags: zone (modifier field), defaultTrigger / implicit trigger.
// `label` is what the scanner prints next to a tagged trap.
// ---------------------------------------------------------------------------
export const TRAP_TYPES = {
  // False floor: looks like solid floor, collapses `delay` frames after being stepped on.
  crumble: {
    label: 'FALSE FLOOR',
    init(t, run) { t.body = run.level.addBody(t, t.rect); t.drop = 0; t.dropV = 0; },
    activate(t) { t.body.enabled = false; },
    update(t) {
      if (t.state === 'active' && t.drop < 600) { t.dropV = Math.min(t.dropV + 0.8, 16); t.drop += t.dropV; }
    },
  },

  // Spikes that pop out of the floor. `cycle: [off, on, phase]` = visible pistons forever.
  spikes: {
    label: 'SPIKE TRAP',
    init(t, run) {
      t.dir = t.def.dir ?? 'up';
      t.hz = run.level.addHazard(t, spikeBox(t.dir, t.rect), 'spikes');
      t.hz.enabled = false; t.pop = 0;
    },
    activate(t) { t.hz.enabled = !t.def.cycle; },
    update(t, run) {
      if (t.state !== 'active') return;
      if (t.def.cycle) {
        const [off, on, phase = 0] = t.def.cycle;
        const k = (run.frame + phase) % (off + on);
        t.hz.enabled = k >= off;
        t.warn = !t.hz.enabled && k >= off - 18;
      }
      t.pop = t.hz.enabled ? Math.min(1, t.pop + 0.34) : Math.max(0, t.pop - 0.2);
    },
  },

  // Spike sled: a spike strip that bursts out and slides along the floor (vx px/frame), then sinks.
  sled: {
    label: 'SPIKE SLED',
    init(t, run) {
      t.dir = t.def.dir ?? 'up';
      t.pos = { ...t.rect }; t.moved = 0; t.gone = false;
      t.maxDist = (t.def.dist ?? 10) * T;
      t.hz = run.level.addHazard(t, spikeBox(t.dir, t.pos), 'spikes');
      t.hz.enabled = false;
    },
    activate(t) { t.hz.enabled = true; },
    update(t) {
      if (t.state !== 'active' || t.gone) return;
      const vx = t.def.vx ?? -3, step = Math.min(Math.abs(vx), t.maxDist - t.moved);
      t.pos.x += Math.sign(vx) * step; t.moved += step;
      setRect(t.hz, spikeBox(t.dir, t.pos));
      if (t.moved >= t.maxDist - EPS) { t.gone = true; t.hz.enabled = false; }
    },
  },

  // Ceiling drop: solid while hanging, deadly while falling, solid once landed.
  drop: {
    label: 'CEILING DROP',
    init(t, run) {
      t.pos = { ...t.rect }; t.v = 0; t.landed = false;
      t.body = run.level.addBody(t, t.pos);
      t.hz = run.level.addHazard(t, t.pos, 'crush'); t.hz.enabled = false;
    },
    activate(t) { t.body.enabled = false; t.hz.enabled = true; },
    update(t, run) {
      if (t.state !== 'active' || t.landed) return;
      t.v = Math.min(t.v + (t.def.accel ?? 0.9), t.def.maxSpeed ?? 14);
      const probe = { ...t.pos };
      const hit = moveY(probe, t.v, run.level, t.body);
      t.pos.y = probe.y;
      if (hit || t.pos.y > run.level.height + 64) {
        t.landed = true; t.hz.enabled = false; t.body.enabled = !!hit;
        if (hit) run.emit('slam', { x: t.pos.x + t.pos.w / 2, y: t.pos.y + t.pos.h });
      }
      setRect(t.body, t.pos); setRect(t.hz, t.pos);
    },
  },

  // Hydraulic press: cycles forever. cyc: [up, slam, down, rise] frames, `up` / `down` = bottom row (tiles).
  press: {
    label: 'HYDRAULIC PRESS', defaultTrigger: { on: 'always' },
    init(t, run) {
      t.top = t.rect.y; t.upB = t.def.up * T; t.downB = t.def.down * T; t.bottom = t.upB;
      t.hz = run.level.addHazard(t, { x: t.rect.x, y: t.top, w: t.rect.w, h: t.upB - t.top }, 'crush');
    },
    update(t, run) {
      const [U, S, D, R] = t.def.cyc, P = U + S + D + R;
      const k = (run.frame + (t.def.phase ?? 0)) % P;
      let b;
      if (k < U) b = t.upB;
      else if (k < U + S) b = t.upB + (t.downB - t.upB) * ((k - U) / S);
      else if (k < U + S + D) b = t.downB;
      else b = t.downB + (t.upB - t.downB) * ((k - U - S - D) / R);
      if (k === U + S) run.emit('slam', { x: t.rect.x + t.rect.w / 2, y: t.downB, soft: true });
      t.bottom = b; t.warn = k >= U - 20 && k < U;
      t.hz.h = b - t.top;
    },
  },

  // Laser. mode 'gate' (default): beam = trap rect, cycle [off, on, phase].
  //        mode 'sweep': horizontal beam across the rect, sweeping between rows y0..y1 (period frames).
  laser: {
    label: 'LASER GRID', defaultTrigger: { on: 'always' },
    init(t, run) {
      t.hz = run.level.addHazard(t, t.rect, 'laser'); t.hz.enabled = false; t.on = false; t.warn = false;
      if (t.def.mode === 'sweep') { t.hz.h = 4; t.beamY = t.def.y0 * T; }
    },
    update(t, run) {
      if (t.state !== 'active') return;
      const d = t.def;
      if (d.mode === 'sweep') {
        const k = (run.frame + (d.phase ?? 0)) / d.period * Math.PI * 2;
        t.beamY = d.y0 * T + (d.y1 - d.y0) * T * (0.5 - 0.5 * Math.cos(k));
        t.hz.y = t.beamY - 2; t.hz.enabled = true; t.on = true;
        return;
      }
      const [off, on, phase = 0] = d.cycle;
      const k = (run.frame + phase) % (off + on);
      t.on = k >= off; t.warn = !t.on && k >= off - 24;
      t.hz.enabled = t.on;
    },
  },

  // Invisible tripwire: crossing it fires every trap chained to it ({ on: 'trap', id }).
  tripwire: {
    label: 'TRIPWIRE', implicit: 'touch',
    activate(t, run) { run.emit('alarm', {}); },
  },

  // Sentry camera: sweeping vision cone; being seen = mission failed.
  // ax, ay (tiles) apex, len px, half / amp radians, period frames.
  camera: {
    label: 'SENTRY CAM', defaultTrigger: { on: 'always' },
    init(t, run) {
      const d = t.def;
      t.hz = run.level.addHazard(t, { x: 0, y: 0, w: 0, h: 0 }, 'detected');
      t.hz.cone = { ax: d.ax * T, ay: d.ay * T, ang: 0, half: d.half, len: d.len };
    },
    update(t, run) {
      const d = t.def;
      t.hz.cone.ang = d.amp * Math.sin((run.frame + (d.phase ?? 0)) / d.period * Math.PI * 2);
    },
  },

  // Proximity mine: stepping on it starts the fuse (= delay); then `blast` (tiles) is deadly for 14 frames.
  mine: {
    label: 'PROX MINE',
    init(t, run) { t.hz = run.level.addHazard(t, tileRect(t.def.blast), 'mine'); t.hz.enabled = false; t.boom = 0; },
    activate(t, run) {
      t.hz.enabled = true; t.boom = 14;
      run.emit('boom', { x: t.rect.x + t.rect.w / 2, y: t.rect.y + t.rect.h });
    },
    update(t) {
      if (t.state === 'active' && t.boom > 0 && --t.boom === 0) t.hz.enabled = false;
    },
  },

  // Hunter drone: launches from (sx, sy) tiles and homes in on the player for `life` frames.
  drone: {
    label: 'HUNTER DRONE',
    init(t, run) {
      t.pos = { x: t.def.sx * T, y: t.def.sy * T, w: DRONE_W, h: DRONE_H };
      t.vx = 0; t.vy = 0; t.life = t.def.life ?? 200; t.dead = false;
      t.hz = run.level.addHazard(t, t.pos, 'drone'); t.hz.enabled = false;
    },
    activate(t, run) { t.hz.enabled = true; run.emit('alarm', {}); },
    update(t, run) {
      if (t.state !== 'active' || t.dead) return;
      const p = run.players[0];
      const dx = p.cx - (t.pos.x + DRONE_W / 2), dy = p.cy - (t.pos.y + DRONE_H / 2), dist = Math.hypot(dx, dy) || 1;
      const sp = t.def.speed ?? 2.2;
      t.vx += (dx / dist * sp - t.vx) * 0.12; t.vy += (dy / dist * sp - t.vy) * 0.12;
      t.pos.x += t.vx; t.pos.y += t.vy;
      setRect(t.hz, t.pos);
      if (--t.life <= 0) {
        t.dead = true; t.hz.enabled = false;
        run.emit('boom', { x: t.pos.x + DRONE_W / 2, y: t.pos.y + DRONE_H / 2, harmless: true });
      }
    },
  },

  // Anti-gravity field: the player's centre inside = gravity flipped.
  gravity: {
    label: 'GRAV FIELD', zone: true, defaultTrigger: { on: 'always' },
    modify(t, p) { p.gdir = -1; },
  },

  // EMP jammer: reversed controls while inside.
  emp: {
    label: 'EMP JAMMER', zone: true, defaultTrigger: { on: 'always' },
    modify(t, p) { p.reversed = true; },
  },

  // Lift: platform moving along `path` ([[dx,dy],...] tile offsets), loop 'pingpong' | 'loop', wait frames.
  lift: {
    label: 'LIFT', defaultTrigger: { on: 'always' },
    init(t, run) {
      if (t.def.h === undefined) t.rect.h = T / 2;
      t.body = run.level.addBody(t, t.rect);
      t.path = [[0, 0], ...(t.def.path ?? [])].map(([dx, dy]) => ({ x: t.rect.x + dx * T, y: t.rect.y + dy * T }));
      t.seg = 1; t.step = 1; t.wait = t.def.wait ?? 0; t.stopped = t.path.length < 2;
    },
    update(t, run) {
      if (t.state !== 'active' || t.stopped) return;
      if (t.wait > 0) { t.wait--; return; }
      const b = t.body, target = t.path[t.seg], speed = t.def.speed ?? 2;
      let dx = target.x - b.x, dy = target.y - b.y;
      const dist = Math.hypot(dx, dy);
      if (dist > speed) { dx *= speed / dist; dy *= speed / dist; }
      moveBody(run, b, dx, dy);
      if (dist <= speed) {
        b.x = target.x; b.y = target.y;
        t.wait = t.def.wait ?? 0;
        const last = t.path.length - 1;
        if (t.def.loop === 'loop') t.seg = (t.seg + 1) % t.path.length;
        else if (t.def.loop === 'pingpong') {
          if (t.seg + t.step > last || t.seg + t.step < 0) t.step = -t.step;
          t.seg += t.step;
        } else if (t.seg < last) t.seg++;
        else t.stopped = true;
      }
    },
  },

  // Lockdown: a spiked wall slams down at sx (tiles) and chases right at `speed` for `dist` tiles.
  lockdown: {
    label: 'LOCKDOWN WALL',
    init(t, run) {
      t.pos = { x: t.def.sx * T, y: t.rect.y, w: T + 10, h: t.rect.h };
      t.moved = 0; t.gone = false; t.maxDist = t.def.dist * T;
      t.hz = run.level.addHazard(t, t.pos, 'walls'); t.hz.enabled = false;
    },
    activate(t, run) { t.hz.enabled = true; run.emit('alarm', {}); },
    update(t) {
      if (t.state !== 'active' || t.gone) return;
      const sp = Math.min(t.def.speed ?? 2.8, t.maxDist - t.moved);
      t.pos.x += sp; t.moved += sp;
      setRect(t.hz, t.pos);
      if (t.moved >= t.maxDist - EPS) { t.gone = true; t.hz.enabled = false; }
    },
  },

  // Decoy extraction: looks exactly like the real exit, kills on touch.
  // The deadly box is inset (5px sides, 10px top) so hopping over a scanned
  // decoy has a ~14 frame take-off window instead of a pixel-perfect one.
  fakeDoor: {
    label: 'DECOY EXIT', implicit: 'touch',
    init(t, run) {
      t.rect = doorRectAt(t.def.x, t.def.y);
      t.hz = run.level.addHazard(t, { x: t.rect.x + 5, y: t.rect.y + 10, w: t.rect.w - 10, h: t.rect.h - 10 }, 'decoy');
    },
  },

  // Runaway exit: the real door glides away along `to` (waypoints, tiles) at `speed` px/frame.
  runDoor: {
    label: 'RUNAWAY EXIT',
    activate(t, run) {
      const d = run.door, pts = [].concat(t.def.to).map(p => doorRectAt(p.x, p.y));
      d.speed = t.def.speed ?? 6;
      d.targets = pts;
    },
  },

  // Fake keycard: collecting it fires chained traps ({ on: 'trap', id }).
  fakeKey: {
    label: 'FAKE KEYCARD', implicit: 'touch',
    init(t) { t.rect = keyRectAt(t.def.x, t.def.y); },
    activate(t, run) { run.emit('fakeKey', {}); },
  },
};

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------
const alive = run => run.players.filter(p => !p.done);

export const TRIGGERS = {
  always: () => true,
  zone: (tr, t, run) => alive(run).some(p => overlaps(p, tr.rect)),
  touch: (tr, t, run) => alive(run).some(p => overlaps(p, t.rect)),
  x: (tr, t, run) => alive(run).some(p => tr.gte !== undefined ? p.cx >= tr.gte * T : p.cx <= tr.lte * T),
  jump: (tr, t, run) => alive(run).some(p => p.jumped && (!tr.rect || overlaps(p, tr.rect))),
  land: (tr, t, run) => alive(run).some(p => p.landed && (!tr.rect || overlaps(p, tr.rect))),
  timer: (tr, t, run) => run.frame >= tr.frames,
  key: (tr, t, run) => run.keysTaken >= (tr.count ?? 1),
  trap: (tr, t, run) => run.trapById[tr.id]?.state === 'active',
  idle: (tr, t, run) => alive(run).some(p => p.idleFrames >= tr.frames && (!tr.rect || overlaps(p, tr.rect))),
};

function prepTrigger(src) {
  const tr = { ...src };
  if (!TRIGGERS[tr.on]) throw new Error(`Unknown trigger '${tr.on}'`);
  if (tr.on === 'zone') tr.rect = tileRect(tr);
  else if (tr.zone) tr.rect = tileRect(tr.zone);
  return tr;
}

/**
 * Link a runtime trap to its (shared, read-only) definition without making it
 * cloneable data: `def` / `spec` live, non-enumerable, on a tiny per-trap
 * prototype. LevelRun.clone() copies the own fields onto the same prototype,
 * so cloning never has to re-link anything.
 */
export function attachTrap(t, def) {
  const link = Object.create(Object.prototype, {
    def: { value: def, writable: true, configurable: true, enumerable: false },
    spec: { value: TRAP_TYPES[def.type], writable: true, configurable: true, enumerable: false },
  });
  return Object.setPrototypeOf(t, link);
}

/** Instantiate runtime traps for one attempt. */
export function createTraps(defs, run) {
  return defs.map((d, i) => {
    const spec = TRAP_TYPES[d.type];
    if (!spec) throw new Error(`Unknown trap type '${d.type}'`);
    const trig = d.trigger ?? spec.defaultTrigger ?? (spec.implicit ? { on: spec.implicit } : null);
    const t = attachTrap({
      id: d.id ?? `${d.type}${i}`, type: d.type,
      rect: tileRect(d), state: 'idle', firedAt: -1, activeAt: -1,
      delay: d.delay ?? 0, tagged: false,
      triggers: trig ? (Array.isArray(trig) ? trig : [trig]).map(prepTrigger) : [],
    }, d);
    spec.init?.(t, run);
    return t;
  });
}

/** Motion pass: runs before the player moves. */
export function trapsPre(run) {
  for (const t of run.traps) t.spec.update?.(t, run);
}

/** Apply zone modifiers (gravity, reversed controls) to a player. */
export function applyZones(run, p) {
  p.gdir = 1;
  p.reversed = false;
  p.speedMult = 1;
  for (const t of run.traps) {
    if (!t.spec.zone || t.state !== 'active') continue;
    if (inRect(p.cx, p.cy, t.rect)) t.spec.modify(t, p);
  }
}

/** Trigger pass: runs after the player moves. */
export function trapsPost(run) {
  for (const t of run.traps) {
    if (t.state === 'idle' && t.triggers.length && t.triggers.some(tr => TRIGGERS[tr.on](tr, t, run))) {
      t.state = 'pending'; t.firedAt = run.frame;
    }
    if (t.state === 'pending' && run.frame - t.firedAt >= t.delay) {
      t.state = 'active'; t.activeAt = run.frame;
      t.spec.activate?.(t, run);
      if (!t.spec.zone && !t.spec.defaultTrigger) run.emit('trap', { id: t.id, trapType: t.type });
    }
  }
}

/** Distance (px) from point to the trap's footprint: its rect and every trigger zone. */
export function trapDistance(t, px, py) {
  const rects = [t.pos ?? t.rect, ...t.triggers.filter(tr => tr.rect).map(tr => tr.rect)];
  let best = Infinity;
  for (const r of rects) {
    const dx = Math.max(r.x - px, 0, px - (r.x + r.w)), dy = Math.max(r.y - py, 0, py - (r.y + r.h));
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}
