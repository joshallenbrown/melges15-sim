// Bot sailors. Each one has
//   iq      0..1 tactical skill (from its real average finish at the WCC)
//   level   polar speed level
// and sails the way the WCC fleet did (tests/realism.mjs compares them):
//
//   pre-start  each bot gets its own slot on the line (front row, ~6.5 m
//              apart; weaker sailors sometimes second row), hangs back,
//              moves up to 1-3 boat lengths below the line around T-60,
//              parks there luffing, then trims on to hit the line at the gun
//              (+ a timing error that shrinks with skill).
//   OCS        a quick dip below the line, then back up (as the real OCS
//              boats did: 3-9 m below and back within ~15 s).
//   beat       close-hauled, tacking on headers, out of bad air, laylines,
//              not too far from the fleet; port gives way to starboard with
//              small, early course changes.
//   mark       approach to leave it to PORT: lay a point just right of the
//              mark, cross its level, then bear away round it (a tack first
//              if arriving on port). Overstood boats come back down to the
//              right of the mark before rounding.
//
// The same policy (with iq ~0.8) sails YOUR boat inside the Monte Carlo
// after the option being tested, so options are compared fairly.

import { wrap, norm360, bearing, unit, upwind, cross, KN, clamp, BOAT_LEN, D2R } from './geo.js';
import { startTack, side, bowPos, PHYS } from './boat.js';
import { giveWay, closestApproach } from './rules.js';
import { lineSide, linePoint, lineBias } from './course.js';

const SLOT_M = 6.5;          // spacing between boats on the line

export function initBrain(b, iq, rng, sim) {
  b.brain = {
    iq,
    phase: 'setup',
    f: 0.5, row: 1,
    setupDist: rng.range(6, 12),                 // metres below the line while parked
    stageDist: rng.range(28, 45),                // hang-back distance before moving up
    moveUpAt: rng.range(55, 70),                 // seconds before the gun
    // Real fleet: median 1.5 m behind at the gun (~0.8 s late), 20% over.
    timingErr: rng.normal(0.2 + 0.8 * (1 - iq), 0.8 + 1.0 * (1 - iq)),
    headerThr: 3.5 + 4.5 * (1 - iq) + rng.normal(0, 0.7),
    overstand: Math.max(0, 1 + 4 * (1 - iq) + rng.normal(0, 1)),
    commitS: rng.range(10, 30 + 50 * (1 - iq)),
    compassErr: 0, compassSd: 0.5 + 1.5 * (1 - iq),
    med: null, badAir: 0, evadeUntil: -999, evadeMode: null, evadeFrom: null,
    noTackUntil: -999, forceTackAt: null, laylineOnly: false, helmNoise: 0,
    goingAround: false,
  };
  planStart(b, rng, sim);
}

function planStart(b, rng, sim) {
  const br = b.brain;
  const c = sim.course;
  // The bot reads the line bias with an error that shrinks with skill.
  const twdSeen = sim.wind.baseDir(sim.t) + rng.normal(0, 8 * (1 - br.iq) + 2);
  const bias = lineBias(c, twdSeen);                       // + = pin upwind
  const pFav = 0.3 + 0.5 * br.iq;
  if (Math.abs(bias) > 4 && rng.next() < pFav) {
    br.f = bias > 0 ? rng.range(0.03, 0.35) : rng.range(0.65, 0.97);
  } else {
    br.f = rng.range(0.05, 0.95);
  }
}

