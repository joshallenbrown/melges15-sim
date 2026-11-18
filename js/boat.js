// Boat physics: steering, tacking and gybing, speed response.
//
// Speed chases the polar target with a first-order lag. Turning fast adds
// drag. With the constants below a tack in 7-9 kn drops to ~56% of entry
// speed and costs ~2.5 m against a boat that kept going, which is what the
// WCC tracks show (tools/analyze.py; checked in tests/physics.test.mjs).

import { KN, BOAT_LEN, wrap, norm360, unit, clamp } from './geo.js';

export const PHYS = {
  steerRate: 30,      // deg/s, normal steering
  tackRate: 24,       // deg/s through a tack or gybe
  penaltyRate: 30,    // deg/s spinning a penalty
  tauAcc: 2.6,        // s, speeding up
  tauDec: 3.8,        // s, slowing down (through a tack)
  tauLuff: 1.6,       // s, slowing down by luffing
  turnDrag: 0.30,     // extra loss at full turn rate
  easedFactor: 0.15,  // speed target with sheets eased (luffing)
  len: BOAT_LEN,
};

export function makeBoat(o) {
  return {
    id: o.id, sail: o.sail ?? String(o.id), name: o.name ?? '', color: o.color ?? '#ddd',
    isUser: !!o.isUser, isGhost: false,
    x: o.x, y: o.y, hdg: o.hdg, v: o.v ?? 1.0,
    level: o.level ?? 0.3,                  // speed level for the polar
    ctl: { mode: o.mode ?? 'manual', hdg: o.hdg, side: 0, eased: !!o.eased, offset: 0,
           fromRel: 0, penaltyLeft: 0, after: null },
    rel: 0, twa: 0, tws: 0, twd: 0, loss: 0, turnRate: 0,
    r13: false,            // between head-to-wind and close-hauled (rule 13)
    lastTack: -999, tacks: 0,
    // race state
    started: false, startT: null, ocs: false, ocsCleared: false, wasCourseSide: false,
    rounded: null, roundRank: null, done: false, penalties: 0, owesPenalty: false,
    gunDtl: null, gunSpeed: null,
  };
}

export function side(rel) { return rel >= 0 ? 1 : -1; }   // +1 port, -1 starboard

// Begin a tack: from close-hauled (or any upwind angle) to the other tack.
export function startTack(b, t) {
  if (b.ctl.mode === 'tack' || b.ctl.mode === 'gybe' || b.ctl.mode === 'penalty') return false;
  if (Math.abs(b.rel) > 100) return startGybe(b, t);
  b.ctl.fromRel = b.rel;
  b.ctl.mode = 'tack';
  b.ctl.after = 'close';
  b.lastTack = t;
  b.tacks++;
  return true;
}

export function startGybe(b, t) {
  if (b.ctl.mode === 'tack' || b.ctl.mode === 'gybe' || b.ctl.mode === 'penalty') return false;
  b.ctl.fromRel = b.rel;
  b.ctl.mode = 'gybe';
  b.ctl.after = b.ctl.after === 'run' ? 'run' : 'manual';
  b.lastTack = t;
  return true;
}

export function startPenalty(b, turns = 2) {
  b.ctl.mode = 'penalty';
  b.ctl.penaltyLeft = 360 * turns;
  b.ctl.penaltyDir = b.rel >= 0 ? -1 : 1;   // turn toward the wind first
  b.owesPenalty = false;
  b.penalties++;
}

