// Headless smoke test for src/render.js + src/fx.js.
// Runs the real simulation and drives every renderer entry point against a
// strict fake 2D context that flags NaN/Infinity arguments, bad drawImage
// sources and getImageData use.   Usage: node tools/render-smoke.mjs [frames]

const errors = new Map();
const stats = { calls: 0, drawImage: 0, canvases: 0, canvasPx: 0 };
function fail(msg) {
  const key = msg + '\n' + (new Error().stack.split('\n').slice(3, 6).join('\n'));
  errors.set(key, (errors.get(key) ?? 0) + 1);
}
const isCanvas = o => o && o.__canvas === true;
function checkArgs(name, args) {
  for (const a of args) {
    if (typeof a === 'number' && !Number.isFinite(a)) { fail(`${name}: non-finite arg ${a}`); return; }
  }
}

function makeCtx(canvas) {
  const state = {
    canvas, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter',
    shadowBlur: 0, shadowColor: 'transparent', lineDashOffset: 0, imageSmoothingEnabled: true,
  };
  let depth = 0;
  const grad = () => ({ addColorStop(o, c) { if (!(o >= 0 && o <= 1)) fail(`addColorStop offset ${o}`); if (typeof c !== 'string' || c.includes('NaN') || c.includes('undefined')) fail(`addColorStop color ${c}`); } });
  return new Proxy({}, {
    get(_, k) {
      if (k in state) return state[k];
      switch (k) {
        case 'measureText': return s => ({ width: String(s).length * 5.2 });
        case 'createImageData': return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
        case 'getImageData': return () => { fail('getImageData used'); return { data: new Uint8ClampedArray(4) }; };
        case 'createLinearGradient': case 'createRadialGradient': return (...a) => { checkArgs(k, a); if (k === 'createRadialGradient' && (a[2] < 0 || a[5] < 0)) fail('negative radial radius'); return grad(); };
        case 'createPattern': return img => { if (!isCanvas(img)) fail('createPattern bad source'); return { __pattern: true }; };
        case 'save': return () => { depth++; };
        case 'restore': return () => { depth--; if (depth < 0) fail('restore without save'); };
        case '__depth': return depth;
        case 'drawImage': return (img, ...a) => {
          stats.calls++; stats.drawImage++;
          if (!isCanvas(img)) fail('drawImage: bad source');
          else if (img.width <= 0 || img.height <= 0) fail('drawImage: empty source');
          checkArgs('drawImage', a);
          if (a.length === 8 && (a[2] <= 0 || a[3] <= 0)) fail(`drawImage: empty src rect ${a.slice(0, 4)}`);
          if (a.length === 8 && (a[0] < -0.5 || a[1] < -0.5 || a[0] + a[2] > img.width + 0.5 || a[1] + a[3] > img.height + 0.5)) fail(`drawImage: src rect out of bounds ${a.slice(0, 4).map(v => v.toFixed(1))} of ${img.width}x${img.height}`);
        };
        case 'arc': case 'ellipse': return (...a) => { stats.calls++; checkArgs(k, a); if (a[2] < 0 || (k === 'ellipse' && a[3] < 0)) fail(`${k}: negative radius ${a}`); };
        default: return (...a) => { stats.calls++; checkArgs(k, a); };
      }
    },
    set(_, k, v) {
      if (typeof v === 'number' && !Number.isFinite(v)) fail(`set ${String(k)} = ${v}`);
      if (typeof v === 'string' && (v.includes('NaN') || v.includes('undefined'))) fail(`set ${String(k)} = ${v}`);
      if (v === undefined || v === null) fail(`set ${String(k)} = ${v}`);
      state[k] = v;
      return true;
    },
  });
}

function makeCanvas() {
  const c = { __canvas: true, _w: 300, _h: 150, style: {} };
  Object.defineProperty(c, 'width', { get: () => c._w, set: v => { if (!(v >= 0) || !Number.isFinite(v)) fail(`canvas.width = ${v}`); c._w = Math.floor(v); } });
  Object.defineProperty(c, 'height', { get: () => c._h, set: v => { if (!(v >= 0) || !Number.isFinite(v)) fail(`canvas.height = ${v}`); c._h = Math.floor(v); } });
  let ctx = null;
  c.getContext = () => (ctx ??= makeCtx(c));
  stats.canvases++;
  return c;
}

