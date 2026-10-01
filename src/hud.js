// In-mission HUD: diegetic spy gadgets around the edges of the playfield.
//   top      burning fuse = time vs par, with route progress / keycards / exit on the same line
//   top-left mission + trap matrix line
//   top-right ECG heart monitor ("spider sense": BPM rises near ANY trap, hidden ones too)
//   bot-left scanner wrist-dial (radial cooldown)
//   bot-right keycard slots + exit lock
// Also exposes `danger` (0..1) and `glitch` (0..1) for audio + post FX.

import { C, themeFor, rgba, fmtTime } from './theme.js';
import { trapDistance, TRAP_TYPES } from './traps.js';
import {
  VW, VH, clamp, mix, txt, txtS, h32, drawFuse, drawFingerprint, brackets, ecgShape, pad3, textW,
} from './ui.js';

const TAU = Math.PI * 2;
const ECG_N = 120;             // samples on screen (1 per sim tick = 2 s)
const DANGER_RANGE = 150;      // px: beyond this a trap does not raise the pulse
// how much each trap type can scare you (lifts are friendly, fields are merely weird)
const WEIGHT = { lift: 0, gravity: 0.3, emp: 0.4, runDoor: 0.45, fakeKey: 0.7, camera: 0.85, laser: 0.9 };

/** Trap is used up and can no longer hurt you. */
function spent(t) {
  switch (t.type) {
    case 'crumble': return t.state === 'active';
    case 'mine': return t.state === 'active' && !t.boom;
    case 'drone': return !!t.dead;
    case 'sled': case 'lockdown': return !!t.gone;
    case 'drop': return !!t.landed;
    case 'tripwire': case 'fakeKey': case 'runDoor': return t.state === 'active';
    default: return false;
  }
}

export class Hud {
  constructor() {
    this.danger = 0;
    this.glitch = 0;
    this.ecg = new Float32Array(ECG_N);
    this.head = 0;
    this.phase = 0;
    this.bpm = 68;
    this.beatT = 99;
    this.pings = [];
    this.alarmT = 0;
    this.keyFlash = 0;
    this.empT = 0;
    this.t = 0;
  }

  reset() {
    this.danger = 0;
    this.pings.length = 0;
    this.alarmT = 0;
    this.keyFlash = 0;
    // the ECG buffer is kept on purpose: the flatline of the last attempt
    // scrolls away as the pulse comes back on the new matrix
  }

  /** Every sim tick while playing. */
  update(run, app) {
    this.t++;
    const p = run?.player;
    let target = 0;
    if (p && run.state === 'playing') {
      for (const t of run.traps) {
        const w = WEIGHT[t.type] ?? 1;
        if (!w || spent(t)) continue;
        const k = clamp(1 - trapDistance(t, p.cx, p.cy) / DANGER_RANGE);
        const v = k * k * (3 - 2 * k) * w;
        if (v > target) target = v;
      }
    }
    this.danger += (target - this.danger) * (target > this.danger ? 0.12 : 0.035);
    if (this.danger < 0.001) this.danger = 0;

    // heart
    const dead = (app?.deathT ?? -1) >= 0 || run?.state === 'dead';
    const want = 68 + this.danger * 112;
    this.bpm += (want - this.bpm) * 0.05;
    let sample = 0;
    if (dead) {
      sample = (h32(this.t, 5) - 0.5) * 0.03;
    } else {
      const inc = this.bpm / 3600;
      // peak-preserving sub-sampling so the R spike never gets skipped at high BPM
      for (let s = 1; s <= 6; s++) {
        const v = ecgShape((this.phase + inc * s / 6) % 1);
        if (Math.abs(v) > Math.abs(sample)) sample = v;
      }
      const before = this.phase;
      this.phase = (this.phase + inc) % 1;
      if (before < 0.25 && (this.phase >= 0.25 || this.phase < before)) this.beatT = 0;
      sample += (h32(this.t, 9) - 0.5) * 0.04 * (0.3 + this.danger);
    }
    this.ecg[this.head] = sample;
    this.head = (this.head + 1) % ECG_N;
    this.beatT++;
    this.dead = dead;

    // glitch: decays, EMP keeps it buzzing
    this.glitch *= 0.88;
    if (p?.reversed) {
      this.empT++;
      this.glitch = Math.max(this.glitch, 0.12 + (h32(this.t, 3) < 0.12 ? 0.35 : 0));
    } else this.empT = 0;
    if (this.glitch < 0.002) this.glitch = 0;

    for (const g of this.pings) g.t++;
    while (this.pings.length && this.pings[0].t > this.pings[0].life) this.pings.shift();
    if (this.alarmT > 0) this.alarmT--;
    if (this.keyFlash > 0) this.keyFlash--;
  }

