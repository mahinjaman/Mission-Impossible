// Save data in localStorage. Every access is wrapped in try/catch: private
// mode, disabled storage or quota errors must never break the game.

const KEY = 'missionImpossible.save.v1';
const HISTORY_MAX = 40;                 // trap-matrix signatures remembered per mission
const RANK_ORDER = { ROOKIE: 1, OPERATIVE: 2, AGENT: 3, GHOST: 4 };

export function defaultSave() {
  return {
    version: 1,
    highest: 1,          // highest unlocked mission (1-based, endless)
    missions: {},        // m -> { clears, deaths, bestFrames, bestRank }
    totalDeaths: 0,
    sound: true,
    music: true,
    fx: true,            // post-processing effects
    history: {},         // m -> [signature, ...] (last 40 trap matrices)
  };
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const count = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export function loadSave() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSave();
    const data = JSON.parse(raw);
    if (!isObj(data)) return defaultSave();
    const d = defaultSave();
    const save = { ...d, ...data, version: 1 };
    save.highest = Math.max(1, count(data.highest) || 1);
    save.totalDeaths = count(data.totalDeaths);
    for (const k of ['sound', 'music', 'fx']) save[k] = typeof data[k] === 'boolean' ? data[k] : d[k];
    save.missions = {};
    if (isObj(data.missions)) {
      for (const [m, r] of Object.entries(data.missions)) {
        if (!isObj(r)) continue;
        save.missions[m] = {
          clears: count(r.clears),
          deaths: count(r.deaths),
          bestFrames: Number.isFinite(r.bestFrames) ? r.bestFrames : null,
          bestRank: r.bestRank in RANK_ORDER ? r.bestRank : null,
        };
      }
    }
    save.history = {};
    if (isObj(data.history)) {
      for (const [m, list] of Object.entries(data.history)) {
        if (Array.isArray(list)) save.history[m] = list.filter(s => typeof s === 'string' || typeof s === 'number').slice(-HISTORY_MAX);
      }
    }
    return save;
  } catch {
    return defaultSave();
  }
}

export function writeSave(save) {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

export function resetSave() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return defaultSave();
}

/** Record for mission m (created on first use). */
export function missionRecord(save, m) {
  save.missions ??= {};
  return (save.missions[m] ??= { clears: 0, deaths: 0, bestFrames: null, bestRank: null });
}

export function recordDeath(save, m) {
  missionRecord(save, m).deaths++;
  save.totalDeaths = (save.totalDeaths || 0) + 1;
  writeSave(save);
}

/** Rank comparison: GHOST > AGENT > OPERATIVE > ROOKIE. Returns >0 if a beats b. */
export function compareRank(a, b) {
  return (RANK_ORDER[a] ?? 0) - (RANK_ORDER[b] ?? 0);
}

/** Returns { newBestTime, newBestRank }. */
export function recordClear(save, m, { deaths = 0, frames, rank } = {}) {
  const r = missionRecord(save, m);
  r.clears++;
  const newBestTime = Number.isFinite(frames) && (r.bestFrames === null || frames < r.bestFrames);
  const newBestRank = rank in RANK_ORDER && (r.bestRank === null || compareRank(rank, r.bestRank) > 0);
  if (newBestTime) r.bestFrames = frames;
  if (newBestRank) r.bestRank = rank;
  void deaths;   // per-mission deaths are already counted by recordDeath
  writeSave(save);
  return { newBestTime, newBestRank };
}

/** Remember a trap-matrix signature for mission m (keeps the last 40). Does not write. */
export function pushHistory(save, m, signature) {
  save.history ??= {};
  const list = (save.history[m] ??= []);
  const i = list.indexOf(signature);
  if (i >= 0) list.splice(i, 1);
  list.push(signature);
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  return list;
}
