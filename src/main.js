// App bootstrap: state machine, fixed 60 Hz loop, rendering + audio glue.
//
// States:  intro | menu | select | howto | brief | play | pause | debrief
// A mission is endless retries of mission #m. EVERY attempt (first try,
// after a death, after a restart) gets a freshly generated trap matrix
// (gen.js) that never matches an earlier attempt's matrix.

import { STEP_MS } from './physics.js';
import { LevelRun } from './game.js';
import { generateMission } from './gen.js';
import { randomSeed } from './rng.js';
import { Input, isTouchDevice } from './input.js';
import { Sfx } from './audio.js';
import { loadSave, writeSave, recordDeath, recordClear, pushHistory, missionRecord } from './storage.js';
import { Camera, Particles, WorldRenderer, VIEW_W, VIEW_H } from './render.js';
import { PostFX } from './fx.js';
import { Hud } from './hud.js';
import * as UI from './ui.js';

const DEATH_FRAMES = 42;     // glitch + "recalibrating" before the new matrix appears
const DEATH_SKIP = 14;       // a jump press after this many frames skips the rest
const REBUILD_FRAMES = 26;   // new matrix materialises (sim paused)
const WIN_DELAY = 45;
const BURN_FRAMES = 70;      // briefing self-destructs into the level

export function rankFor(deaths, frames, par) {
  if (deaths === 0 && frames <= par) return 'GHOST';
  if (deaths <= 2) return 'AGENT';
  if (deaths <= 8) return 'OPERATIVE';
  return 'ROOKIE';
}

