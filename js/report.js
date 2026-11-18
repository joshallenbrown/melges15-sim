// Race report: where a boat gained and lost on the first beat, in metres,
// with the same measurements for a sim race and a real RaceSense race. This
// is the bridge back to the water: run your real race through it, then
// drill the biggest loss in the sim.
//
//   start      metres vs the fleet median 60 s after the gun
//   shifts     net metres from sailing lifted/headed (vs the last 5 min mean
//              wind): v * sin(TWA) * shift, summed
//   bad air    metres lost to other boats' wind (calibrated shadow model)
//   tacks      ~2.5 m each beyond the fleet's typical count
//   laylines   overstanding on the final approach
//   penalties  ~30 s of upwind sailing each

import { wrap, norm360, unit, upwind, cross, circMean, KN, BOAT_LEN, D2R } from './geo.js';
import { computeShadows } from './shadow.js';
import { lineSide, lineFrac } from './course.js';

const TACK_M = 2.5;            // WCC median tack loss 2.2 m (2.7 m in 7-9 kn)

// ---------------------------------------------------------------- inputs
// Common track format: per boat, 1 Hz arrays from t0 (seconds from the gun).
//   { sail, isMe, t0, x[], y[], h[], v[] (m/s), loss?[] , twd?[] }

export function tracksFromSim(sim) {
  const H = sim.history;
  const boats = sim.boats.map((b, i) => ({
    sail: b.isUser ? 'YOU' : b.sail, isMe: b.isUser, isGhost: b.isGhost, ownGhost: b.id === 1000,
    t0: H[0].t, x: H.map(h => h.row[i * 8]), y: H.map(h => h.row[i * 8 + 1]),
    h: H.map(h => h.row[i * 8 + 2]), v: H.map(h => h.row[i * 8 + 3]),
    loss: H.map(h => h.row[i * 8 + 4]), twd: H.map(h => h.row[i * 8 + 5]),
    rounded: b.rounded,
  })).filter(b => !b.ownGhost);
  const base = new Map(H.map(h => [h.t, h.base]));
  const u = sim.user;
  return {
    boats, course: sim.course, polar: sim.polar, level: u.level, tws: sim.wind.p.tws,
    baseTwd: (t) => base.get(Math.round(t)) ?? sim.wind.baseDir(t),
    roundT: u.rounded, penalties: u.penalties, bowOffset: 2.3, source: 'sim',
    roundRank: u.roundRank, nBoats: sim.boats.filter(b => !b.isGhost).length,
    leaderT: (() => { const r = sim.boats.filter(b => !(b.isGhost && b.id === 1000)).map(b => b.realRound ?? b.rounded).filter(v => v != null);
                      return r.length ? Math.min(...r) : null; })(),
  };
}

export function tracksFromReplay(replay, sail) {
  const boats = replay.boats.map(b => ({
    sail: b.sail, isMe: b.sail === sail, t0: b.tr.t0,
    x: b.tr.x, y: b.tr.y, h: b.tr.h, v: b.tr.s.map(s => s === null ? null : s * KN),
    rounded: replay.roundT[b.sail],
  }));
  return {
    boats, course: replay.course, polar: replay.polar, level: replay.levelFor(sail), tws: replay.d.twsModelKn,
    baseTwd: (t) => replay.twdAt(t), roundT: replay.roundT[sail], penalties: 0, bowOffset: 1.9, source: 'real',
    place: replay.place[sail], nBoats: replay.boats.length, race: replay.d.race,
  };
}

