// Headless solver: proves a generated level is beatable by searching over
// player inputs with the REAL simulation (LevelRun + clone()). Pure: no DOM,
// no randomness, runs in Node (tools/fuzz.mjs) and in the browser.
//
// Synchronous beam search. Every K frames (default 6 = 100ms, a human-ish
// decision granularity) each surviving state branches over a small set of
// input masks held for the next K frames (some switch to jump half-way, for
// finer jump timing). Dead states are dropped, duplicates (same quantized
// player state + trap state) merged. States are scored by progress towards the
// exit (keycards first); half the beam keeps the front-runners, the other half
// is refilled round-robin over x-buckets (best state of every bucket first,
// then the second best...) so cautious "waiting" states survive while the
// front-runners die at lasers and cameras. Inputs are kept as a parent-pointer
// chain and only flattened for the winner.
//
//   solve(def, { k, beam, maxFrames, stall }) ->
//     { ok, frames, inputs, expanded, ms, reason, maxX, at, deaths, beam }
//
// `beam` may be a list of widths: the search starts narrow (fast, enough for
// almost every level) and only retries wider when it fails.

import { LevelRun } from './game.js';
import { IN_LEFT, IN_RIGHT, IN_JUMP } from './player.js';
import { TILE } from './physics.js';

const R = IN_RIGHT, L = IN_LEFT, J = IN_JUMP;
// [mask for the first half of the K frames, mask for the second half]. The
// "late" jumps double the jump timing resolution. The last action reuses the
// parent run instead of cloning it.
export const SOLVER_ACTIONS = [[R | J, R | J], [R, R | J], [0, 0], [L, L], [J, J], [L | J, L | J], [L, L | J], [R, R]];

const now = () => (globalThis.performance ? performance.now() : Date.now());
const q = (v, s) => Math.round(v / s);

/** Compact string of everything the player's input can have changed in the traps (time-driven traps are equal across the beam). */
function trapKey(run) {
  let s = '';
  for (const t of run.traps) {
    s += t.state === 'idle' ? '0' : t.state === 'pending' ? 'p' : 'a';
    if (t.type === 'drone' && t.state === 'active' && !t.dead) s += `${q(t.pos.x, 4)}:${q(t.pos.y, 4)}`;
  }
  return s;
}

/** Dedup key: quantized player state + keys + door + trap states. */
function stateKey(run) {
  const p = run.player;
  return `${q(p.x, 1.5)},${q(p.y, 1.5)},${q(p.vx, 0.35)},${q(p.vy, 0.6)},${p.grounded ? 1 : 0}${p.jumpHeld ? 1 : 0}${p.jumping ? 1 : 0}${p.coyote > 0 ? 1 : 0},` +
    `${p.gdir},${run.keysTaken},${run.door.targets.length},${q(run.door.x, 4)},${q(run.door.y, 4)},${trapKey(run)}`;
}

/**
 * How close a run is to winning (higher = better): every keycard is worth more
 * than any distance, then minus the (horizontal) distance to the exit. On most
 * levels that is simply "further right". A runaway exit counts as progress
 * once it has bolted (speed set): from then on the target is where it settles.
 */
function progress(run) {
  const p = run.player, d = run.door, tg = d.targets.length ? d.targets[d.targets.length - 1] : d;
  return run.keysTaken * 1e5 + (d.speed ? 1e4 : 0) - Math.abs(tg.x + tg.w / 2 - p.cx);
}

/** Rebuild the per-frame input array from a node's parent chain. */
function chainInputs(node) {
  const parts = [];
  for (let n = node; n && n.parent; n = n.parent) parts.push(n);
  const out = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const { a, first, n, half } = parts[i];
    for (let f = 0; f < n; f++) out.push(f === 0 ? first : f < half ? a[0] : a[1]);
  }
  return out;
}

/**
 * Search for an input sequence that wins `def`.
 * @param opts.k         frames per decision (default 6)
 * @param opts.beam      states kept per generation, or a list tried in order (default [10, 32, 96])
 * @param opts.maxFrames give up after this many frames (default ~3x par)
 * @param opts.stall     give up when the frontier has not advanced for this many frames (default 600)
 * @param opts.bucket    x-bucket width in px for the diversity round-robin (default 1 tile)
 * @param opts.window    states further than this (px) behind the frontier are dropped (default 14 tiles)
 * @param opts.start     LevelRun to start from instead of a fresh one (debugging)
 * @param opts.trace     fn(frame, beam) called every generation (debugging)
 */
export function solve(def, opts = {}) {
  const widths = [].concat(opts.beam ?? [10, 32, 96]);
  let total = 0, ms = 0, res = null;
  for (const beam of widths) {
    res = search(def, { ...opts, beam });
    total += res.expanded; ms += res.ms;
    if (res.ok) break;
  }
  res.expanded = total; res.ms = ms;
  return res;
}