  ping(text, color, key = text, life = 110) {
    const last = this.pings[this.pings.length - 1];
    if (last && last.key === key && last.t < 30) { last.n++; last.t = Math.min(last.t, 8); return; }
    this.pings.push({ text, color, key, t: 0, life, n: 1 });
    if (this.pings.length > 4) this.pings.shift();
  }

  onEvent(e, run) {
    switch (e.type) {
      case 'tag':
        if (e.hidden) {
          const tr = run?.trapById?.[e.id];
          const label = TRAP_TYPES[tr?.type]?.label ?? 'HIDDEN TRAP';
          this.ping(`THREAT IDENTIFIED · ${label}`, C.scan, 'tag', 120);
        }
        break;
      case 'alarm':
        this.alarmT = 80;
        this.glitch = Math.max(this.glitch, 0.6);
        this.ping('ALARM TRIPPED', C.danger, 'alarm');
        break;
      case 'nearMiss':
        this.glitch = Math.max(this.glitch, 0.2);
        this.ping('CLOSE CALL', C.warn, 'near', 70);
        break;
      case 'key':
        this.keyFlash = 40;
        this.ping('KEYCARD ACQUIRED', C.key, 'key');
        break;
      case 'fakeKey':
        this.glitch = Math.max(this.glitch, 0.55);
        this.ping('IT WAS A FAKE', C.danger, 'fake', 130);
        break;
      case 'boom':
        this.glitch = Math.max(this.glitch, e.harmless ? 0.15 : 0.35);
        break;
      case 'slam':
        if (!e.soft) this.glitch = Math.max(this.glitch, 0.15);
        break;
      case 'win':
        this.ping('EXTRACTION CONFIRMED', C.good, 'win', 200);
        break;
    }
  }