class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.save = loadSave();
    this.sfx = new Sfx();
    this.sfx.enabled = this.save.sound;
    this.sfx.musicEnabled = this.save.music;
    this.input = new Input();
    this.cam = new Camera();
    this.particles = new Particles();
    this.renderer = new WorldRenderer();
    this.fx = new PostFX(canvas);
    this.hud = new Hud();
    this.frame = 0;
    this.toastMsg = null;
    this.mission = 1;
    this.def = null;
    this.run = null;
    this.attempt = 0;
    this.missionDeaths = 0;
    this.missionFrames = 0;     // total frames spent on this mission (all attempts)
    this.scansUsed = 0;
    this.deathT = -1;           // frames since death, -1 = alive
    this.deathInfo = null;
    this.rebuildT = -1;         // frames into the matrix rebuild sweep, -1 = none
    this.burnT = -1;            // frames into the briefing burn, -1 = none
    this.winT = 0;
    this.debug = new URLSearchParams(location.search).get('debug') === '1' ? { god: false, zones: false } : null;

    this.touchUI = document.getElementById('touch');
    if (isTouchDevice()) this.input.bindTouch(this.touchUI, () => this.pause());
    this.introT = 0;
    this.setState('intro');       // opening credit, then the HQ menu

    const unlock = () => this.sfx.unlock();
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);
    canvas.addEventListener('pointerdown', e => this.onPointer(e));
    canvas.addEventListener('pointermove', e => this.onPointerMove(e));
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
    this.resize();

    // Deep link (debug): ?debug=1&mission=12[&seed=123]
    const q = new URLSearchParams(location.search);
    if (this.debug && q.get('mission')) {
      this.startMission(+q.get('mission'), q.get('seed') ? +q.get('seed') : undefined);
      this.acceptBriefing(true);
    }

    this.last = performance.now();
    this.acc = 0;
    requestAnimationFrame(t => this.loop(t));
  }

  // ------------------------------------------------------------------ helpers
  setState(state, screen = null) {
    this.state = state;
    this.screen = screen;
    this.touchUI.classList.toggle('hidden', !(state === 'play' && isTouchDevice()));
    this.sfx.setMusic(state === 'play' || state === 'pause' ? 'play' : 'menu');
  }

  endIntro() {
    if (this.state === 'intro') this.setState('menu', UI.buildMainMenu(this));
  }

  toast(text) { this.toastMsg = { text, t: 150 }; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H);
    const cssW = Math.floor(VIEW_W * scale), cssH = Math.floor(VIEW_H * scale);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.fx.resize();
  }

  // ------------------------------------------------------------------ missions
  /** Open the briefing for mission m (first matrix generated immediately). */
  startMission(m, seed) {
    this.mission = m;
    this.attempt = 0;
    this.missionDeaths = 0;
    this.missionFrames = 0;
    this.scansUsed = 0;
    this.newMatrix(seed);
    this.setState('brief', UI.buildBriefing(this));
    this.briefT = 0;
    this.sfx.play('brief');
  }

  /** Generate a never-seen-before trap matrix for the current mission and start a fresh attempt on it. */
  newMatrix(seed = randomSeed()) {
    const history = this.save.history[this.mission] ?? [];
    this.def = generateMission(this.mission, seed, history);
    pushHistory(this.save, this.mission, this.def.signature);
    writeSave(this.save);
    this.attempt++;
    this.run = new LevelRun(this.def, { god: !!this.debug?.god });
    this.renderer.setRun(this.run);
    this.cam.snap(this.run);
    this.hud.reset(this.run);
    this.particles.clear();
    this.deathT = -1;
    this.winT = 0;
  }

  /** Briefing accepted: the dossier burns away into the level. */
  acceptBriefing(instant = false) {
    this.setState('play');
    if (instant) { this.burnT = -1; return; }
    this.fx.captureBurn(this.ctx);
    this.burnT = 0;
    this.sfx.play('burn');
  }

  /** Abort this attempt (restart key / pause menu): new matrix, not counted as a death. */
  abortAttempt() {
    if (!this.run) return;
    this.missionFrames += this.run.frame;
    this.newMatrix();
    this.rebuildT = 0;
    this.sfx.play('rebuild');
    this.setState('play');
  }

  pause() {
    if (this.state !== 'play') return;
    this.setState('pause', UI.buildPause(this));
    this.sfx.play('click');
  }

  finishMission() {
    const run = this.run;
    this.missionFrames += run.frame;
    const rank = rankFor(this.missionDeaths, run.frame, this.def.par);
    const res = recordClear(this.save, this.mission, { deaths: this.missionDeaths, frames: run.frame, rank });
    this.save.highest = Math.max(this.save.highest, this.mission + 1);
    writeSave(this.save);
    const rec = missionRecord(this.save, this.mission);
    this.debrief = {
      mission: this.mission, def: this.def, rank, frames: run.frame, par: this.def.par,
      deaths: this.missionDeaths, attempts: this.attempt, scans: this.scansUsed + run.scan.uses,
      totalFrames: this.missionFrames, ...res, bestFrames: rec.bestFrames, bestRank: rec.bestRank,
    };
    this.setState('debrief', UI.buildDebrief(this));
    this.debriefT = 0;
    this.sfx.play('stamp');
  }

  // ------------------------------------------------------------------ input
  toView(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * VIEW_W, y: (e.clientY - r.top) / r.height * VIEW_H + (this.screen?.scroll ?? 0) };
  }

  onPointer(e) {
    if (this.state === 'intro') { if (this.introT > 15) this.endIntro(); return; }
    if (!this.screen) return;
    if (this.state === 'brief' && !this.screen.items.length) { this.activate({ action: 'accept' }); return; }
    const { x, y } = this.toView(e);
    const i = UI.hitTest(this.screen, x, y);
    if (i >= 0) { this.screen.sel = i; this.activate(this.screen.items[i]); }
  }

  onPointerMove(e) {
    if (!this.screen || e.pointerType === 'touch') return;
    const { x, y } = this.toView(e);
    const i = UI.hitTest(this.screen, x, y);
    if (i >= 0 && i !== this.screen.sel) { this.screen.sel = i; this.sfx.play('hover'); }
  }

  handlePresses() {
    for (const code of this.input.consumePresses()) {
      if (this.state === 'intro') { if (this.introT > 15) this.endIntro(); continue; }
      if (this.state === 'play') {
        if (code === 'Escape' || code === 'KeyP') this.pause();
        else if (code === 'KeyR' && this.deathT < 0 && this.rebuildT < 0) this.abortAttempt();
        else if (this.debug) this.debugKey(code);
        if (this.deathT >= DEATH_SKIP && ['Space', 'ArrowUp', 'KeyW', 'Enter'].includes(code)) this.respawn();
        continue;
      }
      if (!this.screen) continue;
      if (code === 'Enter' || code === 'Space') {
        const it = this.screen.items[this.screen.sel];
        if (it && !it.disabled) this.activate(it);
        else if (this.state === 'brief') this.activate({ action: 'accept' });
      } else if (code === 'Escape' || code === 'Backspace' || (code === 'KeyP' && this.state === 'pause')) {
        if (this.screen.back) this.activate({ action: this.screen.back });
      } else if (UI.navigate(this.screen, code)) {
        this.sfx.play('hover');
      }
    }
  }

  debugKey(code) {
    const dbg = this.debug;
    if (code === 'KeyG') { dbg.god = !dbg.god; this.run.god = dbg.god; this.toast(`God mode ${dbg.god ? 'ON' : 'OFF'}`); }
    else if (code === 'KeyH') { dbg.zones = !dbg.zones; this.toast(`Trap zones ${dbg.zones ? 'ON' : 'OFF'}`); }
    else if (code === 'KeyN') { this.startMission(this.mission + 1); this.acceptBriefing(true); }
    else if (code === 'KeyB') { this.startMission(Math.max(1, this.mission - 1)); this.acceptBriefing(true); }
    else if (code === 'KeyM') { this.abortAttempt(); this.toast(`Matrix ${this.def.matrix}: ${this.def.slots.join(' ')}`); }
  }

  activate(it) {
    this.sfx.play('click');
    switch (it.action) {
      case 'continue': this.startMission(Math.max(1, this.save.highest)); break;
      case 'mission': this.startMission(it.mission); break;
      case 'select': this.setState('select', UI.buildSelect(this)); break;
      case 'page': this.setState('select', UI.buildSelect(this, it.page)); break;
      case 'howto': this.setState('howto', UI.buildHowTo(this)); break;
      case 'toggle': {
        this.save[it.key] = !this.save[it.key];
        if (it.key === 'sound') this.sfx.enabled = this.save.sound;
        if (it.key === 'music') { this.sfx.musicEnabled = this.save.music; this.sfx.setMusic(this.state === 'pause' ? 'play' : 'menu'); }
        writeSave(this.save);
        const sel = this.screen.sel;
        this.screen = this.state === 'pause' ? UI.buildPause(this) : UI.buildMainMenu(this);
        this.screen.sel = sel;
        break;
      }
      case 'accept': this.acceptBriefing(); break;
      case 'resume': this.setState('play'); break;
      case 'retry': this.abortAttempt(); break;
      case 'next': this.startMission(this.mission + 1); break;
      case 'replay': this.startMission(this.mission); break;
      case 'back':
      case 'menu': this.setState('menu', UI.buildMainMenu(this)); break;
    }
  }

  // ------------------------------------------------------------------ simulation tick (fixed 60 Hz)
  tick() {
    this.frame++;
    if (this.state === 'intro' && ++this.introT >= UI.INTRO_FRAMES) this.endIntro();
    if (this.state === 'brief') this.briefT++;
    if (this.state === 'debrief') this.debriefT++;
    if (this.burnT >= 0 && ++this.burnT >= BURN_FRAMES) this.burnT = -1;

    if (this.state === 'play') {
      const run = this.run;
      if (this.deathT >= 0) {
        if (++this.deathT >= DEATH_FRAMES) this.respawn();
      } else if (this.rebuildT >= 0) {
        if (++this.rebuildT >= REBUILD_FRAMES) this.rebuildT = -1;
      } else if (this.burnT < 0 || this.burnT > BURN_FRAMES * 0.55) {
        run.step(this.input.mask());
        for (const e of run.events) this.onEvent(e);
        if (run.state === 'won' && ++this.winT >= WIN_DELAY) this.finishMission();
      }
      this.cam.update(run);
      this.hud.update(run, this);
    }
    this.input.endStep();
    this.particles.update();
    if (this.toastMsg) this.toastMsg.t--;
  }

  /** After death: brand-new matrix, rebuild sweep. */
  respawn() {
    if (this.deathT < 0) return;
    this.missionFrames += this.run.frame;
    this.scansUsed += this.run.scan.uses;
    this.newMatrix();
    this.rebuildT = 0;
    this.sfx.play('rebuild');
  }

  onEvent(e) {
    const run = this.run;
    this.renderer.onEvent(e, run, this.particles, this.cam);
    this.hud.onEvent(e, run);
    switch (e.type) {
      case 'death':
        this.deathT = 0;
        this.deathInfo = { cause: e.cause, x: e.x, y: e.y, taunt: UI.pickTaunt(e.cause), matrix: this.def.matrix };
        this.missionDeaths++;
        recordDeath(this.save, this.mission);
        this.sfx.play('death');
        break;
      case 'win': this.sfx.play('win'); break;
      default: this.sfx.play(e.type, e);   // jump, land, key, fakeKey, trap, nearMiss, door, scan, tag, boom, alarm, slam
    }
  }

  // ------------------------------------------------------------------ render
  render() {
    const ctx = this.ctx, k = this.canvas.width / VIEW_W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = true;
    switch (this.state) {
      case 'intro': UI.drawIntro(ctx, this, this.introT); break;
      case 'menu': UI.drawMainMenu(ctx, this, this.screen, this.frame); break;
      case 'select': UI.drawSelect(ctx, this, this.screen, this.frame); break;
      case 'howto': UI.drawHowTo(ctx, this, this.screen, this.frame); break;
      case 'brief': UI.drawBriefing(ctx, this, this.screen, this.briefT); break;
      default: {
        this.renderer.draw(ctx, this.run, this.cam, this.particles, {
          frame: this.frame,
          rebuild: this.rebuildT >= 0 ? this.rebuildT / REBUILD_FRAMES : -1,
          zones: !!this.debug?.zones,
        });
        this.hud.draw(ctx, this);
        if (this.deathT >= 0) UI.drawDeath(ctx, this, this.deathT, DEATH_FRAMES);
        if (this.rebuildT >= 0) UI.drawRebuild(ctx, this, this.rebuildT / REBUILD_FRAMES);
        if (this.state === 'pause') UI.drawPause(ctx, this, this.screen, this.frame);
        if (this.state === 'debrief') UI.drawDebrief(ctx, this, this.screen, this.debriefT);
      }
    }
    UI.drawToast(ctx, this.toastMsg);

    // post-processing (device pixels)
    const glitch = this.deathT >= 0 ? Math.max(0, 1 - this.deathT / 18) : this.hud.glitch;
    if (this.burnT >= 0) this.fx.drawBurn(this.ctx, this.burnT / BURN_FRAMES);
    this.fx.post(this.ctx, { effects: this.save.fx, glitch, frame: this.frame, danger: this.state === 'play' ? this.hud.danger : 0 });
  }

  loop(now) {
    const dt = Math.min(250, now - this.last);
    this.last = now;
    this.handlePresses();
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP_MS && steps < 8) { this.tick(); this.acc -= STEP_MS; steps++; }
    if (steps === 8) this.acc = 0;
    this.sfx.update(this.state === 'play' ? this.hud.danger : 0, this.state);
    this.render();
    requestAnimationFrame(t => this.loop(t));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.missionImpossible = new App(document.getElementById('game'));
});