function search(def, opts) {
  const t0 = now();
  const K = opts.k ?? 6, B = opts.beam, bucketW = opts.bucket ?? TILE, win = opts.window ?? 14 * TILE;
  const maxFrames = opts.maxFrames ?? Math.max(1800, (def.par ?? 1200) * 3);
  const stall = opts.stall ?? 600;
  const actions = opts.actions ?? SOLVER_ACTIONS;

  const half = K >> 1;
  let beam = [{ run: opts.start ? opts.start.clone() : new LevelRun(def), parent: null, a: null, first: 0, n: 0, half }];
  let expanded = 0, maxX = -Infinity, progressS = -Infinity, bestFrame = 0, frame = 0, at = null;
  const deaths = {};       // cause -> count, for deaths near the frontier
  const fail = reason => ({
    ok: false, frames: frame, inputs: null, expanded, ms: now() - t0, reason, maxX, at, deaths, beam: B,
  });

  while (frame < maxFrames) {
    const children = new Map();
    for (const node of beam) {
      const src = node.run, p0 = src.player;
      node.run = null;   // parents only keep their chain link
      // Holding jump into a landing does nothing: a jump action from a state that
      // still holds the button (and is not rising) releases it for one frame first.
      const repress = p0.jumpHeld && !p0.jumping;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i], first = repress && (a[0] & IN_JUMP) ? a[0] & ~IN_JUMP : a[0];
        const run = i === actions.length - 1 ? src : src.clone();
        let n = 0;
        while (n < K && run.state === 'playing') { run.step(n === 0 ? first : n < half ? a[0] : a[1]); n++; }
        expanded++;
        if (run.state === 'won') {
          const inputs = chainInputs({ parent: node, a, first, n, half });
          return { ok: true, frames: inputs.length, inputs, expanded, ms: now() - t0, reason: 'won', maxX: Math.max(maxX, run.player.x), at, deaths, beam: B };
        }
        if (run.state === 'dead') {
          if (run.deathInfo.x >= maxX - 3 * TILE) deaths[run.deathInfo.cause] = (deaths[run.deathInfo.cause] ?? 0) + 1;
          continue;
        }
        const key = stateKey(run);
        if (!children.has(key)) children.set(key, { run, parent: node, a, first, n, half });
      }
    }
    frame += K;
    if (!children.size) return fail(`all states died near x=${(maxX / TILE).toFixed(1)}`);

    // Score = progress towards the exit (keycards first). Diversity: bucket by
    // (keys taken, x) so the best state of each bucket survives (waiting states
    // behind a laser too); states far behind their key group's leader are dropped.
    const lead = new Map();   // keys taken -> best score
    for (const c of children.values()) {
      const p = c.run.player;
      if (p.x > maxX) { maxX = p.x; at = { x: p.x, y: p.y, frame }; }
      c.score = progress(c.run) + (p.grounded ? 4 : 0);
      const k = c.run.keysTaken;
      if (!(lead.get(k) >= c.score)) lead.set(k, c.score);
    }
    const front = Math.max(...lead.values());
    if (front > progressS + TILE / 2) { progressS = front; bestFrame = frame; }
    const buckets = new Map();
    for (const c of children.values()) {
      const k = c.run.keysTaken;
      if (c.score < lead.get(k) - win) continue;
      const bk = k * 1e5 + Math.floor(c.run.player.x / bucketW);
      let list = buckets.get(bk);
      if (!list) buckets.set(bk, list = []);
      list.push(c);
    }
    // Half the beam: the front-runners. The other half: round-robin over the
    // buckets (best bucket first), best state of each bucket first.
    const all = [...buckets.values()].flat().sort((x, y) => y.score - x.score);
    const next = all.slice(0, B >> 1);
    const taken = new Set(next);
    const order = [...buckets.values()].map(l => l.sort((x, y) => y.score - x.score)).sort((x, y) => y[0].score - x[0].score);
    for (let round = 0; next.length < B; round++) {
      let took = false;
      for (const list of order) {
        if (round < list.length) {
          took = true;
          if (!taken.has(list[round])) { next.push(list[round]); if (next.length >= B) break; }
        }
      }
      if (!took) break;
    }
    beam = next;
    if (opts.trace) opts.trace(frame, beam);
    if (frame - bestFrame > stall) return fail(`stalled at x=${(maxX / TILE).toFixed(1)}`);
  }
  return fail(`timeout at x=${(maxX / TILE).toFixed(1)}`);
}

/** Re-simulate `inputs` on a fresh LevelRun (determinism check). Returns the final run. */
export function replay(def, inputs) {
  const run = new LevelRun(def);
  for (const m of inputs) { run.step(m); if (run.state !== 'playing') break; }
  return run;
}