// Give every bot its own spot on the line: better sailors pick first; each
// takes the free slot nearest the spot it wanted. Weaker sailors sometimes
// end up a row back.
export function assignSlots(sim) {
  const c = sim.course;
  const bots = sim.boats.filter(b => b.brain && !b.isUser && !b.isGhost).sort((a, b) => b.brain.iq - a.brain.iq);
  const n = Math.max(1, Math.floor(c.lineLen / SLOT_M));
  const taken = new Array(n).fill(false);
  for (const b of bots) {
    const br = b.brain;
    const want = Math.round(clamp(br.f, 0.02, 0.98) * (n - 1));
    let best = -1;
    for (let d = 0; d < n; d++) {
      for (const k of [want - d, want + d]) {
        if (k >= 0 && k < n && !taken[k]) { best = k; break; }
      }
      if (best >= 0) break;
    }
    const secondRow = best < 0 || Math.abs(best - want) > n * 0.45 || sim.rng.next() < 0.12 * (1 - br.iq);
    if (secondRow) {
      br.row = 2;
      br.setupDist += 9;
      br.f = clamp(br.f + sim.rng.normal(0, 0.03), 0.04, 0.96);
    } else {
      taken[best] = true;
      br.f = (best + 0.5) / n;
    }
  }
}

// Heading for the final run at the line. The real fleet crossed footing for
// speed: a median 53 deg to the wind (p75 65) at ~94% of upwind speed. So
// starboard, ~12 deg below close-hauled (or square to the line if that's freer).
export const FOOT = 12;
export function approachHeading(b, sim) {
  const c = sim.course;
  const opt = sim.polar.optimal(b.tws, b.level);
  const perp = bearing(c.nx, c.ny);
  const rel = wrap(perp - b.twd);
  if (rel < -(opt.upTwa + FOOT)) return perp;
  return norm360(b.twd - opt.upTwa - FOOT);
}

// Time (s) to reach the line from here if the bot trims on now and sails
// its approach heading.
export function timeToLine(b, sim) {
  const c = sim.course;
  const [bx, by] = bowPos(b);
  const d = -lineSide(c, bx, by);
  if (d <= 0) return 0;
  const hdg = approachHeading(b, sim);
  const [hx, hy] = unit(hdg);
  const comp = Math.max(0.3, hx * c.nx + hy * c.ny);
  const vf = sim.polar.speed(b.tws, Math.abs(wrap(hdg - b.twd)), b.level) * KN, v0 = b.v, tau = PHYS.tauAcc;
  const dist = (T) => comp * (vf * T - (vf - v0) * tau * (1 - Math.exp(-T / tau)));
  let lo = 0, hi = 300;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (dist(m) < d) lo = m; else hi = m; }
  return hi;
}

// ------------------------------------------------------------------ main
export function botThink(sim, b, dt) {
  const br = b.brain;
  const t = sim.t;
  if (b.done) {
    if (b.ctl.mode !== 'bearaway') { b.ctl.mode = 'run'; b.ctl.side = -1; }
    // 25 s after rounding, broad-reach off to the left of the course (~105° TWA)
    // so finished boats leave the beat instead of running back through it.
    b.ctl.offset = t - b.rounded > 25 ? -30 : 0;
    b.ctl.eased = false; b.ctl.stop = false; b.ctl.trim = 1;
    return;
  }
  if (b.ctl.mode === 'penalty' || b.ctl.mode === 'tack' || b.ctl.mode === 'gybe' || b.ctl.mode === 'bearaway') return;
  if (b.owesPenalty && clearOfOthers(sim, b, 12)) { sim.takePenalty(b); return; }

  // Compass noise (slow wander) and the bot's running median wind.
  const phi = Math.exp(-dt / 40);
  br.compassErr = br.compassErr * phi + br.compassSd * Math.sqrt(1 - phi * phi) * sim.rng.gauss();
  const seen = b.twd + br.compassErr;
  if (br.med === null) br.med = seen;
  br.med = norm360(br.med + wrap(seen - br.med) * Math.min(1, dt / 240));
  br.badAir += (b.loss - br.badAir) * Math.min(1, dt / 5);

  if (avoid(sim, b, t)) return;
  if (t < br.evadeUntil) return;
  if (br.evadeMode) {
    br.evadeMode = null; b.ctl.eased = false; b.ctl.trim = 1; b.ctl.stop = false;
    if (t >= 0) { b.ctl.mode = 'close'; b.ctl.side = side(b.rel); b.ctl.offset = 0; }
  }

  if (t < 0) return prestart(sim, b);
  b.ctl.stop = false;
  if (br.phase !== 'race' && br.phase !== 'return') {
    br.phase = b.ocs ? 'return' : 'race';
    b.ctl.eased = false; b.ctl.trim = 1;
    if (br.phase === 'race') { b.ctl.mode = 'close'; b.ctl.side = side(b.rel); b.ctl.offset = FOOT / 2; br.footUntil = t + 4; }
  }
  if (br.phase === 'return') {
    if (b.ocsCleared) {
      br.phase = 'race';
      b.ctl.mode = 'close'; b.ctl.side = -1; b.ctl.offset = 0;
      br.noTackUntil = t + 12;
    } else {
      // Dip: bear off hard to get back below the line fast (real OCS boats
      // were back below within ~5-15 s), then come straight back up.
      b.ctl.mode = 'manual';
      b.ctl.hdg = norm360(b.twd - 135);
      b.ctl.eased = false; b.ctl.trim = 1;
    }
    return;
  }
  if (br.footUntil && t > br.footUntil) { b.ctl.offset = 0; br.footUntil = null; }
  b.ctl.trim = 1; b.ctl.eased = false;
  if (!b.started && t > 20) {
    // Crossed outside an end: get back below the line and cross between the ends.
    const [bx2, by2] = bowPos(b);
    if (lineSide(sim.course, bx2, by2) > 0) { b.ctl.mode = 'manual'; b.ctl.hdg = norm360(b.twd + (b.rel >= 0 ? 115 : -115)); }
    else steerToPoint(sim, b, linePoint(sim.course, clamp(br.f, 0.15, 0.85)), 3);
    return;
  }
  raceDecisions(sim, b, seen, t);
}

