// Procedural audio with the Web Audio API: no sound files at all.
//
//   Sfx.play(name, data)   one-shot sound effects (unknown names are silent)
//   Sfx.setMusic(mode)     'menu' (dark ambient spy pad) | 'play' (tension groove)
//   Sfx.update(danger, st) called every render frame: drives the look-ahead
//                          music scheduler and the adaptive mix.
//
// The music is original and generated on the fly (no film themes or other
// existing melodies). The groove follows `danger` (0..1): more layers, an
// opening filter, a slightly faster pulse and a heartbeat above 0.6.
//
// Routing:  voices -> sfxBus ---------------------\
//           voices -> section (filter/duck/fade) -> musicBus -> compressor -> out
// No AudioContext exists until unlock() (called from a user gesture), and
// nothing touches the DOM or audio at import time.

const LOOKAHEAD = 0.2;            // seconds of music scheduled ahead of currentTime
const DEFAULT_GAP = 0.018;        // the same sound never retriggers faster than this
const MIN_GAP = {
  hover: 0.05, type: 0.03, land: 0.08, click: 0.03, nearMiss: 0.14, tag: 0.035, trap: 0.03,
  key: 0.05, fakeKey: 0.1, alarm: 0.45, scan: 0.12, slam: 0.05, boom: 0.04, jump: 0.04,
  rebuild: 0.2, brief: 0.3, burn: 0.3, stamp: 0.1, win: 0.5, death: 0.25, door: 0.1,
};

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp01 = v => (v > 1 ? 1 : v > 0 ? v : 0);

// ---- music material (original) -------------------------------------------
// Menu pad: slow, dark chords (midi notes), one every 8 s, long crossfades.
const PAD_CHORDS = [[38, 45, 53], [34, 41, 50], [36, 43, 51], [33, 45, 52]];
// Play groove: 16-step bass ostinato (semitones over the bar root, null = rest).
const BASS = [0, null, 0, 0, null, 0, 12, null, 0, null, 0, 0, 3, null, 2, -2];
const BASS_ACCENT = [1, 0, 0, 0, 0, 0, 0.5, 0, 1, 0, 0, 0, 0.6, 0, 0, 0];
const ROOTS = [38, 38, 34, 36, 38, 38, 41, 37];      // 8-bar cycle (D, D, Bb, C, D, D, F, C#)
const ARP = [12, 15, 19, 22, 24, 22, 19, 15];         // minor-7 arpeggio over the root

