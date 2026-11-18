// Melges 15 speed polar, built by tools/analyze.py from the WCC 2026 tracks.
//
// `level` sets how fast a boat is:   0 = the fleet's median boat (p50)
//                                   0.5 = the faster boats (p80)
//                                     1 = the best moments (p95)
// Negative levels extrapolate below the median (slower boats).

import { clamp } from './geo.js';

export class Polar {
  constructor(p) {
    this.tws = p.tws;
    this.twa = p.twa;
    this.p50 = p.p50; this.p80 = p.p80; this.p95 = p.p95;
    this.observed = p.observed_tws_range;
    this._opt = new Map();
  }

  _table(tab, tws, twa) {
    const T = this.tws;
    const tw = clamp(tws, T[0], T[T.length - 1]);
    let i = 0;
    while (i < T.length - 2 && tw > T[i + 1]) i++;
    const ft = (tw - T[i]) / (T[i + 1] - T[i]);
    const a = clamp(Math.abs(twa), 0, 180);
    let j = Math.min(Math.floor(a / 5), 35);
    const fa = (a - j * 5) / 5;
    const r0 = tab[i], r1 = tab[i + 1];
    const v0 = r0[j] + (r0[j + 1] - r0[j]) * fa;
    const v1 = r1[j] + (r1[j + 1] - r1[j]) * fa;
    let v = v0 + (v1 - v0) * ft;
    // Below the lowest tabled wind, scale down (speed ~ TWS^0.45).
    if (tws < T[0]) v *= Math.pow(Math.max(tws, 0.3) / T[0], 0.45);
    return v;
  }

  // Boat speed in knots.
  speed(tws, twa, level = 0.5) {
    const m = this._table(this.p50, tws, twa);
    if (level <= 0.5) {
      const h = this._table(this.p80, tws, twa);
      return Math.max(0, m + (h - m) * (level / 0.5));
    }
    const h = this._table(this.p80, tws, twa);
    const t = this._table(this.p95, tws, twa);
    return h + (t - h) * ((level - 0.5) / 0.5);
  }

  // Best VMG angles and speeds for a wind speed (cached at 0.25 kn).
  optimal(tws, level = 0.5) {
    const key = Math.round(tws * 4) + ':' + Math.round(level * 20);
    let o = this._opt.get(key);
    if (o) return o;
    let bu = 0, bua = 42, bd = 0, bda = 140;
    for (let a = 30; a <= 70; a += 0.5) {
      const v = this.speed(tws, a, level) * Math.cos(a * Math.PI / 180);
      if (v > bu) { bu = v; bua = a; }
    }
    for (let a = 110; a <= 180; a += 0.5) {
      const v = -this.speed(tws, a, level) * Math.cos(a * Math.PI / 180);
      if (v > bd) { bd = v; bda = a; }
    }
    o = { upTwa: bua, upVmg: bu, upSpeed: this.speed(tws, bua, level),
          dnTwa: bda, dnVmg: bd, dnSpeed: this.speed(tws, bda, level) };
    this._opt.set(key, o);
    return o;
  }
}
