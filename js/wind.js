// The wind: direction and speed at any point and time.
//
// Direction = race mean
//           + oscillation   (AR(2) process: quasi-periodic, period and size
//                            from the fleet-inferred shifts)
//           + drift         (slowly varying persistent shift)
//           + puff veer     (direction tied to pressure)
//           + noise field   (small, short-scale direction wobble)
//           + side gradient (geographic left/right effect; ~0 offshore)
// Shifts and puffs travel DOWN the course with the wind, so a boat further
// upwind meets a shift first.
//
// Speed = base strength (slow OU swing) x (1 + pressure field), where the
// pressure field is a sum of random travelling waves sized from the
// measured puff scale (~50-100 m across, ~30 s as seen from a boat).
//
// fork(tf, seed) keeps everything that has already happened and draws a
// new future after tf. Same seed = same future, which is what lets the
// Monte Carlo compare options on identical winds.

import { Rng } from './rng.js';
import { KN, D2R, unit } from './geo.js';

const T0 = -900;          // first second covered
const N = 5400;           // seconds covered: [-900, 4500)

export const WIND_DEFAULTS = {
  tws: 7, twd: 270, axis: 270,
  oscSd: 4.5, periodS: 420, dampS: 360,
  trendSd: 0.2,            // deg/min, sd of the drift rate
  strengthSd: 0.05, strengthTau: 300,
  pressureSd: 0.15,        // fraction of TWS
  puffVeer: 1.5,           // deg per pressure sd (sign drawn per race)
  dirNoiseSd: 1.2,
  sideGrad: 0,             // deg per 100 m to the right of the axis
  propagate: true,
};

export class WindField {
  constructor(params, seed = 1, prefix = null) {
    this.p = { ...WIND_DEFAULTS, ...params };
    this.seed = seed;
    const rng = new Rng(seed);
    this.c = Math.max(0.9 * this.p.tws * KN, 1.0);
    [this.ax, this.ay] = unit(this.p.axis);
    this._modes(rng);
    this.dir = new Float64Array(N);
    this.osc = new Float64Array(N);
    this.vel = new Float64Array(N);
    this.drift = new Float64Array(N);
    this.str = new Float64Array(N);
    this.forkT = Infinity;
    this.prefixEnd = -1;
    // AR(2) with poles r*e^(+-i w): quasi-periodic oscillation.
    const w = 2 * Math.PI / this.p.periodS;
    const r = Math.exp(-1 / this.p.dampS);
    this.a1 = 2 * r * Math.cos(w);
    this.a2 = -r * r;
    const a1 = this.a1, a2 = this.a2;
    const varFactor = (1 - a2) / ((1 + a2) * ((1 - a2) ** 2 - a1 * a1));
    this.se = this.p.oscSd / Math.sqrt(varFactor);
    this.phiV = Math.exp(-1 / 900);
    this.sv = (this.p.trendSd / 60) * Math.sqrt(1 - this.phiV ** 2);
    this.phiS = Math.exp(-1 / this.p.strengthTau);
    this.ss = this.p.strengthSd * Math.sqrt(1 - this.phiS ** 2);
    this._burnIn(rng);
    if (prefix) this._applyPrefix(prefix);
    this._generate(this.prefixEnd + 1, rng);
  }

  _modes(rng) {
    const P = this.p;
    const M = 14;
    this.pm = [];
    const amp = P.pressureSd * Math.sqrt(2 / M);
    for (let k = 0; k < M; k++) {
      const lam = Math.exp(rng.range(Math.log(110), Math.log(420)));
      const th = rng.range(0, 2 * Math.PI);
      this.pm.push({ kx: Math.sin(th) * 2 * Math.PI / lam, ky: Math.cos(th) * 2 * Math.PI / lam,
                     ph: rng.range(0, 2 * Math.PI), om: rng.normal(0, 2 * Math.PI / 300), om2: 0, a: amp });
    }
    const MD = 6;
    this.dm = [];
    const damp = P.dirNoiseSd * Math.sqrt(2 / MD);
    for (let k = 0; k < MD; k++) {
      const lam = Math.exp(rng.range(Math.log(250), Math.log(900)));
      const th = rng.range(0, 2 * Math.PI);
      this.dm.push({ kx: Math.sin(th) * 2 * Math.PI / lam, ky: Math.cos(th) * 2 * Math.PI / lam,
                     ph: rng.range(0, 2 * Math.PI), om: rng.normal(0, 2 * Math.PI / 400), om2: 0, a: damp });
    }
    this.veerSign = rng.next() < 0.5 ? -1 : 1;
  }

  // Start values drawn from the processes' own steady state: run them for
  // ~10 damping times from rest and keep the last values. (Independent
  // random starts give the AR(2) a huge initial swing.)
  _burnIn(rng) {
    let x1 = 0, x2 = 0, v = 0, s = 0;
    for (let i = 0; i < 4000; i++) {
      const x = this.a1 * x1 + this.a2 * x2 + this.se * rng.gauss();
      x2 = x1; x1 = x;
      v = this.phiV * v + this.sv * rng.gauss();
      s = this.phiS * s + this.ss * rng.gauss();
    }
    this._init = [x2, x1, v, s];
  }

