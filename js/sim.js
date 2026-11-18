// The race engine: start sequence, first beat to the windward mark.
//
// One Sim holds the course, the wind (a WindField), the boats and the
// bots' brains. step(dt) advances everything. Snapshots every 5 s make
// rewind/branch possible, and Sim.fromSnapshot() is how the Monte Carlo
// replays the same moment against different wind futures.

import { Rng, hashSeed } from './rng.js';
import { WindField } from './wind.js';
import { makeBoat, stepBoat, bowPos, sternPos, startPenalty, startTack, side } from './boat.js';
import { computeShadows } from './shadow.js';
import { giveWay, hullDist, CONTACT_M } from './rules.js';
import { initBrain, botThink, assignSlots } from './bots.js';
import { layCourse, lineSide, lineFrac, roster, PALETTE } from './course.js';
import { wrap, norm360, upwind, cross, unit, KN } from './geo.js';

export class Sim {
  constructor(cfg) {
    this.cal = cfg.cal;
    this.polar = cfg.polar;
    this.preset = cfg.preset;
    this.seed = cfg.seed ?? 1;
    this.rng = new Rng(hashSeed(this.seed, 'race'));
    this.wind = cfg.wind ?? new WindField(cfg.preset.wind, hashSeed(this.seed, 'wind'));
    this.t = cfg.startAt ?? -120;
    this.course = cfg.course ?? layCourse(cfg.preset, this.wind, new Rng(hashSeed(this.seed, 'course')));
    this.record = cfg.record !== false;
    this.boats = [];
    this.events = [];
    this.history = this.record ? [] : null;
    this.snaps = this.record ? [] : null;
    this.gun = this.t >= 0;
    this.contacts = new Set();
    this.roundCount = 0;
    this.fleetCross = 0;
    this.userRounded = null;
    this.userPolicy = null;
    this.penaltyTurns = cfg.penaltyTurns ?? 2;
    this.tMax = cfg.tMax ?? 1800;
    this.ghostTracks = cfg.ghostTracks ?? null;      // id -> real track (replay take-over)
    this._w = {};
    if (!cfg.noSpawn) this._spawn(cfg);
  }

  get user() { return this.boats.find(b => b.isUser); }

  _spawn(cfg) {
    const n = Math.min(cfg.fleetSize ?? this.preset.fleet, 22);
    const r = roster(this.cal, n);
    const c = this.course;
    const twd = this.wind.baseDir(this.t);
    const rng = this.rng;
    const lvl = cfg.userLevel ?? 0.3;
    const place = (f, d) => {
      const x = c.pin[0] + (c.boat[0] - c.pin[0]) * f - c.nx * d;
      const y = c.pin[1] + (c.boat[1] - c.pin[1]) * f - c.ny * d;
      return [x, y];
    };
    // You start a little below the middle of the line, reaching across it on starboard,
    // with the fleet around you (not 90 m away heading off).
    const [ux, uy] = place(0.55, 45);
    const user = makeBoat({ id: 0, sail: 'YOU', color: '#ffffff', isUser: true, x: ux, y: uy,
                            hdg: norm360(twd - 70), v: 2, level: lvl, mode: 'manual' });
    this.boats.push(user);
    r.forEach((p, i) => {
      const [x, y] = place(rng.range(-0.1, 1.1), rng.range(20, 85));
      const hdg = norm360(twd - rng.range(60, 120));      // starboard reach, like a real pre-start
      const b = makeBoat({ id: i + 1, sail: p.sail, color: PALETTE[i % PALETTE.length], x, y, hdg,
                           // Real boats' typical upwind pace spans about -0.3..+0.4 and barely tracks
                           // finishing place (the best finishers were ~average speed): tactics won.
                           v: rng.range(1, 2.5), level: -0.15 + 0.35 * p.iq + rng.normal(0, 0.2), mode: 'manual' });
      b.avgPlace = p.avgPlace;
      this.boats.push(b);
      // Bots need their local wind before planning.
      const w = this.wind.at(b.x, b.y, this.t);
      b.tws = w.tws; b.twd = w.twd; b.rel = wrap(b.hdg - w.twd); b.twa = Math.abs(b.rel);
      initBrain(b, p.iq, rng, this);
    });
    const w = this.wind.at(user.x, user.y, this.t);
    user.tws = w.tws; user.twd = w.twd; user.rel = wrap(user.hdg - w.twd); user.twa = Math.abs(user.rel);
    assignSlots(this);
  }

