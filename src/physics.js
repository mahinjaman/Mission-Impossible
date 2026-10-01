// Deterministic physics: constants + axis-separated AABB movement.
// Units are pixels and frames. The simulation always advances in fixed
// 1/60 s steps, so identical input sequences give identical results.

export const TILE = 32;
export const FPS = 60;
export const STEP_MS = 1000 / FPS;
export const EPS = 1e-6;

export const PHYS = Object.freeze({
  playerW: 20,
  playerH: 26,
  maxRun: 3.5,        // px/frame
  groundAccel: 0.7,
  groundDecel: 0.9,
  airAccel: 0.5,
  airDecel: 0.15,
  gravity: 0.6,
  maxFall: 12,
  jumpVel: 10.2,      // ~82px max jump height (2.5 tiles)
  jumpCut: 3,         // releasing jump clamps upward speed to this
  coyoteFrames: 5,    // ~80ms
  bufferFrames: 5,    // ~80ms
});

/** Strict AABB overlap (touching edges do not count). */
export function overlaps(a, b) {
  return a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS &&
         a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;
}

export function approach(v, target, amount) {
  return v < target ? Math.min(v + amount, target) : Math.max(v - amount, target);
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Move a body horizontally and stop at the nearest solid. Returns the solid hit or null. */
export function moveX(body, dx, level, ignore = null) {
  if (dx === 0) return null;
  body.x += dx;
  let hit = null;
  for (const s of level.solidsIn(body, ignore)) {
    if (dx > 0) {
      const nx = s.x - body.w;
      if (nx < body.x) { body.x = nx; hit = s; }
    } else {
      const nx = s.x + s.w;
      if (nx > body.x) { body.x = nx; hit = s; }
    }
  }
  return hit;
}

/** Move a body vertically and stop at the nearest solid. Returns the solid hit or null. */
export function moveY(body, dy, level, ignore = null) {
  if (dy === 0) return null;
  body.y += dy;
  let hit = null;
  for (const s of level.solidsIn(body, ignore)) {
    if (dy > 0) {
      const ny = s.y - body.h;
      if (ny < body.y) { body.y = ny; hit = s; }
    } else {
      const ny = s.y + s.h;
      if (ny > body.y) { body.y = ny; hit = s; }
    }
  }
  return hit;
}