export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;          // sound effects on/off
    this.musicEnabled = true;     // music on/off (independent of `enabled`)
    this.mode = null;             // requested music mode
    this.section = null;          // currently playing music section
    this.retired = [];            // sections fading out
    this.last = Object.create(null);
    this.danger = 0;              // smoothed danger
    this.state = '';
  }

  /** Must be called from a user gesture (browsers block autoplay). Cheap to call repeatedly. */
  unlock() {
    try {
      if (!this.ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        const c = new AC();
        const comp = c.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 8;
        comp.ratio.value = 8;
        comp.attack.value = 0.003;
        comp.release.value = 0.18;
        const out = c.createGain();
        out.gain.value = 0.85;
        comp.connect(out);
        out.connect(c.destination);
        this.sfxBus = c.createGain();
        this.sfxBus.gain.value = 0.6;
        this.sfxBus.connect(comp);
        this.musicBus = c.createGain();
        this.musicBus.gain.value = 0.3;
        this.musicBus.connect(comp);
        const len = Math.floor(c.sampleRate * 2);
        this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        // iOS: play one silent sample inside the gesture to fully unlock output.
        const s = c.createBufferSource();
        s.buffer = c.createBuffer(1, 1, c.sampleRate);
        s.connect(c.destination);
        s.start(0);
        this.ctx = c;
      }
      if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
        const p = this.ctx.resume?.();
        p?.catch?.(() => {});
      }
    } catch { this.ctx = null; }
  }

  // ------------------------------------------------------------------ voices
  /** Run `src` through an optional filter and an envelope into `dest`. Returns the envelope gain. */
  voice(src, t, dur, { vol = 0.2, attack = 0.006, hold = 0, dest = this.sfxBus, filter = null, release = 'exp' } = {}) {
    const c = this.ctx, g = c.createGain();
    let node = src;
    if (filter) {
      const f = c.createBiquadFilter();
      f.type = filter.type ?? 'lowpass';
      f.frequency.setValueAtTime(filter.freq ?? 1000, t);
      if (filter.sweep) f.frequency.exponentialRampToValueAtTime(Math.max(20, filter.sweep), t + (filter.sweepT ?? dur));
      if (filter.q) f.Q.setValueAtTime(filter.q, t);
      node.connect(f);
      node = f;
    }
    const a = Math.min(attack, dur * 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + a);
    if (hold > 0) g.gain.setValueAtTime(Math.max(0.0002, vol), t + a + hold);
    if (release === 'lin') g.gain.linearRampToValueAtTime(0.0001, t + dur);
    else g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g);
    g.connect(dest);
    return g;
  }

  tone(freq, dur, { type = 'square', slide = null, slideT = null, delay = 0, at = null, detune = 0, ...env } = {}) {
    const c = this.ctx, t = (at ?? c.currentTime) + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + (slideT ?? dur));
    if (detune) o.detune.setValueAtTime(detune, t);
    this.voice(o, t, dur, env);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  noise(dur, { type = 'lowpass', freq = 1200, sweep = null, sweepT = null, q = 0, delay = 0, at = null, rate = 1, ...env } = {}) {
    const c = this.ctx, t = (at ?? c.currentTime) + delay;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.setValueAtTime(rate, t);
    this.voice(src, t, dur, { ...env, filter: { type, freq, sweep, sweepT, q } });
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------------ sound effects
  play(name, data = {}) {
    if (!this.enabled || !this.ctx || this.ctx.state === 'closed') return;
    try {
      const fn = SOUNDS[name];
      if (!fn) return;
      const now = this.ctx.currentTime;
      const gap = MIN_GAP[name] ?? DEFAULT_GAP;
      if (now - (this.last[name] ?? -1) < gap) return;
      this.last[name] = now;
      fn(this, data ?? {}, now);
    } catch { /* audio is optional */ }
  }

  // ------------------------------------------------------------------ music
  /** Request a music mode: 'menu' | 'play' (anything else = silence). Idempotent. */
  setMusic(mode) {
    this.mode = mode === 'menu' || mode === 'play' ? mode : null;
  }

  /** Call every render frame. danger 0..1, state = app state ('play', 'pause', ...). */
  update(danger = 0, state = '') {
    const c = this.ctx;
    if (!c) return;
    try {
      this.state = state;
      this.danger += (clamp01(+danger || 0) - this.danger) * 0.05;
      const now = c.currentTime;
      const running = c.state === 'running' || c.state === undefined;
      const want = this.musicEnabled && running ? this.mode : null;
      if ((this.section?.mode ?? null) !== want) {
        this.retire(now);
        if (want) this.section = this.makeSection(want, now);
      }
      if (this.retired.length) {
        this.retired = this.retired.filter(s => {
          if (now < s.until) return true;
          try { s.fade.disconnect(); } catch { /* ignore */ }
          return false;
        });
      }
      const s = this.section;
      if (!s) return;
      this.mix(s, now);
      // A late frame (or a tab that was in the background) must not cause a
      // burst of catch-up notes: skip the missed steps and resync instead.
      if (s.next < now) { s.next = now + 0.04; }
      let n = 0;
      while (s.next < now + LOOKAHEAD && n++ < 48) {
        const t = s.next;
        if (s.mode === 'menu') this.menuStep(s, t); else this.playStep(s, t);
        s.next = t + this.stepDur(s);
        s.step++;
      }
    } catch { /* audio is optional */ }
  }

  makeSection(mode, now) {
    const c = this.ctx;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = mode === 'menu' ? 700 : 500;
    filter.Q.value = 0.8;
    const duck = c.createGain();
    duck.gain.value = 1;
    const fade = c.createGain();
    fade.gain.setValueAtTime(0.0001, now);
    fade.gain.setTargetAtTime(1, now, mode === 'menu' ? 0.9 : 0.35);
    filter.connect(duck);
    duck.connect(fade);
    fade.connect(this.musicBus);
    return { mode, filter, duck, dry: duck, fade, next: now + 0.08, step: 0, cut: -1, lvl: -1 };
  }

  retire(now) {
    const s = this.section;
    this.section = null;
    if (!s) return;
    try { s.fade.gain.setTargetAtTime(0.0001, now, 0.22); } catch { /* ignore */ }
    s.until = now + 1.6;
    this.retired.push(s);
  }

  stepDur(s) {
    if (s.mode === 'menu') return 0.5;
    const bpm = 98 + 18 * this.danger;            // 16th-note grid
    return 60 / bpm / 4;
  }

  /** Adaptive mix: filter opens with danger, music ducks while paused. */
  mix(s, now) {
    const d = this.danger, paused = this.state === 'pause';
    const cut = s.mode === 'menu' ? 750 : paused ? 420 : 420 + 2600 * d * d + 500 * d;
    const lvl = paused ? 0.45 : s.mode === 'play' ? 0.85 + 0.25 * d : 1;
    if (Math.abs(cut - s.cut) > s.cut * 0.03) { s.filter.frequency.setTargetAtTime(cut, now, 0.12); s.cut = cut; }
    if (Math.abs(lvl - s.lvl) > 0.02) { s.duck.gain.setTargetAtTime(lvl, now, 0.25); s.lvl = lvl; }
  }

  /** Menu: dark ambient spy pad (detuned drones, sparse sonar pings). One step = 0.5 s. */
  menuStep(s, t) {
    const i = s.step;
    if (i % 16 === 0) {
      const chord = PAD_CHORDS[(i / 16) % PAD_CHORDS.length];
      const dur = 11.5;
      chord.forEach((m, k) => {
        for (const det of [-9, 8]) {
          this.tone(mtof(m), dur, { type: 'sawtooth', detune: det + rnd(-2, 2), at: t + k * 0.35, vol: 0.05, attack: 3.2, hold: dur - 7.5, release: 'lin', dest: s.filter });
        }
      });
      this.tone(mtof(chord[0] - 12), dur, { type: 'sine', at: t, vol: 0.12, attack: 2.5, hold: dur - 6.5, release: 'lin', dest: s.filter });
    }
    // Sonar ping with two echoes, every ~6-10 s.
    if (i % 4 === 2 && Math.random() < 0.3) {
      const f = [1318.5, 1567.98, 1174.66][Math.floor(Math.random() * 3)];
      [0, 0.42, 0.84].forEach((dt, k) => {
        this.tone(f, 1.6 - k * 0.3, { type: 'sine', at: t + dt, vol: 0.05 / (1 + k * 1.6), attack: 0.004, dest: s.dry });
      });
    }
    // Very soft low pulse, like a distant engine.
    if (i % 8 === 4 && Math.random() < 0.6) {
      this.tone(mtof(26), 1.4, { type: 'sine', at: t, vol: 0.08, attack: 0.25, dest: s.filter });
    }
  }

  /** Play: tension groove on a 16th grid; layers enter as danger rises. */
  playStep(s, t) {
    const d = this.danger, i = s.step % 16, bar = Math.floor(s.step / 16);
    const root = ROOTS[bar % ROOTS.length];
    const sd = this.stepDur(s);
    const paused = this.state === 'pause';

    // Bass ostinato (always).
    const off = BASS[i];
    if (off !== null) {
      const acc = BASS_ACCENT[i];
      const f = mtof(root + off);
      this.tone(f, sd * 0.9, { type: 'sawtooth', at: t, vol: 0.16 + 0.1 * acc, attack: 0.004, dest: s.filter });
      this.tone(f / 2, sd * 0.9, { type: 'square', at: t, vol: 0.05 + 0.04 * acc, attack: 0.004, dest: s.filter });
    }
    if (paused) return;

    // Muted percussion ticks: 8ths, offbeats accented; 16ths when tense.
    if (i % 2 === 0) this.noise(0.028, { type: 'highpass', freq: 7000, at: t, vol: i % 4 === 2 ? 0.05 : 0.025, attack: 0.001, dest: s.dry });
    else if (d > 0.35) this.noise(0.02, { type: 'highpass', freq: 8500, at: t, vol: 0.012 + 0.02 * d, attack: 0.001, dest: s.dry });

    // Muted kick on 1 and 3 (and an extra push when danger is high).
    if (i === 0 || i === 8 || (d > 0.5 && i === 11)) {
      this.tone(120, 0.14, { type: 'sine', slide: 42, at: t, vol: 0.32, attack: 0.002, dest: s.dry });
    }
    // Rim tick on 2 and 4.
    if ((i === 4 || i === 12) && d > 0.18) {
      this.noise(0.05, { type: 'bandpass', freq: 1900, q: 3, at: t, vol: 0.05 + 0.06 * d, attack: 0.001, dest: s.dry });
    }
    // High arpeggio layer.
    if (d > 0.5 && i % 2 === 1) {
      const n = ARP[((bar * 8) + (i >> 1)) % ARP.length];
      this.tone(mtof(root + n + 12), sd * 1.6, { type: 'triangle', at: t, vol: 0.02 + 0.035 * (d - 0.5) * 2, attack: 0.003, dest: s.dry });
    }
    // Occasional minor stab at the end of a phrase.
    if (i === 14 && bar % 4 === 3 && Math.random() < 0.35 + 0.5 * d) {
      for (const n of [12, 15, 19]) {
        this.tone(mtof(root + n), 0.22, { type: 'sawtooth', at: t, detune: rnd(-6, 6), vol: 0.06, attack: 0.005, dest: s.filter });
      }
    }
    // Heartbeat (lub-dub) when danger > 0.6.
    if (d > 0.6 && (i === 0 || i === 8)) {
      const v = 0.12 + 0.3 * ((d - 0.6) / 0.4);
      this.tone(62, 0.16, { type: 'sine', slide: 40, at: t, vol: v, attack: 0.006, dest: s.dry });
      this.tone(55, 0.14, { type: 'sine', slide: 36, at: t + 0.17, vol: v * 0.7, attack: 0.006, dest: s.dry });
    }
  }
}