// ------------------------------------------------------------------ pre-start
function prestart(sim, b) {
  const br = b.brain, c = sim.course;
  const left = -sim.t;
  const [bx, by] = bowPos(b);
  const s = lineSide(c, bx, by);
  const opt = sim.polar.optimal(b.tws, b.level);
  b.ctl.stop = false;

  if (br.phase === 'go') {
    // Footing on starboard at the line; trim so the bow gets there at the
    // gun + this sailor's timing error.
    b.ctl.mode = 'close'; b.ctl.side = -1; b.ctl.offset = FOOT;
    // Luff until it's time, then trim on fully: hit the line at speed.
    const want = left + br.timingErr;
    const ttl = timeToLine(b, sim);
    b.ctl.eased = false; b.ctl.trim = 1; br.intentTrim = 1;
    if (s > -0.5 && left > 1) { b.ctl.stop = true; br.intentTrim = 0; return; }   // at the line early: luff hard
    // Early: burn time but keep the boat moving (as the real fleet did, ~3.7 kn at the gun).
    if (ttl < want - 1.2) { b.ctl.trim = s > -1.5 ? 0.15 : 0.5; br.intentTrim = b.ctl.trim; }
    return;
  }
  // Over the line before the final run: bear off and get back below it.
  // (Merely close to it in the last 20 s: just stay parked, luffing.)
  if (s > -0.3 && (left > 20 || s > 0.5)) {
    b.ctl.mode = 'manual'; b.ctl.hdg = norm360(b.twd - 125); b.ctl.eased = false; b.ctl.trim = 1;
    return;
  }
  const ttl = timeToLine(b, sim);
  if (left < 75 && left + br.timingErr <= ttl + 1) {
    br.phase = 'go';
    b.ctl.mode = 'close'; b.ctl.side = -1; b.ctl.offset = FOOT; b.ctl.eased = false; b.ctl.trim = 1;
    return;
  }
  // Parking spot below the slot (or further back until it's time to move up).
  const dist = left > br.moveUpAt ? br.stageDist : br.setupDist;
  const [lx, ly] = linePoint(c, br.f);
  const [hx, hy] = unit(approachHeading(b, sim));
  const cosA = Math.max(0.35, hx * c.nx + hy * c.ny);
  const tx = lx - hx * dist / cosA, ty = ly - hy * dist / cosA;
  const d = Math.hypot(tx - b.x, ty - b.y);
  const ahead = -((tx - b.x) * c.nx + (ty - b.y) * c.ny);             // + = I'm closer to the line than the spot
  if (d > 4 && ahead < 1) {
    br.phase = 'setup';
    steerToPoint(sim, b, [tx, ty], 0);
    // Don't charge in: come in slower the closer the spot (luffing stops in ~1 boat length).
    const vFull = sim.polar.speed(b.tws, Math.max(b.twa, 40), b.level) * KN;
    b.ctl.trim = clamp((0.3 + 0.25 * d) / Math.max(vFull, 0.5), 0.2, 1);
    br.intentTrim = b.ctl.trim;
    b.ctl.eased = false;
  } else {
    // Parked: pointing close-hauled on starboard, sails luffing.
    br.phase = 'hold';
    b.ctl.mode = 'manual';
    b.ctl.hdg = norm360(b.twd - (opt.upTwa + 5));
    b.ctl.eased = false;
    if (ahead > 0.5 || d < 3) { b.ctl.stop = true; br.intentTrim = 0; }
    else { b.ctl.trim = 0.3; br.intentTrim = 0.3; }
  }
}

