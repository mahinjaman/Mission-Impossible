// Seeded randomness + mission identity (codenames, cities, matrix codes).
// The simulation never calls Math.random: every trap layout comes from a
// seeded Rng, so a seed always reproduces exactly the same level.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) { this.seed = seed >>> 0; this.next = mulberry32(this.seed); }
  float(a = 0, b = 1) { return a + this.next() * (b - a); }
  /** Integer in [a, b] (inclusive). */
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** Pick from [{ w, ... }] by weight. */
  weighted(items) {
    const total = items.reduce((s, it) => s + it.w, 0);
    let r = this.next() * total;
    for (const it of items) { r -= it.w; if (r < 0) return it; }
    return items[items.length - 1];
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
}

/** A fresh, unpredictable 32-bit seed (crypto when available). */
export function randomSeed() {
  try {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0];
  } catch {
    return (Math.random() * 4294967296) >>> 0;
  }
}

/** FNV-1a string hash -> uint32. */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** 0x7f3a91c2 -> '7F3A-91C2' (shown to the player as the trap matrix code). */
export function matrixCode(seed) {
  const h = (seed >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

const ADJ = ['SILENT', 'CRIMSON', 'GLASS', 'HOLLOW', 'IRON', 'VELVET', 'BROKEN', 'PHANTOM', 'BLACK', 'COLD', 'MIDNIGHT', 'SHATTERED',
  'GHOST', 'NEON', 'BURNING', 'FROZEN', 'SILVER', 'ROGUE', 'DEAD', 'SCARLET', 'OBSIDIAN', 'HIDDEN', 'FALLEN', 'COBALT'];
const NOUN = ['SERPENT', 'PROTOCOL', 'HORIZON', 'ECLIPSE', 'FALCON', 'CIPHER', 'LANTERN', 'MERIDIAN', 'VIPER', 'KEYSTONE', 'TEMPEST',
  'MIRAGE', 'SPECTRE', 'ANVIL', 'NEEDLE', 'COMPASS', 'ORACLE', 'HARBOR', 'MONOLITH', 'RAVEN', 'PARADOX', 'VERTEX', 'CASCADE', 'DAGGER'];

// [name, country, lat, lon]
export const CITIES = [
  ['PRAGUE', 'CZ', 50.1, 14.4], ['DUBAI', 'AE', 25.2, 55.3], ['DHAKA', 'BD', 23.8, 90.4], ['MUMBAI', 'IN', 19.1, 72.9],
  ['CAIRO', 'EG', 30.0, 31.2], ['ISTANBUL', 'TR', 41.0, 28.9], ['MOSCOW', 'RU', 55.8, 37.6], ['TOKYO', 'JP', 35.7, 139.7],
  ['SHANGHAI', 'CN', 31.2, 121.5], ['SINGAPORE', 'SG', 1.35, 103.8], ['SYDNEY', 'AU', -33.9, 151.2], ['LONDON', 'UK', 51.5, -0.1],
  ['PARIS', 'FR', 48.9, 2.35], ['BERLIN', 'DE', 52.5, 13.4], ['VIENNA', 'AT', 48.2, 16.4], ['ROME', 'IT', 41.9, 12.5],
  ['LISBON', 'PT', 38.7, -9.1], ['REYKJAVIK', 'IS', 64.1, -21.9], ['NEW YORK', 'US', 40.7, -74.0], ['HAVANA', 'CU', 23.1, -82.4],
  ['RIO', 'BR', -22.9, -43.2], ['BUENOS AIRES', 'AR', -34.6, -58.4], ['MEXICO CITY', 'MX', 19.4, -99.1], ['VANCOUVER', 'CA', 49.3, -123.1],
  ['NAIROBI', 'KE', -1.3, 36.8], ['CAPE TOWN', 'ZA', -33.9, 18.4], ['MARRAKESH', 'MA', 31.6, -8.0], ['KATHMANDU', 'NP', 27.7, 85.3],
  ['SEOUL', 'KR', 37.6, 127.0], ['BANGKOK', 'TH', 13.8, 100.5], ['HONG KONG', 'HK', 22.3, 114.2], ['KARACHI', 'PK', 24.9, 67.0],
];

/** Stable identity of mission `m` (same codename + city every time). */
export function missionIdentity(m) {
  const r = new Rng(hashStr(`mission-${m}`));
  const city = CITIES[(m * 7 + r.int(0, 3)) % CITIES.length];
  return {
    codename: `OPERATION ${r.pick(ADJ)} ${r.pick(NOUN)}`,
    city: city[0], country: city[1], lat: city[2], lon: city[3],
  };
}
