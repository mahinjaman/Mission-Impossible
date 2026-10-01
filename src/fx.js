// Post-processing in DEVICE pixels: CRT scanlines + film grain + vignette,
// danger pulse, glitch (slice displacement + RGB split) and the briefing
// "self-destruct" burn transition.
//
// Every overlay is pre-rendered (cached per canvas size) and composited with
// a handful of drawImage / pattern fills per frame. No getImageData anywhere;
// the burn writes a small (240x135) ImageData per frame and upscales it.

const BW = 240, BH = 135;  // burn threshold field resolution

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function vignette(w, h, inner, outer, rgb, a0, a1) {
  const c = mk(w, h), g = c.getContext('2d');
  const r = Math.hypot(w, h) / 2;
  const gr = g.createRadialGradient(w / 2, h / 2, r * inner, w / 2, h / 2, r * outer);
  gr.addColorStop(0, `rgba(${rgb},${a0})`);
  gr.addColorStop(1, `rgba(${rgb},${a1})`);
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  return c;
}

/** Smooth value noise in [0,1] on a (gw x gh) lattice, sampled on BW x BH. */
function valueNoise(out, gw, gh, weight) {
  const lat = new Float32Array((gw + 1) * (gh + 1));
  for (let i = 0; i < lat.length; i++) lat[i] = Math.random();
  for (let y = 0; y < BH; y++) {
    const fy = y / BH * gh, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < BW; x++) {
      const fx = x / BW * gw, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
      const a = lat[iy * (gw + 1) + ix], b = lat[iy * (gw + 1) + ix + 1];
      const c = lat[(iy + 1) * (gw + 1) + ix], d = lat[(iy + 1) * (gw + 1) + ix + 1];
      out[y * BW + x] += weight * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
    }
  }
}