  log(type, text, boat = null) {
    if (!this.record && !(boat && boat.isUser)) return;
    this.events.push({ t: this.t, type, text, boat: boat ? boat.id : null });
  }

  // ---------------------------------------------------------------- step
  // Ghosts sit where the real boat was at time t (hidden during data gaps).
  updateGhosts(t) {
    if (!this.ghostTracks) return;
    for (const b of this.boats) {
      if (!b.isGhost) continue;
      const tr = this.ghostTracks[b.id];
      const s = tr ? ghostState(tr, t) : null;
      if (!s) { b.hidden = true; b.done = true; continue; }
      b.hidden = false; b.done = b.realRound != null && t >= b.realRound;
      b.x = s.x; b.y = s.y; b.hdg = s.hdg; b.v = s.v;
      const w = this.wind.at(b.x, b.y, t, this._w);
      b.tws = w.tws; b.twd = w.twd; b.rel = wrap(b.hdg - w.twd); b.twa = Math.abs(b.rel);
      b.rounded = b.done ? b.realRound : null;
    }
  }

  step(dt) {
    const t0 = this.t;
    const active = this.boats;
    this.updateGhosts(t0);
    for (const b of active) {
      if (b.isGhost) continue;
      const w = this.wind.at(b.x, b.y, t0, this._w);
      b.tws = w.tws; b.twd = w.twd; b.wp = w.p;
      b.rel = wrap(b.hdg - w.twd); b.twa = Math.abs(b.rel);
    }
    computeShadows(active);
    for (const b of active) {
      if (b.isGhost) continue;
      if (b.isUser) {
        if (this.userPolicy) this.userPolicy(this, b, dt);
        else this._userHousekeeping(b);
      } else botThink(this, b, dt);
    }
    for (const b of active) {
      if (b.isGhost) continue;
      // The exercise ends at the windward mark: a rounded bot bears away,
      // sails clear for 25 s and leaves the course (it would otherwise run
      // back down through the fleet still beating up).
      if (b.done && !b.isUser && this.t - b.rounded > 25) { b.hidden = true; continue; }
      b._prevBow = bowPos(b);
      stepBoat(b, { tws: b.tws, twd: b.twd }, this.polar, dt, t0);
    }
    this.t = t0 + dt;
    this._lineLogic(t0, this.t);
    this._marks();
    this._contacts();
    if (Math.floor(this.t) !== Math.floor(t0)) this._perSecond();
  }

  _userHousekeeping(b) {
    if (b.owesPenalty) {
      if (b.owedSince == null) b.owedSince = this.t;
      if (this.t - b.owedSince > 8) { this.takePenalty(b); this.log('rule', 'Penalty turns started automatically.', b); }
    }
    if (b.done && b.ctl.mode !== 'bearaway') { b.ctl.mode = 'run'; b.ctl.side = -1; }
  }

  takePenalty(b) {
    if (b.ctl.mode === 'penalty') return;
    startPenalty(b, this.penaltyTurns);
    b.owedSince = null;
    this.log('rule', `${b.sail} doing ${this.penaltyTurns === 1 ? 'a one-turn' : 'a two-turn'} penalty.`, b);
  }

