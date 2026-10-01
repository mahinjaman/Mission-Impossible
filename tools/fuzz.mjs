// Generator fuzzer: builds many trap matrices exactly like the app does
// (generateMission with the chained `prev` signature history), proves each
// one beatable with the headless solver (src/solver.js) and checks the
// no-repeat rule. Exit code 1 on any failure.
//
// Usage: node tools/fuzz.mjs [--missions 1-40] [--seeds 30] [--k 6] [--beam 10,32,96]
//                            [--replay] [--jobs N] [--base 0] [--show 12] [--only M:ATTEMPT]
//   --missions  range "1-40" or list "1,5,9"
//   --seeds     attempts generated per mission (chained history, like retries in the app)
//   --replay    re-simulate every found input sequence on a fresh LevelRun, and once more
//               through a mid-run clone() (determinism + clone fidelity)
//   --jobs      worker threads (default: CPU count)
//   --base      sample offset: different --base = different seeds
//   --show      how many failures to print in full (with map excerpt)
//   --only      solve one level (mission:attempt, same --base) and print its whole map + result
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { generateMission } from '../src/gen.js';
import { solve, replay } from '../src/solver.js';
import { LevelRun } from '../src/game.js';
import { hashStr } from '../src/rng.js';
import { TILE } from '../src/physics.js';

// Worker threads solve one level per message (see the bottom of the file).
function check(def, opts, job = {}) {
  const r = solve(def, opts);
  const out = { ...job, def: undefined, ok: r.ok, frames: r.frames, expanded: r.expanded, ms: r.ms, reason: r.reason, maxX: r.maxX, at: r.at, deaths: r.deaths, beam: r.beam };
  if (r.ok && opts.replay) {
    // 1. the inputs win on a fresh run, on exactly the same frame
    const run = replay(def, r.inputs);
    out.replayOk = run.state === 'won' && run.frame === r.frames;
    if (!out.replayOk) { out.ok = false; out.reason = `REPLAY MISMATCH (${run.state} at frame ${run.frame}, solver ${r.frames})`; }
    // 2. clone() mid-run and finish on the copy: same result
    const a = new LevelRun(def), cut = r.inputs.length >> 1;
    for (let i = 0; i < cut; i++) a.step(r.inputs[i]);
    const c = a.clone();
    for (let i = cut; i < r.inputs.length && c.state === 'playing'; i++) c.step(r.inputs[i]);
    if (out.replayOk && !(c.state === 'won' && c.frame === r.frames)) {
      out.ok = out.replayOk = false; out.reason = `CLONE MISMATCH (${c.state} at frame ${c.frame}, solver ${r.frames})`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// main thread
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { missions: '1-40', seeds: 30, k: 6, beam: '10,32,96', replay: false, jobs: cpus().length, base: 0, show: 12, only: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'replay') a.replay = true;
    else a[k] = argv[++i];
  }
  const ms = [];
  for (const part of String(a.missions).split(',')) {
    const [lo, hi] = part.split('-').map(Number);
    for (let m = lo; m <= (hi || lo); m++) ms.push(m);
  }
  return { ...a, missions: ms, seeds: +a.seeds, k: +a.k, jobs: Math.max(1, +a.jobs), base: +a.base, show: +a.show, beam: String(a.beam).split(',').map(Number) };
}

const name = slot => slot.split(':')[0];
const isEncounter = slot => !slot.startsWith('end-') && slot !== 'keycard';

// Trap markers for the ASCII excerpt.
const MARK = {
  crumble: '=', spikes: 's', sled: 'z', drop: 'B', press: 'H', laser: '!', tripwire: 't', camera: 'C', mine: 'm',
  drone: 'd', gravity: ',', emp: '~', lift: 'L', lockdown: 'W', fakeDoor: 'X', runDoor: 'R', fakeKey: 'k',
};
const LEGEND = "# solid  ^v spikes  P spawn  K key  D door  @ solver frontier | " +
  Object.entries(MARK).map(([k, v]) => `${v} ${k}`).join('  ');

/** Map excerpt around column `cx` with traps overlaid. */
function excerpt(def, cx, at, radius = 22) {
  const rows = def.map.map(r => [...r]);
  const H = rows.length, W = rows[0].length;
  const paint = (x, y, ch, onlyEmpty = false) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    if (onlyEmpty && rows[y][x] !== '.') return;
    rows[y][x] = ch;
  };
  const zones = def.traps.filter(t => t.type === 'gravity' || t.type === 'emp');
  for (const t of [...zones, ...def.traps.filter(t => !zones.includes(t))]) {
    const ch = MARK[t.type] ?? '?';
    const zone = t.type === 'gravity' || t.type === 'emp';
    let x0 = Math.floor(t.x ?? 0), y0 = Math.floor(t.y ?? 0);
    let x1 = Math.ceil((t.x ?? 0) + (t.w ?? 1)) - 1, y1 = Math.ceil((t.y ?? 0) + (t.h ?? 1)) - 1;
    if (t.type === 'camera') { x0 = x1 = Math.floor(t.ax); y0 = y1 = Math.floor(t.ay); }
    if (t.type === 'drone') { x0 = x1 = Math.floor(t.sx); y0 = y1 = Math.floor(t.sy); }
    if (t.type === 'lockdown') { x0 = x1 = Math.floor(t.sx); y0 = y1 = Math.floor(t.y + t.h - 1); }
    if (t.type === 'press') y1 = y0;
    if (t.type === 'laser' && t.mode !== 'sweep') { y0 = y1 = Math.floor(t.y + t.h - 1); }
    if (t.type === 'laser' && t.mode === 'sweep') { y1 = y0 = Math.floor(t.y1); }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) paint(x, y, ch, zone);
  }
  if (at) paint(Math.floor((at.x + 10) / TILE), Math.floor((at.y + 13) / TILE), '@');
  const a = Math.max(0, cx - radius), b = Math.min(W, cx + radius + 1);
  const ruler = Array.from({ length: b - a }, (_, i) => ((a + i) % 10 === 0 ? String(((a + i) / 10) % 10) : ' ')).join('');
  return [`      columns ${a}-${b - 1} (ruler digit = tens)`, '      ' + ruler, ...rows.map((r, y) => `  ${String(y).padStart(2)}  ${r.slice(a, b).join('')}`)].join('\n');
}

