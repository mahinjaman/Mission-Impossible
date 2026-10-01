// Keyboard + touch input -> one input bitmask per simulation step
// (see player.js IN_* bits).
//
//   Move   ← / → , A / D
//   Jump   Space / ↑ / W / Z
//   Scan   E / Shift / X / K
//
// A key that is pressed and released between two simulation steps still
// counts as held for one step ("tapped"), so very quick taps are never lost.
// Nothing touches the DOM at import time.

import { IN_LEFT, IN_RIGHT, IN_JUMP, IN_SCAN } from './player.js';

const MAP = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  jump: ['Space', 'ArrowUp', 'KeyW', 'KeyZ'],
  scan: ['KeyE', 'ShiftLeft', 'ShiftRight', 'KeyX', 'KeyK'],
};
const BLOCK_DEFAULT = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Backspace']);

export function isTouchDevice() {
  try {
    const q = new URLSearchParams(location.search).get('touch');
    if (q === '1') return true;    // force on-screen controls (testing)
    if (q === '0') return false;
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  } catch { return false; }
}

export class Input {
  constructor() {
    this.down = new Set();
    this.tapped = new Set();
    this.presses = [];                        // key presses for menus (consumed per render frame)
    this.touch = { left: new Set(), right: new Set(), jump: new Set(), scan: new Set() };
    this.touchTap = new Set();
    this.touchEls = [];

    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;      // leave browser shortcuts alone
      if (BLOCK_DEFAULT.has(e.code)) e.preventDefault?.();
      if (!e.repeat) { this.presses.push(e.code); this.tapped.add(e.code); }
      this.down.add(e.code);
    });
    window.addEventListener('keyup', e => this.down.delete(e.code));
    window.addEventListener('blur', () => this.releaseAll());
  }

  releaseAll() {
    this.down.clear();
    for (const s of Object.values(this.touch)) s.clear();
    for (const el of this.touchEls) el.classList?.remove('on');
  }

  /**
   * Wire the on-screen touch controls inside `root` (#touch):
   *   [data-k="jump"|"scan"|"pause"]  buttons
   *   [data-k="dpad"]                 left/right pad: the half under each finger
   *                                   is held; sliding across switches direction.
   */
  bindTouch(root, onPause) {
    if (!root?.querySelectorAll) return;
    const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* optional */ } };
    for (const el of root.querySelectorAll('[data-k]')) {
      const k = el.dataset.k;
      if (k === 'dpad') { this.bindDpad(el, buzz); continue; }
      this.touchEls.push(el);
      const press = e => {
        e.preventDefault?.();
        if (k === 'pause') { buzz(12); onPause?.(); return; }
        if (!this.touch[k]) return;
        buzz(k === 'scan' ? 14 : 8);
        el.setPointerCapture?.(e.pointerId);
        this.touch[k].add(e.pointerId);
        this.touchTap.add(k);
        // A jump tap also acts like a Space press (e.g. skips the death screen).
        if (k === 'jump') this.presses.push('Space');
        el.classList.add('on');
      };
      const release = e => {
        if (!this.touch[k]) return;
        this.touch[k].delete(e.pointerId);
        if (!this.touch[k].size) el.classList.remove('on');
      };
      el.addEventListener('pointerdown', press);
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
      el.addEventListener('contextmenu', e => e.preventDefault());
    }
  }

  bindDpad(el, buzz) {
    const halves = { left: el.querySelector('[data-dir="left"]'), right: el.querySelector('[data-dir="right"]') };
    const refresh = () => {
      halves.left?.classList.toggle('on', this.touch.left.size > 0);
      halves.right?.classList.toggle('on', this.touch.right.size > 0);
      el.classList.toggle('on', this.touch.left.size + this.touch.right.size > 0);
    };
    const aim = e => {
      const r = el.getBoundingClientRect();
      const dir = e.clientX < r.left + r.width / 2 ? 'left' : 'right';
      const other = dir === 'left' ? 'right' : 'left';
      if (!this.touch[dir].has(e.pointerId)) {
        this.touch[other].delete(e.pointerId);
        this.touch[dir].add(e.pointerId);
        this.touchTap.add(dir);
        buzz(6);
      }
      refresh();
    };
    const release = e => {
      this.touch.left.delete(e.pointerId);
      this.touch.right.delete(e.pointerId);
      refresh();
    };
    el.addEventListener('pointerdown', e => { e.preventDefault?.(); el.setPointerCapture?.(e.pointerId); aim(e); });
    el.addEventListener('pointermove', e => { if (this.touch.left.has(e.pointerId) || this.touch.right.has(e.pointerId)) aim(e); });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', e => e.preventDefault());
    this.touchEls.push(...Object.values(halves).filter(Boolean), el);
  }

  held(code) { return this.down.has(code) || this.tapped.has(code); }

  touchOn(k) { return this.touch[k].size > 0 || this.touchTap.has(k); }

  /** Input bitmask for one simulation step (keyboard OR touch). */
  mask() {
    const any = k => MAP[k].some(c => this.held(c)) || this.touchOn(k);
    return (any('left') ? IN_LEFT : 0) | (any('right') ? IN_RIGHT : 0) |
           (any('jump') ? IN_JUMP : 0) | (any('scan') ? IN_SCAN : 0);
  }

  /** Call after each simulation step consumed the input: clears taps. */
  endStep() { this.tapped.clear(); this.touchTap.clear(); }

  /** KeyboardEvent.code values pressed since the last call (for menus). */
  consumePresses() { const p = this.presses; this.presses = []; return p; }
}