// Sail toward a point: straight if sailable, else close-hauled on the tack
// that gets closer to it (`pad` = extra degrees off the wind when reaching).
function steerToPoint(sim, b, [px, py], pad = 0) {
  const opt = sim.polar.optimal(b.tws, b.level);
  const aim = bearing(px - b.x, py - b.y);
  const r = wrap(aim - b.twd);
  if (Math.abs(r) >= opt.upTwa + pad) { b.ctl.mode = 'manual'; b.ctl.hdg = aim; return; }
  const want = r < 0 || (Math.abs(r) < 6 && b.rel < 0) ? -1 : 1;
  if (b.ctl.mode === 'close' && b.ctl.side === want) return;
  if (b.ctl.mode === 'close' && b.ctl.side !== want && b.twa < 80) { startTack(b, sim.t); return; }
  b.ctl.mode = 'close'; b.ctl.side = want; b.ctl.offset = 0;
}

// ------------------------------------------------------------------ the beat
function raceDecisions(sim, b, seen, t) {
  const br = b.brain;
  const c = sim.course;
  const opt = sim.polar.optimal(b.tws, b.level);
  if (b.ctl.mode !== 'close' && b.ctl.mode !== 'manual') { b.ctl.mode = 'close'; b.ctl.side = side(b.rel); }
  if (b.ctl.mode === 'manual' && b.twa < 75 && !br.goingAround) { b.ctl.mode = 'close'; b.ctl.side = side(b.rel); }
  const s = b.ctl.mode === 'close' ? b.ctl.side : side(b.rel);
  // Helm wobble (worse sailors pinch/foot more).
  const phi = Math.exp(-1 / 20);
  br.helmNoise = br.helmNoise * phi + (0.6 + 2 * (1 - br.iq)) * Math.sqrt(1 - phi * phi) * sim.rng.gauss();
  if (!br.footUntil) b.ctl.offset = br.helmNoise;

  if (br.forceTackAt !== null && t >= br.forceTackAt) {
    br.forceTackAt = null;
    if (startTack(b, t)) return;
  }

  const [mx, my] = c.mark;
  const [rx, ry] = unit(c.axis + 90), [ux, uy] = unit(c.axis);
  const up = upwind(b.x, b.y, c.axis) - upwind(mx, my, c.axis);
  const off = cross(b.x, b.y, c.axis) - cross(mx, my, c.axis);
  const distMark = Math.hypot(mx - b.x, my - b.y);

  br.intent = null;
  // 0. In the rounding box (just below the mark, mark on my left): sail up
  //    through it, shooting head-to-wind for the last metres if needed.
  if (up > -15 && up < 0 && off > 0.5 && off < 15 && !b.wrongSide) {
    const slide = Math.tan(opt.upTwa * D2R) * -up;                // how far left close-hauled starboard drifts
    if (s > 0 || off - slide > 0.5) { b.ctl.mode = 'close'; b.ctl.side = s; b.ctl.offset = 0; return; }
    b.ctl.mode = 'manual'; b.ctl.hdg = norm360(seen - 8); br.intent = b.ctl.hdg;   // shoot the mark
    return;
  }
  // 1a. Overstood to the right: reach in and round over the top of the mark.
  if (b.overstoodRight && !b.wrongSide) {
    steerToPoint(sim, b, [mx + ux * 3 - rx * 2, my + uy * 3 - ry * 2], 0);
    return;
  }
  // 1. Passed it on the wrong side (or otherwise above it): come back down
  //    to just below-right of it, then up through the rounding gate.
  if (up > -1.5 || br.goingAround) {
    br.goingAround = true;
    if (up < -5 && off > 1 && off < 14) br.goingAround = false;
    else {
      const tgt = [mx + rx * 8 - ux * 8, my + ry * 8 - uy * 8];
      steerToPoint(sim, b, tgt, 0);
      return;
    }
  }
  // 2. Fetching on this tack (from any distance): lay the gate point just
  //    right of the mark, bearing away if overstood.
  const g = [mx + rx * 6 + ux * 2, my + ry * 6 + uy * 2];      // real boats pass a median 5 m right of it
  const aimG = bearing(g[0] - b.x, g[1] - b.y);
  const rG = wrap(aimG - seen);
  const fetchThis = Math.sign(rG) === s && Math.abs(rG) >= opt.upTwa - 0.5;
  if (fetchThis) { b.ctl.mode = 'manual'; b.ctl.hdg = aimG; br.intent = aimG; return; }
  if (b.ctl.mode === 'manual') { b.ctl.mode = 'close'; b.ctl.side = s; }
  if (distMark < 90) {
    const fetchOther = Math.sign(rG) !== s && Math.abs(rG) >= opt.upTwa + br.overstand * 0.5;
    if (fetchOther && t - b.lastTack > 8 && safeToTack(sim, b, distMark < 30 ? 4 : 5.5)) { startTack(b, t); return; }
    if (distMark < 45) return;                      // no voluntary tacks in the last stretch
  }

  if (t < br.noTackUntil) return;
  if (t - b.lastTack < 12) return;

  const toMark = bearing(mx - b.x, my - b.y);
  const otherHdg = norm360(seen - s * opt.upTwa);       // close-hauled heading on the other tack
  // Layline: the other tack now fetches the mark (plus this bot's overstand).
  const offL = wrap(toMark - otherHdg);
  const onLay = s > 0 ? offL <= -br.overstand : offL >= br.overstand;
  const wayPast = s > 0 ? offL <= -br.overstand - 10 : offL >= br.overstand + 10;
  if (onLay && safeToTack(sim, b, wayPast ? 4 : 5.5)) { startTack(b, t); return; }
  if (onLay && wayPast) { b.ctl.trim = 0.6; return; }     // pinned: slow and let traffic clear, then tack
  if (br.laylineOnly) return;

  // Voluntary tacks only when the other tack still heads up the course,
  // and only if the tack itself is clear (checked last: it's the costly bit).
  if (Math.abs(wrap(toMark - otherHdg)) > 75) return;
  const headed = s > 0 ? wrap(seen - br.med) : wrap(br.med - seen);
  const committed = b.startT !== null && t < b.startT + br.commitS;
  const cr = cross(b.x, b.y, c.axis);
  const goingOut = (s > 0 && cr > 0) || (s < 0 && cr < 0);     // port tack heads right, starboard left
  const want = (!committed && headed > br.headerThr)
    || (br.badAir > 0.03 && sim.rng.next() < (0.04 + 0.1 * br.iq))
    || (goingOut && Math.abs(cr) > 0.45 * sim.preset.beat)                       // edge of the course
    || (goingOut && Math.abs(cr - sim.fleetCross) > 0.3 * sim.preset.beat && sim.rng.next() < 0.02);  // rejoin the fleet
  if (want && safeToTack(sim, b)) startTack(b, t);
}

