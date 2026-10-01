// Shared visual language: "classified hologram". Deep navy-black space,
// neon wireframe geometry, hot red for anything that kills, amber for
// warnings, white-hot for the extraction point. Each mission gets its own
// accent hue (stable per mission), so missions feel like different cities.

export const FONT = '"Consolas", "SFMono-Regular", "Menlo", "Courier New", monospace';

export const C = {
  bg0: '#03050a',        // deepest background
  bg1: '#07101d',        // background gradient top
  bg2: '#0b1a2e',
  ink: '#0a1220',        // solid geometry fill
  inkHi: '#12203a',
  text: '#e8f4ff',
  dim: '#6f86a3',
  faint: '#2a3b55',
  danger: '#ff2e4d',     // lasers, spikes, mines, cones: anything that kills
  dangerGlow: 'rgba(255,46,77,0.35)',
  warn: '#ffb020',       // warnings, fuses, alarms
  good: '#3dffa8',       // extraction, success, ghost pace
  key: '#ffd84a',        // keycards
  scan: '#7df9ff',       // scanner pulse + tags
  paper: '#d9d2bf',      // dossier
};

// Per-mission accent palettes [accent, accent2] (neon edge colour, secondary).
const ACCENTS = [
  ['#29e7ff', '#2f6bff'],   // cyan / blue
  ['#ff3df2', '#7a3dff'],   // magenta / violet
  ['#ffb020', '#ff5a1f'],   // amber / orange
  ['#3dffa8', '#1fb8ff'],   // mint / sky
  ['#b28cff', '#ff4fa3'],   // lavender / pink
  ['#e6ff3d', '#3dffd8'],   // acid / aqua
];

export function themeFor(m) {
  const [accent, accent2] = ACCENTS[(Math.max(1, m) - 1) % ACCENTS.length];
  return { ...C, accent, accent2 };
}

/** '#29e7ff' + alpha -> 'rgba(41,231,255,a)' */
export function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Frames -> '01:23.45' */
export function fmtTime(frames) {
  if (frames === null || frames === undefined) return '--:--.--';
  const s = frames / 60, m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
}