export class PostFX {
  constructor(canvas) {
    this.canvas = canvas;
    this.w = 0; this.h = 0;
    this.grainPat = null; this.patCtx = null;
    this.vig = vignette(320, 182, 0.45, 1.0, '0,0,0', 0, 0.62);
    this.dangerV = vignette(320, 182, 0.35, 1.0, '255,30,60', 0, 0.85);
    this.roll = mk(4, 64);
    const rg = this.roll.getContext('2d');
    const gr = rg.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(200,230,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    rg.fillStyle = gr; rg.fillRect(0, 0, 4, 64);
    this.copy = null; this.tint = null;
    this.snap = null; this.tmp = null; this.field = null;
    this.burnDrawn = false;
    this.sparks = [];
  }

  resize() { this.w = 0; this.h = 0; }

  ensure(ctx) {
    const W = this.canvas.width, H = this.canvas.height;
    if (W === this.w && H === this.h && this.patCtx === ctx) return;
    this.w = W; this.h = H; this.patCtx = ctx;
    // scanline + grain tile: period scales with the device resolution
    const period = Math.max(2, Math.round(H / 544 * 2));
    this.period = period;
    const tw = 256, th = period * Math.ceil(128 / period);
    const tile = mk(tw, th), g = tile.getContext('2d');
    const img = g.createImageData(tw, th), d = img.data;
    const dark = Math.max(1, Math.round(period / 2));
    for (let y = 0; y < th; y++) {
      const line = (y % period) < dark;
      for (let x = 0; x < tw; x++) {
        const i = (y * tw + x) * 4, n = Math.random();
        if (line) { d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = 30 + n * 14; }
        else if (n < 0.5) { const v = n < 0.25 ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = Math.random() * 12; }
      }
    }
    g.putImageData(img, 0, 0);
    this.grainTile = tile;
    this.grainPat = ctx.createPattern(tile, 'repeat');
    if (this.copy) { this.copy = null; this.tint = null; }
  }

  // ------------------------------------------------------------------ burn transition
  /** Snapshot the current canvas (the briefing dossier) for the burn. */
  captureBurn(ctx) {
    const c = this.canvas, W = c.width, H = c.height;
    this.snap = mk(W, H);
    this.snap.getContext('2d').drawImage(c, 0, 0);
    this.tmp = mk(W, H);
    // threshold field: fbm value noise + distance from a couple of ignition points
    const f = new Float32Array(BW * BH);
    valueNoise(f, 6, 4, 0.5); valueNoise(f, 14, 8, 0.32); valueNoise(f, 34, 19, 0.18);
    const ign = [];
    const n = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < n; i++) ign.push([Math.random() * BW, BH * (0.35 + Math.random() * 0.65)]);
    const maxD = Math.hypot(BW, BH);
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      let dmin = Infinity;
      for (const [ix, iy] of ign) dmin = Math.min(dmin, Math.hypot(x - ix, (y - iy) * 1.3));
      const v = f[y * BW + x] * 0.55 + (dmin / maxD) * 1.6 * 0.45;
      f[y * BW + x] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) / (hi - lo || 1);
    this.field = f;
    const mkLayer = () => { const cv = mk(BW, BH), g = cv.getContext('2d'); return { c: cv, g, img: g.createImageData(BW, BH) }; };
    this.mask = mkLayer(); this.char = mkLayer(); this.ember = mkLayer();
    this.bloom = mk(BW / 4, BH / 4);
    this.sparks = [];
  }

  /** Burn the captured dossier away (p: 0..1). Device pixels. */
  drawBurn(ctx, p) {
    if (!this.snap || !this.field) return;
    this.burnDrawn = true;
    const c = this.canvas, W = c.width, H = c.height, u = H / 544;
    const th = -0.06 + 1.16 * Math.pow(Math.min(1, Math.max(0, p)), 0.85);
    const F = this.field, md = this.mask.img.data, cd = this.char.img.data, ed = this.ember.img.data;
    const edge = [];
    for (let i = 0, j = 0; i < F.length; i++, j += 4) {
      const v = F[i] - th;
      md[j] = md[j + 1] = md[j + 2] = 255;
      md[j + 3] = v <= 0 ? 0 : v >= 0.03 ? 255 : (v / 0.03) * 255;
      cd[j] = 28; cd[j + 1] = 11; cd[j + 2] = 4;
      cd[j + 3] = v >= 0 && v < 0.09 ? Math.pow(1 - v / 0.09, 1.5) * 235 : 0;
      const av = Math.abs(v);
      if (av < 0.045) {
        const e = 1 - av / 0.045;
        if (e > 0.62) { ed[j] = 255; ed[j + 1] = 236; ed[j + 2] = 180; }
        else { ed[j] = 255; ed[j + 1] = 112; ed[j + 2] = 24; }
        ed[j + 3] = e * 255;
        if (e > 0.8 && edge.length < 400) edge.push(i);
      } else if (v < 0 && v > -0.12) {
        ed[j] = 255; ed[j + 1] = 60; ed[j + 2] = 10; ed[j + 3] = (1 - (av - 0.045) / 0.075) * 70;
      } else ed[j + 3] = 0;
    }
    this.mask.g.putImageData(this.mask.img, 0, 0);
    this.char.g.putImageData(this.char.img, 0, 0);
    this.ember.g.putImageData(this.ember.img, 0, 0);

    const t = this.tmp.getContext('2d');
    t.globalCompositeOperation = 'copy';
    t.imageSmoothingEnabled = true;
    t.drawImage(this.snap, 0, 0, W, H);
    t.globalCompositeOperation = 'source-atop';
    t.drawImage(this.char.c, 0, 0, W, H);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(this.mask.c, 0, 0, W, H);
    t.globalCompositeOperation = 'source-over';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.tmp, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.ember.c, 0, 0, W, H);
    const bg = this.bloom.getContext('2d');
    bg.globalCompositeOperation = 'copy';
    bg.drawImage(this.ember.c, 0, 0, this.bloom.width, this.bloom.height);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(this.bloom, 0, 0, W, H);

    // flying sparks off the burning edge
    for (let k = 0; k < 6 && edge.length; k++) {
      const i = edge[(Math.random() * edge.length) | 0];
      if (this.sparks.length < 160) {
        this.sparks.push({ x: (i % BW + Math.random()) / BW * W, y: (Math.floor(i / BW) + Math.random()) / BH * H,
          vx: (Math.random() - 0.5) * 2.2 * u, vy: -(1 + Math.random() * 3) * u, life: 20 + Math.random() * 30, max: 50 });
      }
    }
    let j = 0;
    for (const s of this.sparks) {
      if (--s.life <= 0) continue;
      s.x += s.vx; s.y += s.vy; s.vy -= 0.04 * u; s.vx += (Math.random() - 0.5) * 0.3 * u;
      const a = Math.min(1, s.life / 25);
      ctx.globalAlpha = a;
      ctx.fillStyle = s.life > 30 ? '#fff0c8' : '#ff8a2a';
      const sz = 2 * u;
      ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
      this.sparks[j++] = s;
    }
    this.sparks.length = j;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  releaseBurn() {
    this.snap = this.tmp = this.field = null;
    this.mask = this.char = this.ember = null;
    this.bloom = null;
    this.sparks = [];
  }

  // ------------------------------------------------------------------ per-frame post
  post(ctx, { effects = true, glitch = 0, frame = 0, danger = 0 } = {}) {
    const c = this.canvas, W = c.width, H = c.height;
    this.ensure(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const g = Math.max(0, Math.min(1, effects ? glitch : glitch * 0.5));
    if (g > 0.01) this.glitch(ctx, g, W, H);

    if (effects) {
      // scanlines + grain in one pattern fill (shifted horizontally each frame)
      const ox = (Math.random() * 256) | 0;
      ctx.fillStyle = this.grainPat;
      ctx.translate(ox, 0);
      ctx.fillRect(-ox, 0, W, H);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.vig, 0, 0, W, H);
      // slow rolling CRT bar
      const by = ((frame * 1.6) % (H * 1.8)) - H * 0.4;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.03;
      ctx.drawImage(this.roll, 0, by, W, H * 0.14);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    if (danger > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, danger) * (0.45 + 0.4 * Math.sin(frame * 0.18)) + 0.05;
      ctx.drawImage(this.dangerV, 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    if (!this.burnDrawn && this.snap) this.releaseBurn();
    this.burnDrawn = false;
  }

  glitch(ctx, g, W, H) {
    if (!this.copy || this.copy.width !== W || this.copy.height !== H) {
      this.copy = mk(W, H);
      this.tint = mk(W >> 1, H >> 1);
    }
    const u = H / 544;
    const cc = this.copy.getContext('2d');
    cc.globalCompositeOperation = 'copy';
    cc.drawImage(this.canvas, 0, 0);
    // RGB split: red channel shifted sideways
    if (g > 0.04) {
      const tc = this.tint.getContext('2d'), tw = this.tint.width, th = this.tint.height;
      tc.globalCompositeOperation = 'copy';
      tc.drawImage(this.copy, 0, 0, tw, th);
      tc.globalCompositeOperation = 'multiply';
      tc.fillStyle = '#ff0000';
      tc.fillRect(0, 0, tw, th);
      tc.globalCompositeOperation = 'source-over';
      const d = Math.max(1, Math.round((2 + 12 * g) * u)) * (Math.random() < 0.5 ? -1 : 1);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = '#00ffff';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(this.tint, d, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    // horizontal slice displacement
    const n = 2 + Math.floor(g * 9);
    for (let i = 0; i < n; i++) {
      const sy = Math.floor(Math.random() * H), sh = Math.min(H - sy, Math.ceil((3 + Math.random() * 38 * g) * u));
      if (sh <= 0) continue;
      const dx = Math.round((Math.random() * 2 - 1) * 70 * g * u);
      ctx.drawImage(this.copy, 0, sy, W, sh, dx, sy, W, sh);
    }
    // stray data blocks
    ctx.globalCompositeOperation = 'lighter';
    const cols = ['rgba(255,46,77,0.28)', 'rgba(125,249,255,0.22)', 'rgba(255,255,255,0.14)'];
    for (let k = 0; k < Math.floor(g * 7); k++) {
      ctx.fillStyle = cols[k % 3];
      ctx.fillRect(Math.random() * W, Math.random() * H, (10 + Math.random() * 120) * u, (1 + Math.random() * 5) * u);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
