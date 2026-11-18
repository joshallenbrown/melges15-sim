// Real WCC 2026 races: playback of every boat's track with the wind the
// fleet's headings imply, and "take over": sail one boat yourself from any
// moment while the real fleet carries on as ghosts.

import { makeCourse, lineSide, PALETTE } from './course.js';
import { makeBoat, bowPos } from './boat.js';
import { WindField } from './wind.js';
import { Sim } from './sim.js';
import { wrap, norm360, bearing, upwind, cross, circMean, unit, KN } from './geo.js';

export function trackState(tr, t) {
  const f = t - tr.t0;
  const i = Math.floor(f);
  if (i < 0 || i + 1 >= tr.x.length) return null;
  if (tr.x[i] === null || tr.x[i + 1] === null) return null;
  const a = f - i;
  let h0 = tr.h[i], h1 = tr.h[i + 1];
  if (h0 === null || h1 === null) return null;
  const dh = wrap(h1 - h0);
  return {
    x: tr.x[i] + (tr.x[i + 1] - tr.x[i]) * a,
    y: tr.y[i] + (tr.y[i + 1] - tr.y[i]) * a,
    hdg: norm360(h0 + dh * a),
    v: ((tr.s[i] ?? 0) + ((tr.s[i + 1] ?? 0) - (tr.s[i] ?? 0)) * a) * KN,
    est: tr.est ? Math.max(tr.est[i], tr.est[i + 1]) : 0,
  };
}

// The trackers drop out a lot (median gap 10 s, 1 in 10 over 40 s, a third of
// all boat-seconds in some races), which made boats blink out of the replay.
// For display and for take-over ghosts, fill each gap between two fixes with a
// plausible path: keep the last heading, turn once (tack, gybe or rounding)
// onto the heading the boat reappears on. The analysis (report card,
// benchmarks) still uses only the recorded fixes.
// est per second: 0 recorded, 1 short gap (<= 30 s), 2 longer gap (drawn faded).
const GAP_SHORT = 30, MAX_MS = 4.5;             // m/s: no Melges 15 path is faster than this
export function fillTrack(tr) {
  const n = tr.x.length;
  const x = tr.x.slice(), y = tr.y.slice(), h = tr.h.slice(), s = tr.s.slice();
  const est = new Uint8Array(n);
  const good = (i) => Number.isFinite(tr.x[i]) && Number.isFinite(tr.y[i]) && Number.isFinite(tr.h[i]);
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!good(i)) continue;
    if (last >= 0 && i - last > 1) fillGap(last, i);
    last = i;
  }
  return { t0: tr.t0, x, y, h, s, est };

  function fillGap(i0, i1) {
    const N = i1 - i0;
    const A = [tr.x[i0], tr.y[i0]], B = [tr.x[i1], tr.y[i1]];
    const D = [B[0] - A[0], B[1] - A[1]], dist = Math.hypot(D[0], D[1]);
    const dA = unit(tr.h[i0]), dB = unit(tr.h[i1]);
    // Two straight legs A -> P (along d1) -> B (along d2), if they make sense.
    const legs = (d1, d2) => {
      const det = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(det) < 0.17) return null;                    // (nearly) parallel
      const l1 = (D[0] * d2[1] - D[1] * d2[0]) / det, l2 = (d1[0] * D[1] - d1[1] * D[0]) / det;
      if (l1 <= 0 || l2 <= 0 || l1 + l2 > MAX_MS * N) return null;
      return { d1, d2, l1, l2 };
    };
    let path = legs(dA, dB);
    if (!path && dist > 1) {
      // Same tack at both ends but moved sideways: tacked twice. Out on the
      // last heading, back on its mirror image about the line A -> B.
      const u = [D[0] / dist, D[1] / dist], k = 2 * (dA[0] * u[0] + dA[1] * u[1]);
      path = legs(dA, [k * u[0] - dA[0], k * u[1] - dA[1]]);
    }
    if (!path) path = { d1: dist > 0.5 ? [D[0] / dist, D[1] / dist] : dA, d2: null, l1: dist, l2: 0 };
    const L = path.l1 + path.l2, h1 = bearing(...path.d1), h2 = path.d2 ? bearing(...path.d2) : h1;
    const tc = L > 0 ? N * path.l1 / L : N;                    // when the turn happens
    const blend = (a, b, f) => norm360(a + wrap(b - a) * Math.min(1, Math.max(0, f)));
    for (let k = 1; k < N; k++) {
      const d = L * k / N;
      const p = d <= path.l1 || !path.d2 ? [A[0] + path.d1[0] * Math.min(d, path.l1), A[1] + path.d1[1] * Math.min(d, path.l1)]
        : [A[0] + path.d1[0] * path.l1 + path.d2[0] * (d - path.l1), A[1] + path.d1[1] * path.l1 + path.d2[1] * (d - path.l1)];
      let hd = blend(h1, h2, (k - tc + 3) / 6);                  // turn over ~6 s
      hd = blend(tr.h[i0], hd, k / 3);                           // ease off the last fix
      hd = blend(hd, tr.h[i1], (k - (N - 3)) / 3);               // and onto the next
      const i = i0 + k;
      x[i] = p[0]; y[i] = p[1]; h[i] = hd; s[i] = L / N / KN;
      est[i] = N - 1 <= GAP_SHORT ? 1 : 2;
    }
  }
}