function clearOfOthers(sim, b, r) {
  for (const o of sim.boats) {
    if (o === b || o.done || o.hidden) continue;
    if (Math.abs(o.x - b.x) < r && Math.abs(o.y - b.y) < r && Math.hypot(o.x - b.x, o.y - b.y) < r) return false;
  }
  return true;
}

// Can I tack without fouling anyone? Sail the tack forward 10 s (turning
// through the wind, slowed) against everyone within 40 m holding course.
function safeToTack(sim, b, room = 5.5) {
  const near = sim.boats.filter(o => o !== b && !o.done && !o.hidden &&
    Math.abs(o.x - b.x) < 40 && Math.abs(o.y - b.y) < 40);
  if (!near.length) return true;
  const opt = sim.polar.optimal(b.tws, b.level);
  const other = norm360(b.twd - side(b.rel) * opt.upTwa);
  return predictMin(sim, b, other, 0.7, near) >= room;
}

// Would tacking onto port put this boat straight into a starboarder?
function portIntoStarboard(sim, b) {
  if (b.rel >= 0) return false;
  const opt = sim.polar.optimal(b.tws, b.level);
  const [px, py] = unit(norm360(b.twd + opt.upTwa));       // the port-tack heading
  for (const o of sim.boats) {
    if (o === b || o.done || o.hidden || o.rel >= 0) continue;
    const dx = o.x - b.x, dy = o.y - b.y;
    if (Math.abs(dx) > 30 || Math.abs(dy) > 30) continue;
    if (Math.hypot(dx, dy) < 30 && dx * px + dy * py > -5) return true;
  }
  return false;
}