// ---- sound effect recipes ---------------------------------------------------
// fn(sfx, data, now)
const SOUNDS = {
  jump(a) {
    a.tone(330, 0.1, { type: 'square', slide: 640, vol: 0.07 });
    a.tone(660, 0.07, { type: 'triangle', slide: 1100, vol: 0.04 });
  },
  land(a) {
    a.noise(0.05, { freq: 420, vol: 0.09 });
    a.tone(95, 0.07, { type: 'sine', slide: 50, vol: 0.12 });
  },
  key(a) {
    a.tone(1174.66, 0.09, { type: 'triangle', vol: 0.14 });
    a.tone(1567.98, 0.2, { type: 'triangle', vol: 0.13, delay: 0.07 });
    a.tone(3135.96, 0.18, { type: 'sine', vol: 0.03, delay: 0.07 });
  },
  fakeKey(a) {
    a.tone(1174.66, 0.08, { type: 'triangle', vol: 0.13 });
    a.tone(420, 0.45, { type: 'sawtooth', slide: 70, vol: 0.12, delay: 0.08, filter: { type: 'lowpass', freq: 1800 } });
    a.tone(440, 0.45, { type: 'sawtooth', slide: 75, vol: 0.06, delay: 0.1, detune: 30, filter: { type: 'lowpass', freq: 1800 } });
  },
  trap(a) {
    a.noise(0.03, { type: 'highpass', freq: 3200, vol: 0.16, attack: 0.001 });
    a.tone(150, 0.12, { type: 'square', slide: 55, vol: 0.12, filter: { type: 'lowpass', freq: 900 } });
  },
  nearMiss(a) {
    a.noise(0.2, { type: 'bandpass', freq: 3200, sweep: 500, q: 1.5, vol: 0.14, attack: 0.02 });
  },
  door(a) {
    a.noise(0.4, { type: 'lowpass', freq: 250, sweep: 1600, vol: 0.12, attack: 0.05 });
    [523.25, 783.99, 1046.5].forEach((f, i) => a.tone(f, 0.22, { type: 'sine', vol: 0.12, delay: 0.12 + i * 0.07 }));
  },
  scan(a) {
    // Sonar sweep: rising filtered whoosh + a ping with two echoes.
    a.noise(0.35, { type: 'bandpass', freq: 400, sweep: 4000, q: 4, vol: 0.06, attack: 0.05 });
    [0, 0.3, 0.6].forEach((dt, k) => {
      a.tone(1480, 0.9 - k * 0.2, { type: 'sine', slide: 1400, vol: 0.14 / (1 + k * 1.7), attack: 0.003, delay: 0.05 + dt });
    });
  },
  tag(a, d) {
    if (d.hidden) {        // threat lock: sharp double blip
      a.tone(1975.5, 0.045, { type: 'square', vol: 0.07, attack: 0.001, filter: { type: 'lowpass', freq: 5000 } });
      a.tone(2637, 0.07, { type: 'square', vol: 0.07, attack: 0.001, delay: 0.055, filter: { type: 'lowpass', freq: 5000 } });
    } else {
      a.tone(1318.5, 0.06, { type: 'sine', vol: 0.06, attack: 0.002 });
    }
  },
  boom(a, d) {
    if (d.harmless) {      // small pop
      a.noise(0.12, { freq: 1600, sweep: 300, vol: 0.18, attack: 0.002 });
      a.tone(320, 0.1, { type: 'sine', slide: 120, vol: 0.12 });
      return;
    }
    a.noise(0.9, { freq: 2400, sweep: 70, vol: 0.55, attack: 0.002 });
    a.noise(0.25, { type: 'highpass', freq: 1500, vol: 0.18, attack: 0.001 });
    a.tone(130, 0.7, { type: 'sine', slide: 28, vol: 0.45, attack: 0.002 });
    a.tone(70, 0.5, { type: 'triangle', slide: 30, vol: 0.2, delay: 0.03 });
  },
  alarm(a) {
    // Two-tone facility siren burst.
    for (let i = 0; i < 4; i++) {
      const f = i % 2 ? 622.25 : 830.61;
      a.tone(f, 0.17, { type: 'sawtooth', slide: f * 1.04, vol: 0.06, attack: 0.01, hold: 0.11, delay: i * 0.18, filter: { type: 'lowpass', freq: 2400 } });
      a.tone(f / 2, 0.17, { type: 'square', vol: 0.025, attack: 0.01, hold: 0.11, delay: i * 0.18, filter: { type: 'lowpass', freq: 1200 } });
    }
  },
  slam(a, d) {
    const k = d.soft ? 0.5 : 1;
    a.tone(d.soft ? 150 : 110, 0.28, { type: 'sine', slide: 38, vol: 0.38 * k, attack: 0.002 });
    a.noise(d.soft ? 0.1 : 0.2, { freq: d.soft ? 1200 : 700, vol: 0.32 * k, attack: 0.001 });
    a.noise(0.025, { type: 'highpass', freq: 2500, vol: 0.12 * k, attack: 0.001 });
  },
  death(a) {
    // Glitchy crunch...
    for (let i = 0; i < 10; i++) {
      a.tone(rnd(90, 1700), 0.035, { type: Math.random() < 0.5 ? 'square' : 'sawtooth', vol: 0.08, attack: 0.001, delay: i * 0.027 });
    }
    a.noise(0.32, { type: 'bandpass', freq: 3000, sweep: 250, q: 0.8, vol: 0.3, attack: 0.001 });
    a.tone(200, 0.38, { type: 'sawtooth', slide: 38, vol: 0.13, filter: { type: 'lowpass', freq: 1400 } });
    // ...then a flatline.
    a.tone(987.77, 1.05, { type: 'sine', vol: 0.06, attack: 0.01, hold: 0.75, delay: 0.42 });
  },
  win(a) {
    [587.33, 698.46, 880, 1174.66].forEach((f, i) => a.tone(f, 0.22, { type: 'triangle', vol: 0.12, delay: i * 0.085 }));
    for (const f of [587.33, 880, 1108.73, 1318.51]) {
      a.tone(f, 1.2, { type: 'triangle', vol: 0.06, attack: 0.02, delay: 0.36 });
    }
    a.tone(2349.3, 0.8, { type: 'sine', vol: 0.025, delay: 0.4 });
  },
  click(a) {
    a.tone(900, 0.035, { type: 'square', vol: 0.045, attack: 0.001, filter: { type: 'lowpass', freq: 3000 } });
  },
  hover(a) {
    a.tone(1800, 0.025, { type: 'sine', vol: 0.014, attack: 0.002 });
  },
  brief(a) {
    // Incoming transmission: modem-like chirps over a crackle.
    a.noise(0.5, { type: 'bandpass', freq: 2200, q: 0.7, vol: 0.035, attack: 0.02 });
    a.tone(700, 0.09, { type: 'sine', slide: 1500, vol: 0.08 });
    a.tone(1500, 0.09, { type: 'sine', slide: 900, vol: 0.07, delay: 0.1 });
    for (let i = 0; i < 6; i++) {
      a.tone(rnd(1200, 2600), 0.03, { type: 'square', vol: 0.025, attack: 0.001, delay: 0.24 + i * 0.04, filter: { type: 'lowpass', freq: 4000 } });
    }
    a.tone(1760, 0.12, { type: 'sine', vol: 0.06, delay: 0.52 });
  },
  burn(a) {
    // Paper ignites: whoosh, then crackle.
    a.noise(0.7, { type: 'bandpass', freq: 350, sweep: 3200, q: 0.9, vol: 0.2, attack: 0.25 });
    a.noise(1.2, { type: 'lowpass', freq: 900, vol: 0.06, attack: 0.3, delay: 0.2 });
    for (let i = 0; i < 18; i++) {
      a.noise(rnd(0.008, 0.025), { type: 'highpass', freq: rnd(2500, 6000), vol: rnd(0.04, 0.12), attack: 0.001, delay: 0.15 + Math.random() * 1.1 });
    }
  },
  rebuild(a) {
    // Digital matrix rebuild: filtered sweep plus quantized data steps.
    a.tone(80, 0.5, { type: 'sawtooth', slide: 1600, vol: 0.07, filter: { type: 'bandpass', freq: 300, sweep: 3000, q: 3 } });
    for (let i = 0; i < 10; i++) {
      a.tone(mtof(64 + Math.floor(Math.random() * 4) * 5 + i), 0.035, { type: 'square', vol: 0.03, attack: 0.001, delay: i * 0.042, filter: { type: 'lowpass', freq: 3500 } });
    }
    a.tone(1318.5, 0.18, { type: 'sine', vol: 0.06, delay: 0.44 });
  },
  stamp(a) {
    a.tone(95, 0.32, { type: 'sine', slide: 38, vol: 0.5, attack: 0.002 });
    a.noise(0.14, { freq: 800, vol: 0.4, attack: 0.001 });
    a.noise(0.02, { type: 'highpass', freq: 3000, vol: 0.16, attack: 0.001 });
  },
  type(a) {
    a.noise(0.016, { type: 'highpass', freq: rnd(2800, 4200), vol: 0.06, attack: 0.001 });
    a.tone(rnd(1700, 2300), 0.012, { type: 'square', vol: 0.012, attack: 0.001 });
  },
};
