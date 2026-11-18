// Monte Carlo decision grading.
//
// From a snapshot, each option (tack now, hold 30 s, ...) is sailed out to
// the windward mark against N wind futures. Every option sees the SAME N
// futures and the same bot noise (common random numbers), so the
// difference between options is the decision, not the luck of the draw.
// After the option's forced part, your boat is sailed by the bot policy at
// a good level (iq 0.8), so all options get the same follow-up skill.

import { Sim } from './sim.js';
import { Rng, hashSeed } from './rng.js';
import { initBrain, botThink } from './bots.js';
import { upwind, circMean, BOAT_LEN, KN } from './geo.js';

export const OPTIONS = [
  { key: 'tack', label: 'Tack now', tackIn: 0 },
  { key: 'tack30', label: 'Tack in 30 s', tackIn: 30, holdFor: 30 },
  { key: 'keep', label: 'Keep going (tack on your next header)', holdFor: 15 },
  { key: 'layline', label: 'Hold to the layline', laylineOnly: true },
];

function prepareUser(sim, opt, t0) {
  const u = sim.user;
  if (!u.brain) {
    initBrain(u, 0.8, new Rng(7), sim);
  }
  const br = u.brain;
  br.iq = 0.8; br.headerThr = 4; br.overstand = 1.5; br.commitS = 0; br.compassSd = 0.8;
  br.phase = sim.t >= 0 ? (u.ocs && !u.ocsCleared ? 'return' : 'race') : br.phase;
  const past = [];
  for (let k = 0; k <= 240; k += 10) past.push(sim.wind.baseDir(t0 - k));
  br.med = circMean(past);
  br.badAir = u.loss;
  br.evadeUntil = -999; br.evadeMode = null;
  br.noTackUntil = -999; br.forceTackAt = null; br.laylineOnly = false;
  if (opt.tackIn !== undefined) br.forceTackAt = t0 + opt.tackIn;
  if (opt.holdFor !== undefined) br.noTackUntil = t0 + opt.holdFor;
  if (opt.laylineOnly) br.laylineOnly = true;
  // Keep the boat's current control mode going into the rollout.
  if (u.ctl.mode === 'manual' && u.twa < 70) { u.ctl.mode = 'close'; u.ctl.side = u.rel >= 0 ? 1 : -1; }
  sim.userPolicy = (s, b, dt) => botThink(s, b, dt);
}

// Remaining time estimate if the rollout hit the horizon before rounding.
function finishEstimate(sim) {
  const u = sim.user, c = sim.course;
  let t, rank;
  if (u.rounded !== null) { t = u.rounded; rank = u.roundRank; }
  else {
    const rem = upwind(c.mark[0], c.mark[1], c.axis) - upwind(u.x, u.y, c.axis);
    const opt = sim.polar.optimal(u.tws, u.level);
    t = sim.t + Math.max(0, rem) / (opt.upVmg * KN);
    rank = sim.standings().findIndex(b => b.isUser) + 1;
  }
  if (sim.ghostTracks) {
    // Replay: rank against the real fleet's rounding times (not your own ghost).
    rank = 1 + sim.boats.filter(b => b.isGhost && b.id !== 1000 && b.realRound != null && b.realRound < t).length;
  }
  return { t, rank };
}

export function evaluate({ snap, ctx, options = OPTIONS, n = 40, horizon = 900, seed = 1, onProgress }) {
  const res = options.map(() => ({ t: [], rank: [] }));
  const maxUp = Math.max(0, ...snap.boats.filter(b => !b.isGhost).map(b => upwind(b.x, b.y, ctx.course.axis)));
  const look = ctx.wind.p.propagate ? maxUp / ctx.wind.c : 0;
  for (let i = 0; i < n; i++) {
    const wind = ctx.wind.fork(snap.t, hashSeed(seed, i, 'wind'), look);
    options.forEach((opt, k) => {
      const sim = Sim.fromSnapshot(snap, { ...ctx, wind, record: false });
      sim.rng = new Rng(hashSeed(seed, i, 'bots'));
      prepareUser(sim, opt, snap.t);
      const tEnd = snap.t + horizon;
      while (sim.user.rounded === null && sim.t < tEnd) sim.step(1);
      const f = finishEstimate(sim);
      res[k].t.push(f.t); res[k].rank.push(f.rank);
    });
    if (onProgress) onProgress((i + 1) / n);
  }
  return summarize(res, options, ctx, snap);
}

export function summarize(res, options, ctx, snap) {
  const u = snap.boats.find(b => b.isUser);
  const vmg = ctx.polar.optimal(u.tws || ctx.preset.wind.tws, u.level).upVmg * KN;   // m/s
  const base = res[0];
  return options.map((o, k) => {
    const r = res[k];
    const d = r.t.map((v, i) => v - base.t[i]);          // + = slower than option 0
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const sorted = [...d].sort((a, b) => a - b);
    return {
      key: o.key, label: o.label, n: r.t.length,
      meanT: mean(r.t), meanRank: mean(r.rank),
      bestRankShare: 0,
      dT: mean(d), dT10: sorted[Math.floor(0.1 * (sorted.length - 1))], dT90: sorted[Math.ceil(0.9 * (sorted.length - 1))],
      dBL: mean(d) * vmg / BOAT_LEN, blPerS: vmg / BOAT_LEN,
      pBetter: d.filter(v => v < -0.5).length / d.length,
      pWorse: d.filter(v => v > 0.5).length / d.length,
      times: r.t, ranks: r.rank,
    };
  }).map((s, k, all) => {
    // Share of futures where this option is the fastest of all options.
    let wins = 0;
    for (let i = 0; i < s.n; i++) {
      const best = Math.min(...all.map(a => a.times[i]));
      if (s.times[i] <= best + 0.5) wins++;
    }
    s.bestRankShare = wins / s.n;
    return s;
  });
}