  _applyPrefix({ t, deg }) {
    // A known direction history (a real race): use it as-is, and continue
    // the oscillation from its last values when the future is generated.
    const P = this.p;
    let j = 0;
    let last = -1;
    for (let i = 0; i < N; i++) {
      const tt = T0 + i;
      if (tt < t[0]) { this.dir[i] = deg[0]; continue; }
      if (tt > t[t.length - 1]) break;
      while (j < t.length - 2 && t[j + 1] < tt) j++;
      const f = (tt - t[j]) / (t[j + 1] - t[j]);
      let d0 = deg[j], d1 = deg[j + 1];
      if (d1 - d0 > 180) d1 -= 360; if (d0 - d1 > 180) d1 += 360;
      this.dir[i] = d0 + (d1 - d0) * Math.max(0, Math.min(1, f));
      last = i;
    }
    this.prefixEnd = last;
    // Oscillation state relative to the recent mean.
    const lo = Math.max(0, last - 600);
    let s = 0;
    for (let i = lo; i <= last; i++) s += this.dir[i];
    const mean = s / (last - lo + 1);
    P.twd = mean;
    for (let i = 0; i <= last; i++) { this.osc[i] = this.dir[i] - mean; this.str[i] = 0; }
  }

  _generate(from, rng) {
    const P = this.p;
    for (let i = Math.max(from, 0); i < N; i++) {
      if (i < 2) {
        this.osc[i] = this._init[i];
        this.vel[i] = this._init[2];
        this.drift[i] = 0;
        this.str[i] = this._init[3];
      } else {
        this.osc[i] = this.a1 * this.osc[i - 1] + this.a2 * this.osc[i - 2] + this.se * rng.gauss();
        this.vel[i] = this.phiV * this.vel[i - 1] + this.sv * rng.gauss();
        this.drift[i] = this.drift[i - 1] + this.vel[i];
        this.str[i] = this.phiS * this.str[i - 1] + this.ss * rng.gauss();
      }
      this.dir[i] = P.twd + this.osc[i] + this.drift[i];
    }
  }

  // A copy whose future after time `tf` (+ the stretch already visible up
  // the course, `lookaheadS`) is redrawn from `seed`.
  fork(tf, seed, lookaheadS = 0) {
    const w = Object.create(WindField.prototype);
    Object.assign(w, this);
    w.seed = seed;
    w.dir = this.dir.slice(); w.osc = this.osc.slice(); w.vel = this.vel.slice();
    w.drift = this.drift.slice(); w.str = this.str.slice();
    const rng = new Rng(seed);
    w.forkT = Math.min(this.forkT, tf);
    w.pm = this.pm.map(m => ({ ...m, om2: rng.normal(0, 2 * Math.PI / 300) }));
    w.dm = this.dm.map(m => ({ ...m, om2: rng.normal(0, 2 * Math.PI / 400) }));
    const k = Math.floor(tf + lookaheadS - T0) + 1;
    w._generate(Math.max(k, 2), rng);
    return w;
  }

  _series(arr, tb) {
    let f = tb - T0;
    if (f < 0) f = 0; else if (f > N - 1.001) f = N - 1.001;
    const i = f | 0;
    return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
  }

  // Mean direction at the course origin (what a coach's graph would show).
  baseDir(t) { return this._series(this.dir, t); }
  baseTws(t) { return this.p.tws * (1 + this._series(this.str, t)); }

  _phase(m, t) {
    // Mode phases evolve at `om`; after a fork, at the fork's `om2`.
    if (t <= this.forkT) return m.ph + m.om * t;
    return m.ph + m.om * this.forkT + m.om2 * (t - this.forkT);
  }

  pressure(x, y, t) {
    // Field travels downwind with the air.
    const v = 0.85 * this.p.tws * KN;
    const sx = x + this.ax * v * t, sy = y + this.ay * v * t;
    let p = 0;
    for (const m of this.pm) p += m.a * Math.cos(m.kx * sx + m.ky * sy + this._phase(m, t));
    return p;
  }

  // Wind at (x, y, t) -> writes {tws, twd, p} into `out` (or a new object).
  at(x, y, t, out = {}) {
    const P = this.p;
    const up = x * this.ax + y * this.ay;
    const tb = P.propagate ? t + up / this.c : t;
    const p = this.pressure(x, y, t);
    const v = 0.85 * P.tws * KN;
    const sx = x + this.ax * v * t, sy = y + this.ay * v * t;
    let dn = 0;
    for (const m of this.dm) dn += m.a * Math.cos(m.kx * sx + m.ky * sy + this._phase(m, t));
    const crossM = x * this.ay - y * this.ax;
    out.twd = this._series(this.dir, tb) + dn + this.veerSign * P.puffVeer * (p / Math.max(P.pressureSd, 1e-6))
      + P.sideGrad * crossM / 100;
    out.tws = Math.max(0.2 * P.tws, P.tws * (1 + this._series(this.str, tb)) * (1 + p));
    out.p = p;
    return out;
  }
}