  _lineLogic(t0, t1) {
    const c = this.course;
    if (t0 < 0 && t1 >= 0) {
      this.gun = true;
      for (const b of this.boats) {
        if (b.isGhost) continue;
        const [bx, by] = bowPos(b);
        const s = lineSide(c, bx, by);
        b.gunDtl = -s;
        b.gunSpeed = b.v / KN;
        b.gunFrac = lineFrac(c, bx, by);
        if (s > 0) {
          b.ocs = true;
          this.log('start', b.isUser ? 'OCS! You were over at the gun. Sail back below the line and restart.' : `${b.sail} OCS`, b);
        }
      }
      const u = this.user;
      if (u && !u.ocs) this.log('start', `Gun. You were ${u.gunDtl.toFixed(1)} m behind the line at ${u.gunSpeed.toFixed(1)} kn.`, u);
    }
    if (t1 < 0) return;
    for (const b of this.boats) {
      if (b.isGhost || b.started) continue;
      const [bx, by] = bowPos(b);
      const s = lineSide(c, bx, by);
      if (b.ocs && !b.ocsCleared) {
        const [sx, sy] = sternPos(b);
        if (s < 0 && lineSide(c, sx, sy) < 0) {
          b.ocsCleared = true;
          this.log('start', b.isUser ? 'Cleared. Now start properly.' : `${b.sail} cleared`, b);
        }
        continue;
      }
      const [px, py] = b._prevBow ?? [bx, by];
      const s0 = lineSide(c, px, py);
      if (s0 <= 0 && s > 0) {
        const f = lineFrac(c, bx, by);
        // Your start must be between the ends; bots get some slack.
        const slack = b.isUser ? 0.02 : 0.35;
        if (f > -slack && f < 1 + slack) {
          b.started = true;
          b.startT = t0 + (t1 - t0) * (-s0 / (s - s0 || 1));
          b.startFrac = f;
          if (b.isUser) this.log('start', `Started at ${b.startT.toFixed(1)} s, ${(f * 100).toFixed(0)}% of the way from pin to boat.`, b);
        } else if (b.isUser) {
          this.log('start', 'You crossed outside the line ends. That does not count as a start.', b);
        }
      }
    }
  }

  _marks() {
    const c = this.course;
    const [mx, my] = c.mark;
    const mUp = upwind(mx, my, c.axis);
    const mCross = cross(mx, my, c.axis);
    for (const b of this.boats) {
      if (b.isGhost || b.done) continue;
      const up = upwind(b.x, b.y, c.axis);
      const prevUp = b._prevUp ?? up;
      b._prevUp = up;
      if (!b.started) continue;
      // Rounding: crossing the mark's level going up the course with the
      // mark on your port side (you are 0-15 m to its right). Passing it on
      // the other side, or far out, doesn't count.
      const off = cross(b.x, b.y, c.axis) - mCross;
      const prevOff = b._prevOff ?? off;
      b._prevOff = off;
      const crossing = prevUp < mUp && up >= mUp;
      if (up < mUp - 2) { b.overstoodRight = false; b.wrongSide = false; }
      if (crossing && off > 15) b.overstoodRight = true;
      if (crossing && off <= 0) {
        b.wrongSide = true;
        if (b.isUser && off > -40) this.log('mark', 'Wrong side: leave the mark to port (pass to its right, mark on your left).', b);
      }
      // Rounded: up past the mark close on its right, or (overstood) reaching
      // in over the top of it from the right (the string test of rule 28).
      const overTop = b.overstoodRight && !b.wrongSide && prevOff > 0 && off <= 0 && up >= mUp && up < mUp + 40;
      if ((crossing && off > 0 && off <= 15) || overTop) {
        this.roundCount++;
        b.rounded = this.t; b.roundRank = this.roundCount; b.done = true;
        b.ctl.mode = 'bearaway'; b.ctl.side = -1; b.ctl.eased = false; b.ctl.offset = 0; b.ctl.stop = false; b.ctl.trim = 1;
        if (b.isUser) {
          this.userRounded = this.t;
          this.log('mark', `You rounded ${ordinal(b.roundRank)} at ${fmtT(this.t)}.`, b);
        } else if (this.roundCount === 1) {
          this.log('mark', `${b.sail} leads at the windward mark (${fmtT(this.t)}).`, b);
        }
      }
    }
  }