// ------------------------------------------------------------------ right of way
// A boat that must keep clear looks 10 s ahead and picks the cheapest change
// from what it was doing (bear away 0-80 deg, head up a little, slow, stop)
// that keeps 4.5 m from EVERY boat nearby, re-deciding every step. A
// right-of-way boat holds its course and only slows if contact is imminent
// (rules 14/16). Parked boats stay parked: stopping costs nothing pre-start.
function avoid(sim, b, t) {
  const br = b.brain;
  let threat = null, row = false;
  const near = [];
  for (const o of sim.boats) {
    if (o === b || o.done || o.hidden) continue;
    const dx = o.x - b.x, dy = o.y - b.y;
    if (dx > 50 || dx < -50 || dy > 50 || dy < -50) continue;
    near.push(o);
    const ca = closestApproach(b, o, 12);
    const sameTack = (b.rel >= 0) === (o.rel >= 0);
    if (ca.d > (sameTack ? 6 : 8)) continue;
    if (giveWay(b, o) === b) { if (!threat || ca.t < threat.ca.t) threat = { o, ca }; }
    else if (ca.t < 2 && ca.d < 3) row = true;
  }
  if (!threat && !row) return false;
  if (b.ctl.mode === 'tack' || b.ctl.mode === 'gybe' || b.ctl.mode === 'penalty' || b.ctl.mode === 'bearaway') return true;
  if (!threat) {                                        // right of way, contact imminent: slow, hold course
    b.ctl.trim = Math.min(b.ctl.trim ?? 1, 0.3);
    br.evadeMode = 'slow'; br.evadeUntil = t + 0.5;
    return true;
  }
  const opt = sim.polar.optimal(b.tws, b.level);
  const sgn = b.rel >= 0 ? 1 : -1;                      // bearing away = +sgn
  const pre = sim.t < 0;
  const baseHdg = br.intent != null && !pre ? br.intent
                : b.twa < 75 && !pre ? norm360(b.twd + sgn * opt.upTwa)
                : (b.ctl.mode === 'manual' ? b.ctl.hdg : b.hdg);
  // Baseline = what the bot means to do (e.g. trim on for the start), not
  // whatever the last dodge left it doing.
  const baseTrim = pre ? (br.intentTrim ?? (b.ctl.stop ? 0 : (b.ctl.trim ?? 1))) : 1;
  let best = null;
  const oppTack = (b.rel >= 0) !== (threat.o.rel >= 0);
  const nearMark = Math.hypot(sim.course.mark[0] - b.x, sim.course.mark[1] - b.y) < 30;
  const dhs = oppTack || nearMark ? [0, 8, 15, 25, 35, 50] : [0, 8, 15, 25, 35, -4, -8];
  // Cheapest change first; the first one that keeps 5.5 m of room wins.
  const cands = [];
  for (const dh of dhs) for (const trim of [baseTrim, 0.6, 0.3, 0]) {
    cands.push({ dh, trim, cost: 0.04 * Math.abs(dh) + (pre ? 0.4 : 1.5) * Math.abs(trim - baseTrim) });
  }
  cands.sort((a, b) => a.cost - b.cost);
  for (const cd of cands) {
    let hdg = norm360(baseHdg + sgn * cd.dh);
    const r = wrap(hdg - b.twd);
    if (Math.abs(r) < 32) hdg = norm360(b.twd + (r >= 0 ? 32 : -32));
    cd.hdg = hdg;
    const minD = predictMin(sim, b, hdg, cd.trim, near, 5.5);
    if (minD >= 5.5) { best = { hdg, trim: cd.trim, score: 10 - cd.cost }; break; }
  }
  if (!best) {
    // Nothing keeps full room: take the option that keeps the most.
    for (const cd of cands) {
      const score = predictMin(sim, b, cd.hdg, cd.trim, near) - cd.cost - 5;
      if (!best || score > best.score) best = { score, hdg: cd.hdg, trim: cd.trim };
    }
  }
  br.lastPlan = { t, minD: 10 - best.score, score: best.score, threat: threat.o.sail, cpa: threat.ca.d, tcpa: threat.ca.t };
  b.ctl.mode = 'manual';
  b.ctl.hdg = best.hdg;
  b.ctl.stop = best.trim < 0.05;
  b.ctl.trim = Math.max(best.trim, 0.05);
  b.ctl.eased = false;
  br.evadeMode = 'keepclear';
  br.evadeFrom = threat.o.id;
  br.evadeUntil = t + 0.5;
  return true;
}