  // ---------------------------------------------------------------- drawing
  draw(ctx, app) {
    const run = app.run, def = app.def ?? run?.def;
    if (!run || !def) return;
    const th = themeFor(def.mission ?? 1);
    const frame = app.frame ?? 0;
    this.drawTrack(ctx, run, def, th, frame);
    this.drawInfo(ctx, app, run, def, th, frame);
    this.drawEcg(ctx, th, frame);
    this.drawScanner(ctx, run, th, frame);
    if ((def.keysNeeded ?? 0) > 0) this.drawKeys(ctx, run, def, frame);
    this.drawStatus(ctx, run, frame);
    if (this.alarmT > 0 && (this.alarmT >> 3) % 2 === 0) {
      const w = 150, x = VW / 2 - w / 2, y = 26;
      ctx.fillStyle = 'rgba(40,0,8,0.8)'; ctx.fillRect(x, y, w, 24);
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, w, 24); ctx.clip();
      ctx.fillStyle = rgba(C.danger, 0.35);
      ctx.beginPath();
      for (let k = -24; k < w; k += 12) { ctx.moveTo(x + k, y + 24); ctx.lineTo(x + k + 6, y + 24); ctx.lineTo(x + k + 30, y); ctx.lineTo(x + k + 24, y); }
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = C.danger; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 23);
      txt(ctx, 'ALARM', VW / 2, y + 17, 15, '#fff', 'center', 'bold');
    }
  }

  /** Top line: the fuse (time vs par) + route progress + keycards + exit. */
  drawTrack(ctx, run, def, th, frame) {
    const x0 = 14, x1 = VW - 14, y = 7;
    const par = Math.max(1, def.par ?? 1);
    const tp = run.frame / par, over = run.frame > par;
    const W = Math.max(1, run.level?.width ?? 1);
    const X = f => x0 + (x1 - x0) * clamp(f);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, VW, 15);
    const sx = drawFuse(ctx, x0, x1, y, tp, frame, { over, spark: run.state === 'playing' || frame % 2 === 0 });
    // par ticks every 10%
    ctx.fillStyle = rgba(C.dim, 0.5);
    for (let i = 1; i < 10; i++) ctx.fillRect(X(i / 10), y + 3, 1, 3);
    // extraction marker
    const d = run.door;
    const dx = X((d.x + d.w / 2) / W), locked = run.doorLocked();
    const exitCol = d.hidden ? C.dim : locked ? C.warn : C.good;
    ctx.strokeStyle = exitCol; ctx.lineWidth = 1.5;
    ctx.strokeRect(dx - 4, y - 5, 8, 10);
    ctx.fillStyle = exitCol;
    ctx.fillRect(dx - 1, y - 1, 2, 2);
    // keycards
    for (const k of run.keys) {
      const kx = X((k.x + k.w / 2) / W);
      ctx.fillStyle = k.taken ? C.key : 'rgba(0,0,0,0.6)';
      ctx.strokeStyle = C.key; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(kx, y - 5); ctx.lineTo(kx + 4, y); ctx.lineTo(kx, y + 5); ctx.lineTo(kx - 4, y); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    // agent
    const p = run.player;
    const prog = clamp(p.cx / W), ax = X(prog);
    const ghost = !over && prog > tp + 0.015 && run.state !== 'dead';
    const col = ghost ? C.good : th.accent;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(ax - 5, y + 4); ctx.lineTo(ax + 5, y + 4); ctx.lineTo(ax, y + 10); ctx.closePath(); ctx.fill();
    ctx.fillRect(ax - 0.5, y - 5, 1, 9);
    if (ghost) {
      const lx = Math.min(ax + 8, x1 - 70);
      txtS(ctx, 'GHOST PACE', lx, y + 13, 9, C.good, 'left', 'bold');
    }
    // time readout riding the spark / over-par warning
    if (over) {
      if ((frame >> 4) % 2 === 0) txtS(ctx, `OVER PAR +${fmtTime(run.frame - par)}`, x1 - 196, y + 15, 10, C.danger, 'right', 'bold');
    } else {
      const lx = clamp(sx, x0 + 20, x1 - 220);
      txtS(ctx, `T+${(run.frame / 60).toFixed(1)}`, lx, y + 15, 9, rgba(C.warn, 0.9), 'center', 'bold');
    }
  }

  drawInfo(ctx, app, run, def, th, frame) {
    const x = 14;
    const l1a = `M-${pad3(def.mission ?? 1)} // `;
    txtS(ctx, l1a, x, 35, 11, th.accent, 'left', 'bold');
    const w1 = textW(ctx, l1a, 11, 'bold');
    txtS(ctx, `${def.codename ?? ''} · ${def.city ?? ''}`, x + w1, 35, 11, C.text, 'left', 'bold');
    const l2 = `MATRIX ${def.matrix ?? '????-????'} · ATTEMPT ${app.attempt ?? 1} · ✝ ${app.missionDeaths ?? 0}`;
    txtS(ctx, l2, x, 49, 10, C.dim, 'left', 'bold');
    const w2 = textW(ctx, l2, 10, 'bold');
    drawFingerprint(ctx, def.matrix, x + w2 + 8, 41, 1.5, rgba(C.warn, 0.85), null);
    if (app.debug?.god) {
      ctx.fillStyle = C.danger; ctx.fillRect(x + w2 + 52, 40, 30, 11);
      txt(ctx, 'GOD', x + w2 + 67, 49, 9, '#fff', 'center', 'bold');
    }
    // event pings
    let y = 69;
    for (const g of this.pings) {
      const a = Math.min(1, (g.life - g.t) / 20);
      if (a <= 0) continue;
      const n = Math.floor(g.t * 2.2);
      const s = g.text + (g.n > 1 ? ` ×${g.n}` : '');
      const shown = s.slice(0, n);
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(x, y - 10, textW(ctx, shown, 10, 'bold') + 14, 14);
      ctx.fillStyle = g.color; ctx.fillRect(x, y - 10, 2, 14);
      txt(ctx, shown, x + 8, y + 1, 10, g.color, 'left', 'bold');
      ctx.globalAlpha = 1;
      y += 17;
    }
    void frame; void run;
  }

  drawEcg(ctx, th, frame) {
    const X = 764, Y = 20, W = 184, H = 46;
    const dead = this.dead;
    const col = dead ? C.danger : mix(th.accent, C.danger, clamp((this.danger - 0.15) / 0.7));
    ctx.fillStyle = 'rgba(2,5,10,0.6)';
    ctx.fillRect(X, Y, W, H);
    // ECG paper grid
    ctx.fillStyle = rgba(th.accent, 0.07);
    ctx.beginPath();
    for (let gx = X + 6; gx < X + 126; gx += 8) ctx.rect(gx, Y + 2, 1, H - 4);
    for (let gy = Y + 6; gy < Y + H; gy += 8) ctx.rect(X + 4, gy, 122, 1);
    ctx.fill();
    brackets(ctx, X, Y, W, H, 6, rgba(col, 0.7), 1);
    // waveform, oldest -> newest, with a fading tail
    const x0 = X + 5, mid = Y + 31, amp = 20;
    for (let seg = 0; seg < 3; seg++) {
      ctx.strokeStyle = col;
      ctx.globalAlpha = [0.25, 0.55, 1][seg];
      ctx.lineWidth = seg === 2 ? 1.8 : 1.4;
      ctx.beginPath();
      const a = Math.floor(seg * ECG_N / 3), b = Math.min(ECG_N - 1, Math.floor((seg + 1) * ECG_N / 3));
      for (let i = a; i <= b; i++) {
        const v = this.ecg[(this.head + i) % ECG_N];
        const px = x0 + i, py = mid - v * amp;
        if (i === a) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const hv = this.ecg[(this.head + ECG_N - 1) % ECG_N];
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0 + ECG_N - 2, mid - hv * amp - 1.5, 3, 3);
    // readout
    const rx = X + W - 6;
    if (dead) {
      txt(ctx, '---', rx, Y + 26, 18, C.danger, 'right', 'bold');
      txt(ctx, 'PULSE ·', X + 6, Y + 10, 8, rgba(C.dim, 0.9), 'left', 'bold');
      if ((frame >> 3) % 2 === 0) txt(ctx, 'FLATLINE', X + 46, Y + 10, 8, C.danger, 'left', 'bold');
      txt(ctx, 'BPM', rx, Y + 40, 8, rgba(C.dim, 0.9), 'right', 'bold');
    } else {
      txt(ctx, String(Math.round(this.bpm)), rx, Y + 26, 18, col, 'right', 'bold');
      const state = this.danger > 0.66 ? 'DANGER CLOSE' : this.danger > 0.3 ? 'ELEVATED' : 'CALM';
      txt(ctx, 'PULSE ·', X + 6, Y + 10, 8, rgba(C.dim, 0.9), 'left', 'bold');
      txt(ctx, state, X + 46, Y + 10, 8, col, 'left', 'bold');
      // heart icon pumps on each beat
      const s = 1 + Math.max(0, 1 - this.beatT / 8) * 0.45;
      const hx = X + 138, hy = Y + 15;
      ctx.save();
      ctx.translate(hx, hy); ctx.scale(s, s);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, 4); ctx.bezierCurveTo(-7, -1, -4, -7, 0, -3); ctx.bezierCurveTo(4, -7, 7, -1, 0, 4);
      ctx.fill();
      ctx.restore();
      txt(ctx, 'BPM', rx, Y + 40, 8, rgba(C.dim, 0.9), 'right', 'bold');
    }
  }

  /** Wrist-watch dial: radial recharge, glows when ready. */
  drawScanner(ctx, run, th, frame) {
    const cx = 40, cy = VH - 42, r = 25;
    const sc = run.scan;
    const charge = sc.max > 0 ? 1 - sc.cd / sc.max : 1;
    const ready = sc.cd === 0;
    // strap stubs
    ctx.fillStyle = 'rgba(8,14,24,0.85)';
    ctx.fillRect(cx - 12, cy - r - 9, 24, 8); ctx.fillRect(cx - 12, cy + r + 1, 24, 8);
    // bezel
    ctx.fillStyle = 'rgba(3,6,12,0.82)';
    ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba(C.scan, ready ? 0.9 : 0.35); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, TAU); ctx.stroke();
    // minute ticks
    ctx.strokeStyle = rgba(C.scan, 0.35); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 30; i++) {
      const a = i * TAU / 30, l = i % 5 ? 2 : 4;
      ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * (r - l), cy + Math.sin(a) * (r - l));
    }
    ctx.stroke();
    // charge wedge
    ctx.fillStyle = rgba(C.scan, ready ? 0.28 + 0.12 * Math.sin(frame * 0.12) : 0.18);
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r - 5, -Math.PI / 2, -Math.PI / 2 + TAU * charge); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = C.scan; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, r - 1, -Math.PI / 2, -Math.PI / 2 + TAU * charge); ctx.stroke();
    // hand
    const ha = -Math.PI / 2 + TAU * charge;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(ha) * 12, cy + Math.sin(ha) * 12); ctx.lineTo(cx + Math.cos(ha) * (r - 5), cy + Math.sin(ha) * (r - 5)); ctx.stroke();
    ctx.fillStyle = 'rgba(3,6,12,0.9)';
    ctx.beginPath(); ctx.arc(cx, cy, 11.5, 0, TAU); ctx.fill();
    // active pulse
    if (sc.t >= 0) {
      const k = clamp(sc.t / 40);
      ctx.strokeStyle = rgba(C.scan, 1 - k); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, r + 4 + k * 26, 0, TAU); ctx.stroke();
    } else if (ready) {
      const k = (frame % 90) / 90;
      ctx.strokeStyle = rgba(C.scan, 0.5 * (1 - k)); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r + 5 + k * 10, 0, TAU); ctx.stroke();
    }
    txt(ctx, ready ? 'SCAN' : (sc.cd / 60).toFixed(1), cx, cy + 4, ready ? 10 : 11, ready ? '#fff' : C.scan, 'center', 'bold');
    txtS(ctx, 'SCAN [E]', cx + r + 12, cy - 2, 10, ready ? C.scan : C.dim, 'left', 'bold');
    txtS(ctx, ready ? 'READY' : 'RECHARGING', cx + r + 12, cy + 11, 8, ready ? C.good : rgba(C.dim, 0.9), 'left', 'bold');
  }

  drawKeys(ctx, run, def, frame) {
    const n = run.keys.length, kw = 18, kh = 24, gap = 6;
    const x1 = VW - 16, y = VH - 38;
    const x0 = x1 - n * (kw + gap) + gap;
    const locked = run.doorLocked();
    ctx.fillStyle = 'rgba(2,5,10,0.6)';
    ctx.fillRect(x0 - 50, y - 18, x1 - x0 + 58, kh + 26);
    txtS(ctx, `KEYCARDS ${run.keysTaken}/${n}`, x1, y - 6, 9, C.key, 'right', 'bold');
    run.keys.forEach((k, i) => {
      const kx = x0 + i * (kw + gap);
      const flash = k.taken && this.keyFlash > 0 && (this.keyFlash >> 2) % 2 === 0;
      if (k.taken) {
        ctx.fillStyle = flash ? '#fff' : C.key;
        ctx.fillRect(kx, y, kw, kh);
        ctx.fillStyle = '#5a4300';
        ctx.fillRect(kx + 3, y + 4, 7, 6); ctx.fillRect(kx + 3, y + 14, 12, 2); ctx.fillRect(kx + 3, y + 18, 8, 2);
      } else {
        ctx.strokeStyle = rgba(C.key, 0.6); ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(kx + 0.5, y + 0.5, kw - 1, kh - 1);
        ctx.setLineDash([]);
      }
    });
    // padlock
    const lx = x0 - 34, ly = y + 6, col = locked ? C.warn : C.good;
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath();
    if (locked) ctx.arc(lx + 7, ly, 5, Math.PI, 0);
    else ctx.arc(lx + 7, ly - 3, 5, Math.PI, -0.2);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.fillRect(lx, ly, 14, 11);
    ctx.fillStyle = '#000'; ctx.fillRect(lx + 6, ly + 3, 2, 5);
    txtS(ctx, locked ? 'EXIT' : 'OPEN', lx + 7, ly + 22, 8, col, 'center', 'bold');
    void def; void frame;
  }

  /** Bottom-centre status for weird physics zones. */
  drawStatus(ctx, run, frame) {
    const p = run.player;
    const msgs = [];
    if (p.reversed) msgs.push(['EMP · CONTROLS REVERSED', C.warn]);
    if (p.gdir < 0) msgs.push(['GRAVITY INVERTED', C.scan]);
    msgs.forEach(([s, col], i) => {
      if (p.reversed && i === 0 && (frame >> 3) % 3 === 0) return;
      const y = VH - 14 - i * 16;
      const w = textW(ctx, s, 10, 'bold') + 20;
      ctx.fillStyle = 'rgba(2,5,10,0.7)'; ctx.fillRect(VW / 2 - w / 2, y - 11, w, 15);
      txt(ctx, s, VW / 2, y, 10, col, 'center', 'bold');
    });
  }
}