  _contacts() {
    const B = this.boats;
    for (let i = 0; i < B.length; i++) {
      const a = B[i];
      if (a.done || a.isGhost) continue;
      for (let j = i + 1; j < B.length; j++) {
        const b = B[j];
        if (b.done) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        if (dx > 6 || dx < -6 || dy > 6 || dy < -6) {
          this.contacts.delete(a.id + ':' + b.id);
          continue;
        }
        const key = a.id + ':' + b.id;
        const d = hullDist(a, b);
        if (d < CONTACT_M) {
          if (this.contacts.has(key)) continue;
          this.contacts.add(key);
          // One incident per pair per 30 s; none while already spinning.
          this._lastContact = this._lastContact || new Map();
          if ((this._lastContact.get(key) ?? -1e9) > this.t - 30) continue;
          this._lastContact.set(key, this.t);
          if (b.isGhost || a.isGhost) {
            const me = a.isGhost ? b : a, gh = a.isGhost ? a : b;
            if (me.isUser) this.log('rule', `You'd have hit ${gh.sail} (a ghost, it can't react).`, me);
            continue;
          }
          const gw = giveWay(a, b);
          const other = gw === a ? b : a;
          if (gw.ctl.mode === 'penalty' || gw.owesPenalty) continue;
          // Rules 15/16 (simplified): a right-of-way boat that just got her
          // rights or was swinging hard didn't give room, so no penalty.
          if (this.t - Math.max(other.tackChangedAt ?? -1e9, other.rowAcquiredAt ?? -1e9) < 4
              || this.t - (other.courseChangedAt ?? -1e9) < 3) {
            if (a.isUser || b.isUser) this.log('rule', `Contact with ${(a.isUser ? b : a).sail}: no penalty (right-of-way boat changed course or tack; rules 15/16).`, this.user);
            continue;
          }
          gw.owesPenalty = true;
          (this.incidents ??= []).push({ t: this.t, rule: ruleText(gw, other), gw: gw.sail, other: other.sail,
                                          gwMode: gw.ctl.mode, gwEvade: gw.brain?.evadeMode ?? null, gwPhase: gw.brain?.phase ?? null });
          if (a.isUser || b.isUser) {
            const why = ruleText(gw, other);
            this.log('rule', gw.isUser ? `Contact with ${other.sail}: you had to keep clear (${why}). Take your penalty (X).`
                                       : `Contact with ${gw.sail}: they had to keep clear (${why}). They take a penalty.`, this.user);
          }
        } else if (d > 2) {
          this.contacts.delete(key);
        }
      }
    }
  }

  _perSecond() {
    const live = this.boats.filter(b => !b.done && !b.isGhost && b.started);
    if (live.length) {
      const cr = live.map(b => cross(b.x, b.y, this.course.axis)).sort((a, b) => a - b);
      this.fleetCross = cr[cr.length >> 1];
    }
    if (!this.record) return;
    const n = this.boats.length;
    const row = new Float32Array(n * 8);
    this.boats.forEach((b, i) => {
      if (b.hidden) row.set([NaN, NaN, NaN, 0, 0, b.twd, b.tws, 0], i * 8);
      else row.set([b.x, b.y, b.hdg, b.v, b.loss, b.twd, b.tws, b.ctl.mode === 'penalty' ? 1 : 0], i * 8);
    });
    this.history.push({ t: Math.round(this.t), row, base: this.wind.baseDir(this.t) });
    if (Math.round(this.t) % 5 === 0) this.snaps.push(this.snapshot());
  }

  // ---------------------------------------------------------------- user controls
  userSteer(deg) {
    const u = this.user;
    if (!u || u.ctl.mode === 'tack' || u.ctl.mode === 'gybe' || u.ctl.mode === 'penalty') return;
    if (u.ctl.mode === 'close' || u.ctl.mode === 'run') {
      // In autopilot the arrows pinch/foot: + = bear away on either tack.
      const s = u.ctl.side;
      const away = s > 0 ? deg : -deg;          // clockwise on port bears away
      u.ctl.offset = Math.max(-12, Math.min(40, u.ctl.offset + away));
      if (u.ctl.mode === 'close' && u.ctl.offset > 30) { u.ctl.mode = 'manual'; u.ctl.hdg = u.hdg; }
    } else {
      u.ctl.mode = 'manual';
      u.ctl.hdg = norm360((u.ctl.hdg ?? u.hdg) + deg);
    }
  }
  userTack() {
    const u = this.user;
    if (!u || u.ctl.mode === 'tack' || u.ctl.mode === 'gybe' || u.ctl.mode === 'penalty') return;
    // Keep the moment just before each of your tacks, for grading later.
    if (this.record && this.t > 0 && u.started && !u.done && u.twa < 90) {
      const dec = { t: this.t, snap: this.snapshot() };
      if (this.onBeforeUserTack) dec.ctx = this.onBeforeUserTack(this);     // what it looked like when you decided
      (this.decisions ??= []).push(dec);
    }
    u.ctl.after = 'close';
    startTack(u, this.t);
  }
  userClose() { const u = this.user; if (u) { u.ctl.mode = 'close'; u.ctl.side = side(u.rel); u.ctl.offset = 0; u.ctl.eased = false; } }
  userEase(on) { const u = this.user; if (u) u.ctl.eased = on; }
  userPenalty() { const u = this.user; if (u && (u.owesPenalty || u.ctl.mode !== 'penalty')) this.takePenalty(u); }