// Smallest distance to any nearby boat over the next 10 s if this boat
// steers `hdg` at sheet setting `trim` and everyone else holds course.
// With `stopBelow`, returns early once any boat comes closer than that.
export function predictMin(sim, b, hdg, trim, near, stopBelow = 0) {
  let x = b.x, y = b.y, h = b.hdg, v = b.v, minD = Infinity;
  const os = near.map(o => { const [ux, uy] = unit(o.hdg); return [o.x, o.y, ux * o.v, uy * o.v]; });
  const dt = 0.5;
  for (let k = 1; k <= 20; k++) {
    const turn = clamp(wrap(hdg - h), -PHYS.steerRate * dt, PHYS.steerRate * dt);
    h = norm360(h + turn);
    const vt = sim.polar.speed(b.tws, Math.abs(wrap(h - b.twd)), b.level) * KN * (trim < 0.05 ? 0.02 : trim);
    v += (vt - v) * (1 - Math.exp(-dt / (vt > v ? PHYS.tauAcc : PHYS.tauLuff)));
    const hr = h * D2R;
    x += Math.sin(hr) * v * dt; y += Math.cos(hr) * v * dt;
    const tk = k * dt;
    for (const o of os) {
      const dx = o[0] + o[2] * tk - x, dy = o[1] + o[3] * tk - y;
      if (dx > minD || -dx > minD || dy > minD || -dy > minD) continue;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minD) { minD = d; if (d < stopBelow) return d; }
    }
  }
  return minD;
}

function sameTackOf(a, b) { return (a.rel >= 0) === (b.rel >= 0); }

export { clamp };