// One physics step. `w` = local wind {tws (kn), twd}, `polar`, dt seconds.
export function stepBoat(b, w, polar, dt, t) {
  b.tws = w.tws; b.twd = w.twd;
  const opt = polar.optimal(w.tws, b.level);
  let rel = wrap(b.hdg - w.twd);
  const ctl = b.ctl;
  let turn = 0;                                   // deg this step (+ = clockwise)

  if (ctl.mode === 'close' || ctl.mode === 'run') {
    if (ctl.side === 0) ctl.side = side(rel);
    const target = ctl.mode === 'close' ? ctl.side * (opt.upTwa + ctl.offset) : ctl.side * (opt.dnTwa + ctl.offset);
    const want = norm360(w.twd + target);
    turn = clamp(wrap(want - b.hdg), -PHYS.steerRate * dt, PHYS.steerRate * dt);
  } else if (ctl.mode === 'manual') {
    turn = clamp(wrap(ctl.hdg - b.hdg), -PHYS.steerRate * dt, PHYS.steerRate * dt);
  } else if (ctl.mode === 'tack' || ctl.mode === 'gybe') {
    const from = ctl.fromRel;
    const toSide = -side(from);
    const toRel = ctl.mode === 'tack'
      ? toSide * Math.max(opt.upTwa, Math.min(Math.abs(from), 70))
      : toSide * Math.min(Math.max(Math.abs(from), 110), 175);
    // Tack: rel moves toward 0 then through it. Gybe: through 180.
    const dir = ctl.mode === 'tack' ? -side(from) : side(from);
    turn = dir * PHYS.tackRate * dt;
    const newRel = wrap(rel + turn);
    if (ctl.mode === 'tack') {
      if (side(newRel) !== side(from)) b.r13 = true;
      const reached = side(newRel) === toSide && Math.abs(newRel) >= Math.abs(toRel) - 0.5;
      if (reached) {
        turn = wrap(toRel - rel);
        b.rowAcquiredAt = t;                    // rule 15: new rights, must give room at first
        ctl.mode = ctl.after === 'manual' ? 'manual' : 'close';
        ctl.side = toSide; ctl.hdg = norm360(w.twd + toRel); ctl.offset = 0;
        b.r13 = false;
      }
    } else {
      const crossed = side(newRel) === toSide && Math.abs(newRel) < 179;
      if (crossed && Math.abs(newRel) <= Math.abs(toRel) + 0.5) {
        turn = wrap(toRel - rel);
        ctl.mode = ctl.after === 'run' ? 'run' : 'manual';
        ctl.side = toSide; ctl.hdg = norm360(w.twd + toRel); ctl.offset = 0;
      }
    }
  } else if (ctl.mode === 'bearaway') {
    // Rounding a mark to port: always turn counterclockwise (heading
    // decreasing), through head-to-wind first if arriving on port, until on
    // the starboard run.
    const target = -opt.dnTwa;
    let d = rel - target;                       // degrees still to turn (counterclockwise)
    if (d < 0) d += 360;
    if (d > 300) d = 0;                         // already at or past the run angle
    const step = Math.min(PHYS.tackRate * dt, d);
    turn = -step;
    if (d - step < 0.5) { ctl.mode = 'run'; ctl.side = -1; ctl.offset = 0; }
  } else if (ctl.mode === 'penalty') {
    const step = Math.min(PHYS.penaltyRate * dt, ctl.penaltyLeft);
    turn = ctl.penaltyDir * step;
    ctl.penaltyLeft -= step;
    if (ctl.penaltyLeft <= 0) {
      ctl.mode = Math.abs(wrap(b.hdg + turn - w.twd)) < 90 ? 'close' : 'manual';
      ctl.side = side(wrap(b.hdg + turn - w.twd));
      ctl.hdg = norm360(b.hdg + turn);
    }
  }

  b.hdg = norm360(b.hdg + turn);
  b.turnRate = Math.abs(turn) / dt;
  if (b.turnRate > 10) b.courseChangedAt = t;  // rule 16: course changes must leave room
  rel = wrap(b.hdg - w.twd);
  if ((rel >= 0) !== (b.rel >= 0)) b.tackChangedAt = t;    // for rules 15/16
  b.rel = rel;
  b.twa = Math.abs(rel);

  let vt = polar.speed(w.tws, b.twa, b.level) * KN * (1 - b.loss);
  if (ctl.mode !== 'tack' && ctl.mode !== 'gybe' && ctl.mode !== 'bearaway') {
    if (ctl.stop) vt *= 0.02;                  // head to wind, sails flogging: parked
    else if (ctl.eased) vt *= PHYS.easedFactor;
    else if (ctl.trim !== undefined && ctl.trim < 1) vt *= Math.max(PHYS.easedFactor, ctl.trim);
  }
  vt *= 1 - PHYS.turnDrag * Math.min(1, b.turnRate / 25);
  // Luffing (sails flogging, heading up) stops a dinghy much faster than a tack does.
  const tau = vt > b.v ? PHYS.tauAcc : (ctl.stop || ctl.eased ? PHYS.tauLuff : PHYS.tauDec);
  b.v += (vt - b.v) * (1 - Math.exp(-dt / tau));
  const [ux, uy] = unit(b.hdg);
  b.x += ux * b.v * dt;
  b.y += uy * b.v * dt;
}

export function bowPos(b) {
  const [ux, uy] = unit(b.hdg);
  return [b.x + ux * PHYS.len / 2, b.y + uy * PHYS.len / 2];
}
export function sternPos(b) {
  const [ux, uy] = unit(b.hdg);
  return [b.x - ux * PHYS.len / 2, b.y - uy * PHYS.len / 2];
}