// ---------------------------------------------------------------- helpers
function idx(b, t) {
  const i = Math.round(t - b.t0);
  if (i < 0 || i >= b.x.length) return -1;
  const x = b.x[i];
  return x === null || Number.isNaN(x) || b.h[i] === null ? -1 : i;
}
const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ---------------------------------------------------------------- analysis
export function analyze(T) {
  const c = T.course;
  const me = T.boats.find(b => b.isMe);
  const others = T.boats.filter(b => !b.isMe);
  const mUp = upwind(c.mark[0], c.mark[1], c.axis);
  const theta = T.polar.optimal(T.tws, T.level).upTwa;

  // End of the beat: the recorded rounding, else the furthest point upwind
  // before the boat first runs downwind.
  let tEnd = T.roundT;
  if (tEnd == null) {
    let best = -Infinity, runAt = null, win = [];
    for (let t = 90; t < 2400; t++) {
      const i = idx(me, t);
      const dn = i >= 0 && Math.abs(wrap(me.h[i] - T.baseTwd(t))) > 110 ? 1 : 0;
      win.push(dn); if (win.length > 25) win.shift();
      if (win.reduce((a, v) => a + v, 0) >= 20) { runAt = t - 25; break; }
    }
    for (let t = 30; t <= (runAt ?? 1500); t++) {
      const i = idx(me, t); if (i < 0) continue;
      const up = upwind(me.x[i], me.y[i], c.axis);
      if (up > best) { best = up; tEnd = t; }
    }
  }
  tEnd = Math.max(60, Math.round(tEnd ?? 600));

  const twaAt = (b, i, t) => Math.abs(wrap(b.h[i] - (b.twd ? b.twd[i] : T.baseTwd(t))));

  // My typical upwind speed on this beat.
  const upV = [];
  for (let t = 30; t < tEnd; t++) {
    const i = idx(me, t); if (i < 0) continue;
    const a = twaAt(me, i, t);
    if (a > 30 && a < 55 && me.v[i] > 0.8) upV.push(me.v[i]);
  }
  const myUpV = med(upV) || T.polar.optimal(T.tws, T.level).upSpeed * KN;

  // ---- start
  const start = { dtl: null, v: null, vRatio: null, twa: null, frac: null, crossedAt: null };
  const i0 = idx(me, 0);
  if (i0 >= 0) {
    const [hx, hy] = unit(me.h[i0]);
    const bx = me.x[i0] + hx * T.bowOffset, by = me.y[i0] + hy * T.bowOffset;
    start.dtl = -lineSide(c, bx, by);
    start.v = me.v[i0] / KN;
    start.vRatio = me.v[i0] / myUpV;
    start.twa = twaAt(me, i0, 0);
    start.frac = lineFrac(c, bx, by);
    let below = start.dtl > 0;
    for (let t = 0; t < 180; t++) {
      const i = idx(me, t); if (i < 0) continue;
      const [ux, uy] = unit(me.h[i]);
      const s = lineSide(c, me.x[i] + ux * T.bowOffset, me.y[i] + uy * T.bowOffset);
      if (s <= 0) below = true; else if (below) { start.crossedAt = t; break; }
    }
  }

  // ---- gain vs the fleet: furthest-upwind-so-far, mine minus the fleet median.
  // A boat that has rounded keeps "gaining" at fleet VMG, so arriving late
  // shows as metres behind rather than the median waiting at the mark.
  const vmgF = T.polar.optimal(T.tws, 0).upVmg * KN;
  const best = new Map();
  const gain = [], rank = [];
  for (let t = 0; t <= tEnd; t++) {
    const ups = [];
    let mine = null;
    for (const b of T.boats) {
      const i = idx(b, t);
      let up = best.get(b) ?? -Infinity;
      if (i >= 0 && !(b.rounded != null && t >= b.rounded)) up = Math.max(up, Math.min(mUp, upwind(b.x[i], b.y[i], c.axis)));
      if (b.rounded != null && t >= b.rounded) up = mUp + (t - b.rounded) * vmgF;
      if (up > -Infinity) best.set(b, up);
      if (!Number.isFinite(up)) continue;
      if (b.isMe) mine = up; else ups.push(up);
    }
    if (mine === null || ups.length < 2) { gain.push(null); rank.push(null); continue; }
    gain.push([t, mine - med(ups)]);
    rank.push([t, 1 + ups.filter(u => u > mine).length]);
  }
  const gainAt = (t) => { const g = gain[Math.min(t, gain.length - 1)]; return g ? g[1] : null; };

  // ---- the fleet's own shift and bad-air numbers on this beat (to compare)
  const fleetShift = [], fleetBad = [];
  for (const b of others) {
    const end = Math.min(b.rounded ?? tEnd, tEnd + 120);
    const r = beatStats(T, b, end, false);
    if (r.upS > 60) { fleetShift.push(r.shiftM / r.upS); fleetBad.push(r.badM / r.upS); }
  }
  const fleetShiftPerS = med(fleetShift), fleetBadPerS = med(fleetBad);

  // ---- per-second accounting on the beat
  let shiftM = 0, lifted = 0, headed = 0, upS = 0, badM = 0, badS = 0;
  const headers = [];          // stretches sailed headed > 4 deg
  const badStretches = [];
  let cur = null, curBad = null, prevSide = 0, sideSince = 0;
  const tacks = [];
  const shadowNeeded = !me.loss;
  for (let t = 5; t < tEnd; t++) {
    const i = idx(me, t); if (i < 0) continue;
    const local = me.twd ? me.twd[i] : T.baseTwd(t);
    const rel = wrap(me.h[i] - local);
    const twa = Math.abs(rel);
    if (twa < 70) {
      const sd = rel >= 0 ? 1 : -1;
      if (sd !== prevSide) { if (prevSide !== 0 && t - sideSince >= 8) tacks.push(t); prevSide = sd; sideSince = t; }
    }
    if (twa > 65 || me.v[i] < 0.6) { cur = closeStretch(cur, headers); curBad = closeStretch(curBad, badStretches); continue; }
    upS++;
    const past = [];
    for (let k = 0; k <= 300; k += 20) past.push(T.baseTwd(t - k));
    const ref = circMean(past);
    const dev = rel >= 0 ? wrap(ref - local) : wrap(local - ref);          // + = lifted
    shiftM += me.v[i] * Math.sin(twa * D2R) * dev * D2R;
    if (dev > 1) lifted++; else if (dev < -1) headed++;
    if (dev < -4) {
      if (!cur || cur.side !== Math.sign(rel)) { cur = closeStretch(cur, headers); cur = { from: t, to: t, side: Math.sign(rel), devs: [], m: 0 }; }
      cur.to = t; cur.devs.push(dev); cur.m += me.v[i] * Math.sin(twa * D2R) * dev * D2R;
    } else cur = closeStretch(cur, headers);
    // bad air
    let loss = me.loss ? me.loss[i] : null;
    if (shadowNeeded) loss = realShadow(T, me, t);
    const lm = me.v[i] * loss * Math.cos(twa * D2R);
    badM += lm;
    if (loss > 0.03) {
      badS++;
      if (!curBad) curBad = { from: t, to: t, m: 0 };
      curBad.to = t; curBad.m += lm;
    } else curBad = closeStretch(curBad, badStretches);
  }
  closeStretch(cur, headers); closeStretch(curBad, badStretches);
  const longHeaders = headers.filter(h => h.to - h.from >= 15).sort((a, b) => a.m - b.m);

  // ---- final approach: how far past the layline was the last tack?
  let overstand = null, lastTack = tacks.filter(t => t < tEnd - 5).pop() ?? null;
  if (lastTack !== null) {
    const i = idx(me, lastTack + 4);
    // Only judge it with continuous data from the tack to the mark (radio gaps
    // near the mark can hide the real last tack) and a tack near the mark.
    let seen = 0;
    for (let t = lastTack; t <= tEnd; t++) if (idx(me, t) >= 0) seen++;
    const cover = seen / Math.max(1, tEnd - lastTack + 1);
    const dMark = i >= 0 ? Math.hypot(c.mark[0] - me.x[i], c.mark[1] - me.y[i]) : Infinity;
    if (i >= 0 && cover > 0.85 && dMark < 300) {
      const H = me.h[i];
      const [hx2, hy2] = unit(H);
      const rx = c.mark[0] - me.x[i], ry = c.mark[1] - me.y[i];
      const lateral = rx * hy2 - ry * hx2;         // + = mark to my right
      const pass = -lateral;                        // + = mark passes on my left (port), metres
      // WCC fleet passed a median 17 m off on its final tack (top 5: 26 m, for clear air): flag beyond 30 m.
      overstand = { at: lastTack, pass, beyond: Math.max(0, pass - 30) };
    }
  }

  // ---- result
  const finish = {
    t: T.roundT ?? tEnd,
    rank: T.roundRank ?? (1 + others.filter(b => b.rounded != null && b.rounded < tEnd).length),
    behindLeader: T.leaderT != null && T.roundT != null ? T.roundT - T.leaderT : null,
  };
  const vmg = myUpV * Math.cos(theta * D2R);

  // ---- itemised gains and losses (metres; negative = lost)
  const items = [];
  const g60 = gainAt(60);
  if (start.dtl !== null && g60 !== null) items.push({
    key: 'start', title: 'Start', m: Math.min(g60, 25), at: -30,
    detail: start.dtl < 0 ? `Over the line at the gun (${(-start.dtl).toFixed(1)} m).` :
      `${start.dtl.toFixed(1)} m behind the line at ${start.v.toFixed(1)} kn (${Math.round(start.vRatio * 100)}% of your upwind speed), ` +
      `${Math.round(start.twa)}° to the wind. A minute later: ${g60 >= 0 ? '+' : ''}${g60.toFixed(0)} m vs the fleet median.`,
  });
  const shiftRel = shiftM - (Number.isFinite(fleetShiftPerS) ? fleetShiftPerS * upS : 0);
  items.push({
    key: 'shifts', title: 'Wind shifts', m: shiftRel, at: longHeaders[0] ? longHeaders[0].from - 10 : null,
    detail: `Lifted ${pct(lifted, upS)} / headed ${pct(headed, upS)} of the beat (vs the last 5 min mean wind): ${sgn(shiftM)} m from shifts, ` +
      `${sgn(shiftRel)} m vs the fleet's typical boat in the same wind.` +
      (longHeaders[0] ? ` Longest header you stayed on: ${Math.round(-mean(longHeaders[0].devs))}° for ${longHeaders[0].to - longHeaders[0].from} s from ${clock(longHeaders[0].from)} (${sgn(longHeaders[0].m)} m).` : ''),
  });
  const badRel = badM - (Number.isFinite(fleetBadPerS) ? fleetBadPerS * upS : 0);
  items.push({
    key: 'badair', title: 'Bad air', m: -badRel, at: badStretches.sort((a, b) => b.m - a.m)[0]?.from - 10,
    detail: `${pct(badS, upS)} of the beat more than 3% slow in other boats' wind; ≈${badM.toFixed(0)} m lost ` +
      `(${sgn(-badRel)} m vs the fleet's typical boat)` + (T.source === 'real' ? ', estimated from positions with the calibrated shadow model.' : '.'),
  });
  const extra = Math.max(0, tacks.length - 6);
  items.push({
    key: 'tacks', title: 'Number of tacks', m: -extra * TACK_M, at: null,
    detail: `${tacks.length} tacks (WCC fleet: median 5 on the first beat; each costs ~${TACK_M} m).`,
  });
  if (overstand) items.push({
    key: 'layline', title: 'Layline', m: -0.7 * overstand.beyond, at: overstand.at - 20,
    detail: overstand.pass < 0 ? `Your last tack (${clock(overstand.at)}) didn't fetch: you needed another tack to make the mark.`
      : overstand.beyond > 0 ? `Your last tack (${clock(overstand.at)}) overstood: the mark was ${overstand.pass.toFixed(0)} m off your bow line (WCC fleet median 17 m, top 5 26 m).`
      : `Your last tack (${clock(overstand.at)}) laid the mark well (${overstand.pass.toFixed(0)} m off your bow line; WCC fleet median 17 m).`,
  });
  if (T.penalties) items.push({ key: 'penalties', title: 'Penalties', m: -T.penalties * 30 * vmg, at: null,
    detail: `${T.penalties} two-turn penalt${T.penalties > 1 ? 'ies' : 'y'}, ~30 s of upwind sailing each.` });
  for (const it of items) Object.assign(it, ADVICE[it.key] || {});

  return { tEnd, theta, myUpV, vmg, start, gain, rank, gainAt, shiftM, lifted: lifted / Math.max(1, upS), headed: headed / Math.max(1, upS),
           badM, badPct: badS / Math.max(1, upS), tacks, longHeaders, overstand, finish, items, source: T.source };
}