export class Replay {
  constructor(data, cal, polar) {
    this.d = data;
    this.cal = cal;
    this.polar = polar;
    const pin = data.line.pin, com = data.line.committee;
    const wm = data.windward;
    const axis = bearing(wm[0], wm[1]);
    this.course = makeCourse(pin, com, wm, axis);
    this.twd = data.twd;
    const order = Object.entries(data.finish).sort((a, b) => a[1] - b[1]).map(([s]) => s);
    this.place = Object.fromEntries(order.map((s, i) => [s, i + 1]));
    this.boats = Object.entries(data.boats).map(([sail, tr], i) => ({
      id: i + 1, sail, tr, fill: fillTrack(tr), color: PALETTE[i % PALETTE.length], x: 0, y: 0, hdg: 0, v: 0,
      rel: 0, twa: 45, hidden: true, ctl: { mode: 'close' }, place: this.place[sail] ?? null,
    })).sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
    this.tMin = Math.min(...this.boats.map(b => b.tr.t0));
    this.tMax = Math.max(...Object.values(data.finish), 0) + 30;
    this.roundT = {};
    this.roundEst = {};
    for (const b of this.boats) this.roundT[b.sail] = this._rounding(b.tr);
    // Radio gaps near the windward mark hide many roundings: estimate those
    // from where the boat was last seen below the mark, at fleet VMG.
    const vmg = polar.optimal(data.twsModelKn, 0).upVmg * KN;
    for (const b of this.boats) {
      // The strict crossing can land on lap 2 when lap 1's rounding fell in a gap: take the earlier.
      const est = this._estimateRounding(b.tr, vmg);
      if (est != null && (this.roundT[b.sail] == null || est < this.roundT[b.sail] - 20)) {
        this.roundT[b.sail] = est; this.roundEst[b.sail] = true;
      }
    }
    this.t = -60;
  }

  twdAt(t) {
    const { t: T, deg } = this.twd;
    if (t <= T[0]) return deg[0];
    if (t >= T[T.length - 1]) return deg[deg.length - 1];
    let j = 0;
    while (j < T.length - 2 && T[j + 1] < t) j++;
    const f = (t - T[j]) / (T[j + 1] - T[j]);
    return norm360(deg[j] + wrap(deg[j + 1] - deg[j]) * f);
  }

  // When the real boat first passed the windward mark (same gate as the sim).
  _rounding(tr) {
    const c = this.course;
    const mUp = upwind(c.mark[0], c.mark[1], c.axis), mCr = cross(c.mark[0], c.mark[1], c.axis);
    let prev = null;
    for (let i = 0; i < tr.x.length; i++) {
      const t = tr.t0 + i;
      if (t < 60 || tr.x[i] === null) { prev = null; continue; }
      const up = upwind(tr.x[i], tr.y[i], c.axis);
      const off = cross(tr.x[i], tr.y[i], c.axis) - mCr;
      const d = Math.hypot(tr.x[i] - c.mark[0], tr.y[i] - c.mark[1]);
      if ((prev !== null && prev < mUp && up >= mUp && off > -25 && off < 45) || d < 15) return t;
      prev = up;
    }
    return null;
  }

  _estimateRounding(tr, vmg) {
    const c = this.course;
    const mUp = upwind(c.mark[0], c.mark[1], c.axis);
    let last = null;
    for (let i = 0; i < tr.x.length; i++) {
      const t = tr.t0 + i;
      if (t < 60) continue;
      if (tr.x[i] === null) {
        // A gap of 20 s+ that starts within 200 m below the mark: rounding hidden in it.
        let j = i; while (j < tr.x.length && tr.x[j] === null) j++;
        if (last && j - i >= 20 && last.up > mUp - 200) return Math.round(last.t + Math.max(0, mUp - last.up) / vmg);
        i = j - 1; continue;
      }
      const up = upwind(tr.x[i], tr.y[i], c.axis);
      if (up >= mUp - 15) return Math.round(t + Math.max(0, mUp - up) / vmg);
      last = { t, up };
    }
    return null;
  }