  // ---------------------------------------------------------------- snapshots
  snapshot() {
    return {
      t: this.t, boats: structuredClone(this.boats.map(b => ({ ...b, _prevBow: undefined }))),
      rng: this.rng.state(), gun: this.gun, roundCount: this.roundCount, fleetCross: this.fleetCross,
      contacts: [...this.contacts], nEvents: this.events.length,
      nHistory: this.history ? this.history.length : 0, userRounded: this.userRounded,
    };
  }

  restore(s) {
    this.t = s.t;
    this.boats = structuredClone(s.boats);
    this.rng = Rng.from(s.rng);
    this.gun = s.gun; this.roundCount = s.roundCount; this.fleetCross = s.fleetCross;
    this.contacts = new Set(s.contacts);
    this.userRounded = s.userRounded;
    this.events.length = Math.min(this.events.length, s.nEvents);
    if (this.history) this.history.length = Math.min(this.history.length, s.nHistory);
    if (this.snaps) this.snaps = this.snaps.filter(x => x.t <= s.t);
    if (this.decisions) this.decisions = this.decisions.filter(d => d.t < s.t);
    this.finished = false;
  }

  static fromSnapshot(s, ctx) {
    const sim = new Sim({ ...ctx, noSpawn: true, record: ctx.record ?? false, startAt: s.t });
    sim.events = [];
    sim.restore({ ...s, nEvents: 0, nHistory: 0 });
    return sim;
  }

  // Ranking right now: boats that rounded first, then by distance to the mark
  // measured as upwind progress still to make.
  standings() {
    const c = this.course;
    const mUp = upwind(c.mark[0], c.mark[1], c.axis);
    return this.boats.filter(b => !b.isGhost).map(b => ({
      b, key: b.rounded !== null ? b.rounded - 1e6 : (mUp - upwind(b.x, b.y, c.axis)),
    })).sort((a, b) => a.key - b.key).map(x => x.b);
  }
}

function ghostState(tr, t) {
  const f = t - tr.t0, i = Math.floor(f);
  if (i < 0 || i + 1 >= tr.x.length || tr.x[i] === null || tr.x[i + 1] === null || tr.h[i] === null || tr.h[i + 1] === null) return null;
  const a = f - i;
  return {
    x: tr.x[i] + (tr.x[i + 1] - tr.x[i]) * a, y: tr.y[i] + (tr.y[i + 1] - tr.y[i]) * a,
    hdg: norm360(tr.h[i] + wrap(tr.h[i + 1] - tr.h[i]) * a),
    v: ((tr.s[i] ?? 0) + ((tr.s[i + 1] ?? 0) - (tr.s[i] ?? 0)) * a) * KN,
  };
}

export function ruleText(gw, other) {
  if (gw.ctl.mode === 'penalty') return 'doing penalty turns';
  if (gw.r13 && !other.r13) return 'rule 13, tacking';
  const ta = gw.rel >= 0, tb = other.rel >= 0;
  if (ta !== tb) return 'rule 10, port tack';
  const [hx, hy] = unit(other.hdg);
  const lon = (gw.x - other.x) * hx + (gw.y - other.y) * hy;
  if (lon < -4.6) return 'rule 12, clear astern';
  return 'rule 11, windward';
}

export function fmtT(t) {
  const s = Math.round(Math.abs(t));
  return `${t < 0 ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
