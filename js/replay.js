// Real WCC 2026 races: playback of every boat's track with the wind the
// fleet's headings imply, and "take over": sail one boat yourself from any
// moment while the real fleet carries on as ghosts.

import { makeCourse, lineSide, PALETTE } from './course.js';
import { makeBoat, bowPos } from './boat.js';
import { WindField } from './wind.js';
import { Sim } from './sim.js';
import { wrap, norm360, bearing, upwind, cross, circMean, KN } from './geo.js';

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
  };
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
      id: i + 1, sail, tr, color: PALETTE[i % PALETTE.length], x: 0, y: 0, hdg: 0, v: 0,
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
      const s = trackState(b.tr, t);
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
    const s = trackState(me.tr, t) ?? trackState(me.tr, t + 1) ?? { x: 0, y: -50, hdg: 0, v: 1 };
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
        ghostTracks[g.id] = b.tr; sim.boats.push(g);
        continue;
      }
      const g = makeBoat({ id: b.id, sail: b.sail, color: b.color, x: 0, y: 0, hdg: 0 });
      g.isGhost = true; g.realRound = this.roundT[b.sail];
      ghostTracks[g.id] = b.tr;
      sim.boats.push(g);
    }
    sim.updateGhosts(t);
    sim.replay = this;
    return sim;
  }
}
