// Seeded random numbers. Every random choice in a race draws from one of
// these, so a seed reproduces a race exactly (needed for rewind/branch and
// for comparing options on the same wind futures in the Monte Carlo).

export class Rng {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 1;
    this._spare = null;
  }
  // mulberry32
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  gauss() {
    if (this._spare !== null) { const v = this._spare; this._spare = null; return v; }
    let u, v, s;
    do { u = this.next() * 2 - 1; v = this.next() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    this._spare = v * m;
    return u * m;
  }
  normal(mu = 0, sd = 1) { return mu + sd * this.gauss(); }
  state() { return { s: this.s, spare: this._spare }; }
  static from(st) { const r = new Rng(1); r.s = st.s; r._spare = st.spare; return r; }
}

export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  }
  return h || 1;
}