// Shift and bad-air metres for any boat (lighter version of the main loop).
function beatStats(T, b, tEnd) {
  let shiftM = 0, badM = 0, upS = 0;
  for (let t = 5; t < tEnd; t += 2) {
    const i = idx(b, t); if (i < 0) continue;
    const local = b.twd ? b.twd[i] : T.baseTwd(t);
    const rel = wrap(b.h[i] - local), twa = Math.abs(rel);
    if (twa > 65 || (b.v[i] ?? 0) < 0.6) continue;
    upS += 2;
    const past = [];
    for (let k = 0; k <= 300; k += 30) past.push(T.baseTwd(t - k));
    const ref = circMean(past);
    const dev = rel >= 0 ? wrap(ref - local) : wrap(local - ref);
    shiftM += 2 * b.v[i] * Math.sin(twa * D2R) * dev * D2R;
    const loss = b.loss ? b.loss[i] : (T.source === 'real' ? realShadow(T, b, t) : 0);
    badM += 2 * b.v[i] * loss * Math.cos(twa * D2R);
  }
  return { shiftM, badM, upS };
}

function closeStretch(cur, list) { if (cur) list.push(cur); return null; }
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const pct = (a, b) => `${Math.round(100 * a / Math.max(1, b))}%`;
const sgn = (m) => `${m >= 0 ? '+' : '−'}${Math.abs(m).toFixed(0)}`;
export function clock(t) { const s = Math.round(Math.abs(t)); return `${t < 0 ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

// Estimated shadow loss for a real boat at second t from everyone's positions.
function realShadow(T, me, t) {
  const twd = T.baseTwd(t);
  const pts = [];
  let mine = null;
  for (const b of T.boats) {
    const i = idx(b, t); if (i < 0) continue;
    const rel = wrap(b.h[i] - twd);
    const o = { x: b.x[i], y: b.y[i], hdg: b.h[i], v: b.v[i] ?? 0, twd, tws: T.tws, rel, twa: Math.abs(rel), ctl: {}, loss: 0 };
    pts.push(o);
    if (b === me) mine = o;
  }
  if (!mine) return 0;
  computeShadows(pts);
  return mine.loss;
}

// What to do about each one, in the sim and on the water.
const ADVICE = {
  start: {
    sim: 'Start drill: set "Start at 1:00", Helm view, Prompts. Park one or two boat lengths below your spot, trim on when time-to-burn reaches zero and cross footing at full speed. Target: under 2 m back at over 90% speed, ten starts in a row.',
    water: 'Ping both ends on the Atlas and do three timed runs before the warning: from luffing two lengths back, how many seconds to the line at full speed? Trim on at that number. The WCC fleet was a median 1.5 m back at 3.7 kn, footing about 53° to the wind.',
  },
  shifts: {
    sim: 'Helm view with Prompts: call "lift" or "header" from the compass before every tack; tack on headers of 5° or more unless a starboard boat or the layline says no.',
    water: 'Take reference headings on both tacks before the start and write them on the deck; use the Atlas tactical screen. Ocean shifts at the WCC were ±4–8° every 6–12 min: a 5° header usually means tack.',
  },
  badair: {
    sim: 'After the start, ask every 20 s "is my air clean?". If not, tack or foot to a lane within 20 s. Coach view shows the shadow cones afterwards.',
    water: 'A boat 15–25 m directly to windward costs ~5% speed (WCC data). Look under the jib and over your shoulder; clear your air before it costs a boat length.',
  },
  tacks: {
    sim: 'Each tack costs ~2.5 m. Only tack for a shift (≥5°), a lane, or the layline.',
    water: 'Count your tacks on the first beat; aim for five or six with a reason for each.',
  },
  layline: {
    sim: 'In Helm view (no laylines drawn), call the layline when the mark is about one tacking angle (~85°) off your bow, then tack. Check the overstand in the debrief.',
    water: 'Sight across the boat at your tacking angle; tack a little short of where it feels right and lay the mark on starboard. The fleet passed a median 5 m to the right of the mark.',
  },
  penalties: {
    sim: 'Rules: port keeps clear of starboard, windward of leeward. Duck early by 5–10° rather than late.',
    water: 'Decide port/starboard crossings 5–6 lengths out: duck, cross or tack, early.',
  },
};
