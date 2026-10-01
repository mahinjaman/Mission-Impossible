// Player controller: precise, deterministic platforming.
// Acceleration-based running, coyote time, jump buffering, variable jump
// height, gravity direction (anti-grav fields) and reversed controls (EMP).

import { PHYS, approach, moveX, moveY } from './physics.js';

// Input bitmask for one frame.
export const IN_LEFT = 1, IN_RIGHT = 2, IN_JUMP = 4, IN_SCAN = 8;

export class Player {
  constructor(index, x, y) {
    this.index = index;
    this.x = x; this.y = y;
    this.w = PHYS.playerW; this.h = PHYS.playerH;
    this.vx = 0; this.vy = 0;
    this.gdir = 1;            // 1 = normal gravity, -1 = flipped
    this.grounded = false;
    this.coyote = 0;
    this.buffer = 0;
    this.jumpHeld = false;
    this.jumping = false;     // rising from a jump (variable height applies)
    this.idleFrames = 0;
    this.jumped = false;      // per-frame event flags
    this.landed = false;
    this.ride = null;         // moving body we stand on
    this.done = false;        // reached extraction
    this.facing = 1;
    this.speedMult = 1;
    this.reversed = false;
    this.nearMissCd = 0;
  }

  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }

  /** Advance one fixed step with the given input mask. */
  update(mask, level) {
    this.jumped = false; this.landed = false;
    if (this.done) return;

    let left = (mask & IN_LEFT) !== 0, right = (mask & IN_RIGHT) !== 0;
    const jump = (mask & IN_JUMP) !== 0;
    if (this.reversed) { const t = left; left = right; right = t; }
    const dir = (right ? 1 : 0) - (left ? 1 : 0);

    const max = PHYS.maxRun * this.speedMult;
    if (dir !== 0) {
      const base = this.grounded ? PHYS.groundAccel : PHYS.airAccel;
      const turning = this.vx * dir < 0;
      this.vx = approach(this.vx, dir * max, base * this.speedMult * (turning ? 2 : 1));
      this.facing = dir;
    } else {
      this.vx = approach(this.vx, 0, this.grounded ? PHYS.groundDecel : PHYS.airDecel);
    }
    if (Math.abs(this.vx) > max) this.vx = Math.sign(this.vx) * max;

    if (jump && !this.jumpHeld) this.buffer = PHYS.bufferFrames;
    this.jumpHeld = jump;
    if (this.buffer > 0 && this.coyote > 0) {
      this.vy = -PHYS.jumpVel * this.gdir;
      this.buffer = 0; this.coyote = 0;
      this.jumping = true; this.jumped = true;
    }
    if (this.jumping && !jump && this.vy * this.gdir < -PHYS.jumpCut) {
      this.vy = -PHYS.jumpCut * this.gdir;
    }

    this.vy += PHYS.gravity * this.gdir;
    if (this.vy * this.gdir > PHYS.maxFall) this.vy = PHYS.maxFall * this.gdir;
    if (this.vy * this.gdir >= 0) this.jumping = false;

    if (moveX(this, this.vx, level)) this.vx = 0;
    const hit = moveY(this, this.vy, level);

    const wasGrounded = this.grounded;
    this.grounded = false; this.ride = null;
    if (hit) {
      if (this.vy * this.gdir > 0) {
        this.grounded = true;
        this.ride = hit.owner ? hit : null;
      }
      this.vy = 0; this.jumping = false;
    }

    if (this.grounded) this.coyote = PHYS.coyoteFrames;
    else if (this.coyote > 0) this.coyote--;
    if (this.buffer > 0) this.buffer--;
    this.landed = this.grounded && !wasGrounded;
    this.idleFrames = (this.grounded && (mask & 7) === 0) ? this.idleFrames + 1 : 0;
    if (this.nearMissCd > 0) this.nearMissCd--;
  }
}