/** Index of the slot the solver got stuck in (the frontier, or the slot right after it). */
function blameSlot(def, col) {
  const spans = def.spans ?? [];
  for (let i = 0; i < spans.length; i++) if (col >= spans[i][0] && col <= spans[i][1]) return i;
  return spans.length - 1;
}

const attemptSeed = (base, m, i) => hashStr(`fuzz:${base}:${m}:${i}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const opts = { k: args.k, beam: args.beam, replay: args.replay };
  const t0 = performance.now();

  if (args.only) {
    const [m, at] = args.only.split(':').map(Number);
    const history = [];
    let def;
    for (let i = 0; i <= at; i++) { def = generateMission(m, attemptSeed(args.base, m, i), history); history.push(def.signature); }
    console.log(`${def.id} slots: ${def.slots.join(' ')}\nspans: ${JSON.stringify(def.spans)}`);
    const r = check(def, { ...opts, replay: true });
    const col = Math.floor(r.maxX / TILE);
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.reason} frames=${r.frames} expanded=${r.expanded} beam=${r.beam} ${r.ms.toFixed(0)}ms deaths=${JSON.stringify(r.deaths)}`);
    console.log(excerpt(def, col, r.at, 200));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  // 1. Generate every attempt like the app does (history chained per mission) + no-repeat checks.
  const jobs = [], repeatErrors = [];
  for (const m of args.missions) {
    const history = [];
    let prev = null;
    for (let i = 0; i < args.seeds; i++) {
      const seed = attemptSeed(args.base, m, i);
      let def;
      try { def = generateMission(m, seed, history); }
      catch (e) { repeatErrors.push(`M${m} attempt ${i} seed ${seed}: generator threw ${e.message}`); continue; }
      if (history.includes(def.signature)) repeatErrors.push(`M${m} attempt ${i} seed ${seed}: signature repeats an earlier attempt (${def.signature})`);
      if (prev) {
        for (let s = 0; s < Math.min(prev.slots.length, def.slots.length); s++) {
          if (isEncounter(def.slots[s]) && name(def.slots[s]) === name(prev.slots[s])) {
            repeatErrors.push(`M${m} attempt ${i} seed ${seed}: slot ${s} repeats '${name(def.slots[s])}' from the previous attempt`);
          }
        }
      }
      history.push(def.signature);
      prev = def;
      jobs.push({ m, i, seed, def });
    }
  }

  // 2. Solve in parallel.
  const results = [];
  await new Promise((resolve, reject) => {
    let next = 0, done = 0;
    const n = Math.min(args.jobs, jobs.length);
    if (!jobs.length) return resolve();
    for (let w = 0; w < n; w++) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { opts } });
      const feed = () => {
        if (next < jobs.length) worker.postMessage(jobs[next++]);
        else worker.terminate();
      };
      worker.on('message', r => {
        results.push(r);
        if (++done % 50 === 0 || done === jobs.length) {
          process.stderr.write(`\r  solved ${done}/${jobs.length}  (${((performance.now() - t0) / 1000).toFixed(0)}s)   `);
        }
        if (done === jobs.length) { process.stderr.write('\n'); resolve(); }
        feed();
      });
      worker.on('error', reject);
      feed();
    }
  });
  const byKey = new Map(jobs.map(j => [`${j.m}:${j.i}`, j.def]));
  results.sort((a, b) => a.m - b.m || a.i - b.i);

  // 3. Report.
  console.log('\nMISSION  PASS   RATE   avg ms  max ms  avg frames');
  for (const m of args.missions) {
    const rs = results.filter(r => r.m === m);
    if (!rs.length) continue;
    const pass = rs.filter(r => r.ok);
    const avg = rs.reduce((s, r) => s + r.ms, 0) / rs.length, mx = Math.max(...rs.map(r => r.ms));
    const fr = pass.length ? pass.reduce((s, r) => s + r.frames, 0) / pass.length : 0;
    console.log(`${String(m).padStart(5)}  ${String(pass.length).padStart(3)}/${String(rs.length).padEnd(3)} ${(100 * pass.length / rs.length).toFixed(0).padStart(4)}%  ${avg.toFixed(0).padStart(6)}  ${mx.toFixed(0).padStart(6)}  ${fr.toFixed(0).padStart(6)}`);
  }

  // per slot tag: how often it appears, in how many failed levels, and how often it was the blocker
  const tags = new Map();
  const tag = t => { if (!tags.has(t)) tags.set(t, { seen: 0, inFail: 0, blamed: 0 }); return tags.get(t); };
  const fails = results.filter(r => !r.ok);
  for (const r of results) {
    const def = byKey.get(`${r.m}:${r.i}`);
    for (const s of new Set(def.slots)) { tag(s).seen++; if (!r.ok) tag(s).inFail++; }
    if (!r.ok) {
      r.col = Math.floor(r.maxX / TILE);
      r.slot = blameSlot(def, Math.floor((r.maxX + 20) / TILE) + 1);
      tag(def.slots[r.slot]).blamed++;
    }
  }
  console.log('\nSLOT TAG                     SEEN  IN-FAIL  BLAMED');
  for (const [t, v] of [...tags.entries()].sort((a, b) => b[1].blamed - a[1].blamed || a[0].localeCompare(b[0]))) {
    console.log(`  ${t.padEnd(26)} ${String(v.seen).padStart(5)}  ${String(v.inFail).padStart(7)}  ${String(v.blamed).padStart(6)}`);
  }

  if (fails.length) {
    console.log(`\nFAILURES (${fails.length}) - showing ${Math.min(args.show, fails.length)}\n${LEGEND}`);
    for (const r of fails.slice(0, args.show)) {
      const def = byKey.get(`${r.m}:${r.i}`);
      console.log(`\n[FAIL] mission ${r.m} seed ${r.seed} (attempt ${r.i}, matrix ${def.matrix})  -> node tools/fuzz.mjs --only ${r.m}:${r.i}${args.base ? ` --base ${args.base}` : ''}`);
      console.log(`  ${r.reason}; stuck at column ${r.col} in slot ${r.slot} '${def.slots[r.slot]}'; beam ${r.beam}; deaths near frontier ${JSON.stringify(r.deaths)}`);
      console.log(`  slots: ${def.slots.map((s, i) => (i === r.slot ? `[${s}]` : s)).join(' ')}`);
      console.log(excerpt(def, r.col, r.at));
    }
    console.log('\nall failures (--only M:ATTEMPT): ' + fails.map(r => `${r.m}:${r.i}`).join(' '));
  }
  if (repeatErrors.length) {
    console.log(`\nNO-REPEAT / GENERATOR VIOLATIONS (${repeatErrors.length})`);
    for (const e of repeatErrors.slice(0, 40)) console.log('  ' + e);
  }

  const total = results.length, passed = total - fails.length;
  const beams = {};
  for (const r of results.filter(r => r.ok)) beams[r.beam] = (beams[r.beam] ?? 0) + 1;
  const ms = results.map(r => r.ms).sort((a, b) => a - b);
  console.log(`\nsolved with beam width: ${Object.entries(beams).map(([b, n]) => `${b}: ${n}`).join('  ')}` +
    `   solve time (per worker) median ${ms[ms.length >> 1]?.toFixed(0)}ms  p95 ${ms[Math.floor(ms.length * 0.95)]?.toFixed(0)}ms  max ${ms[ms.length - 1]?.toFixed(0)}ms`);
  const replayed = results.filter(r => r.replayOk).length;
  console.log(`\nSUMMARY  ${args.missions.length} missions x ${args.seeds} seeds = ${total} levels   pass ${passed}/${total} (${(100 * passed / Math.max(1, total)).toFixed(2)}%)` +
    `${args.replay ? `   replay-verified ${replayed}` : ''}   no-repeat violations ${repeatErrors.length}   ${((performance.now() - t0) / 1000).toFixed(1)}s on ${args.jobs} threads`);
  process.exitCode = fails.length || repeatErrors.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// entry: main thread runs the fuzz, workers solve one level per message
// ---------------------------------------------------------------------------
if (!isMainThread) {
  const { opts } = workerData;
  parentPort.on('message', job => parentPort.postMessage(check(job.def, opts, job)));
} else {
  await main();
}