  setTime(t) {
    this.t = t;
    const twd = this.twdAt(t);
    for (const b of this.boats) {
      const s = trackState(b.fill, t);
      if (!s) { b.hidden = true; continue; }
      Object.assign(b, s);
      b.hidden = false;
      b.twd = twd; b.tws = this.d.twsModelKn;
      b.rel = wrap(b.hdg - twd); b.twa = Math.abs(b.rel);
      b.rounded = this.roundT[b.sail] !== null && t >= this.roundT[b.sail] ? this.roundT[b.sail] : null;
    }
  }

  trail(b, t, secs = 90) {
    const pts = [];
    for (let k = Math.max(b.tr.t0, Math.floor(t - secs)); k <= t; k += 2) {
      const s = trackState(b.tr, k);
      pts.push(s ? [s.x, s.y] : null);
    }
    return pts;
  }

  // Speed level that makes the polar match this boat's own upwind speed.
  levelFor(sail) {
    const b = this.boats.find(x => x.sail === sail);
    const v = [], twa = [];
    for (let i = 0; i < b.tr.x.length; i++) {
      const t = b.tr.t0 + i;
      if (t < 30 || b.tr.h[i] === null || b.tr.s[i] === null) continue;
      const r = Math.abs(wrap(b.tr.h[i] - this.twdAt(t)));
      if (r > 30 && r < 60 && b.tr.s[i] > 1.5) { v.push(b.tr.s[i]); twa.push(r); }
    }
    if (v.length < 60) return 0.2;
    const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    const vm = med(v), am = med(twa);
    let lo = -1, hi = 1.5;
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      if (this.polar.speed(this.d.twsModelKn, am, m) < vm) lo = m; else hi = m;
    }
    return Math.max(-1, Math.min(1.2, (lo + hi) / 2));
  }

  // Wind for a take-over: the inferred direction history, then (after the
  // data ends, or in a Monte Carlo fork) shifts drawn with this race's stats.
  windField(seed = 1) {
    const sh = this.cal.shifts.find(s => s.race === this.d.race);
    const twdMean = circMean(this.twd.deg);
    return new WindField({
      tws: this.d.twsModelKn, twd: twdMean, axis: this.course.axis,
      oscSd: sh?.osc_sd_deg ?? 4.5, periodS: (sh?.period_min ?? 7) * 60, trendSd: 0.15,
      pressureSd: 0.0, dirNoiseSd: 0, puffVeer: 0, propagate: false,
    }, seed, this.twd);
  }

  // A Sim where you sail `sail` from time t and everyone else is a ghost.
  takeOver(sail, t) {
    const wind = this.windField(7);
    const preset = { key: 'replay', label: `WCC race ${this.d.race}`, wind: wind.p, beat: Math.hypot(...this.d.windward),
                     line: this.course.lineLen, fleet: 0, lineSkewSd: 0 };
    const ghostTracks = {};
    const sim = new Sim({ cal: this.cal, polar: this.polar, preset, wind, course: this.course, startAt: t,
                          noSpawn: true, record: true, ghostTracks, tMax: this.tMax + 300 });
    const me = this.boats.find(b => b.sail === sail);
    const { est: _e, ...s } = trackState(me.fill, t) ?? trackState(me.fill, t + 1) ?? { x: 0, y: -50, hdg: 0, v: 1 };
    const user = makeBoat({ id: 0, sail: 'YOU', name: sail, color: '#ffffff', isUser: true, ...s,
                            level: this.levelFor(sail), mode: 'manual' });
    const w = wind.at(user.x, user.y, t);
    user.tws = w.tws; user.twd = w.twd; user.rel = wrap(user.hdg - w.twd); user.twa = Math.abs(user.rel);
    if (user.twa < 75) { user.ctl.mode = 'close'; user.ctl.side = user.rel >= 0 ? 1 : -1; }
    else { user.ctl.mode = 'manual'; user.ctl.hdg = user.hdg; }
    if (t >= 0) {
      const [bx, by] = bowPos(user);
      user.started = lineSide(this.course, bx, by) > 0;
      if (user.started) user.startT = 0;
      sim.gun = true;
    }
    user.realSail = sail;
    sim.boats.push(user);
    for (const b of this.boats) {
      if (b.sail === sail) {
        // your own real track, as a ghost to race against
        const g = makeBoat({ id: 1000, sail: `${sail} (real)`, color: '#4fb3ff', x: 0, y: 0, hdg: 0 });
        g.isGhost = true; g.noShadow = true; g.realRound = this.roundT[sail];
        ghostTracks[g.id] = b.fill; sim.boats.push(g);
        continue;
      }
      const g = makeBoat({ id: b.id, sail: b.sail, color: b.color, x: 0, y: 0, hdg: 0 });
      g.isGhost = true; g.realRound = this.roundT[b.sail];
      ghostTracks[g.id] = b.fill;
      sim.boats.push(g);
    }
    sim.updateGhosts(t);
    sim.replay = this;
    return sim;
  }
}