globalThis.document = { createElement: tag => { if (tag !== 'canvas') throw new Error(tag); return makeCanvas(); } };

const { generateMission } = await import('../src/gen.js');
const { LevelRun } = await import('../src/game.js');
const { Camera, Particles, WorldRenderer, VIEW_W, VIEW_H } = await import('../src/render.js');
const { PostFX } = await import('../src/fx.js');
const { IN_LEFT, IN_RIGHT, IN_JUMP, IN_SCAN } = await import('../src/player.js');

const FRAMES = +(process.argv[2] ?? 900);
const screen = makeCanvas();
const ctx = screen.getContext('2d');
const fx = new PostFX(screen);
const cam = new Camera(), particles = new Particles(), renderer = new WorldRenderer();
const eventsSeen = new Set(), trapsSeen = new Set();
let frame = 0, maxParticles = 0, maxCalls = 0, maxDraws = 0, runs = 0;

const sizes = [[960, 544], [1920, 1088], [2880, 1632], [1366, 774]];
const missions = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 30, 45, 60];
for (const [mi, m] of missions.entries()) {
  for (let s = 0; s < 3; s++) {
    const [W, H] = sizes[(mi + s) % sizes.length];
    screen.width = W; screen.height = H; fx.resize();
    const def = generateMission(m, (m * 7919 + s * 104729) >>> 0);
    const god = s !== 2;
    const run = new LevelRun(def, { god });
    runs++;
    renderer.setRun(run); cam.snap(run); particles.clear();
    for (const t of run.traps) trapsSeen.add(t.type);
    // briefing thumbnail + burn
    for (let i = 0; i < 20; i++) renderer.drawThumbnail(ctx, run, 470, 120, 440, 200, i * 7);
    fx.captureBurn(ctx);
    let deadFor = -1;
    for (let i = 0; i < FRAMES; i++) {
      frame++;
      const k = i % 90;
      let mask = IN_RIGHT;
      if (k < 14 || (i % 37) < 6) mask |= IN_JUMP;
      if (i % 160 === 20) mask |= IN_SCAN;
      if (i % 300 > 280) mask = IN_LEFT;
      if (i === 400) for (const t of run.traps) t.tagged = true;   // exercise every ghost/tag overlay
      const before = run.state;
      run.step(mask);
      for (const e of run.events) { eventsSeen.add(e.type); renderer.onEvent(e, run, particles, cam); }
      if (before === 'playing' && run.state !== 'playing') deadFor = 0;
      cam.update(run);
      particles.update();
      maxParticles = Math.max(maxParticles, particles.list.length);
      const c0 = stats.calls, d0 = stats.drawImage;
      ctx.setTransform(W / VIEW_W, 0, 0, W / VIEW_W, 0, 0);
      renderer.draw(ctx, run, cam, particles, { frame, rebuild: i < 26 ? i / 26 : -1, zones: i % 97 === 0 });
      if (i < 70) fx.drawBurn(ctx, i / 70);
      fx.post(ctx, { effects: i % 211 !== 0, glitch: deadFor >= 0 && deadFor < 18 ? 1 - deadFor / 18 : (i % 150 < 5 ? 0.3 : 0), frame, danger: (i % 120) / 120 });
      if (ctx.__depth !== 0) { fail(`save/restore imbalance ${ctx.__depth}`); break; }
      maxCalls = Math.max(maxCalls, stats.calls - c0); maxDraws = Math.max(maxDraws, stats.drawImage - d0);
      if (deadFor >= 0 && ++deadFor > 40) break;
      if (run.state === 'won') { for (let j = 0; j < 45; j++) { frame++; renderer.draw(ctx, run, cam, particles, { frame, rebuild: -1 }); particles.update(); } break; }
    }
  }
}

console.log(`runs: ${runs}  frames: ${frame}  canvases created: ${stats.canvases}`);
console.log(`events seen: ${[...eventsSeen].sort().join(' ')}`);
console.log(`trap types seen: ${[...trapsSeen].sort().join(' ')}`);
console.log(`max particles: ${maxParticles}  max ctx calls/frame: ${maxCalls}  max drawImage/frame: ${maxDraws}`);
if (errors.size) {
  console.log(`\n${errors.size} distinct problems:`);
  for (const [k, n] of errors) console.log(`--- x${n}\n${k}`);
  process.exit(1);
}
console.log('OK - no problems found');
