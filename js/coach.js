// In-race coaching cues. Three levels:
//   coach    says what is happening and what to consider, with numbers
//   prompt   asks the question you should be asking yourself ("lift or header?")
//   off      silent (decisions are still graded for the debrief)
//
// Decision feedback: every tack you make is sailed out against wind futures
// in the background and the verdict appears a few seconds later; staying on
// a big header triggers the same check ("missed shift?").

import { wrap, norm360, unit, bearing, upwind, cross, circMean, KN, BOAT_LEN } from './geo.js';
import { lineSide, lineBias } from './course.js';
import { bowPos } from './boat.js';
import { timeToLine } from './bots.js';
import { giveWay, closestApproach } from './rules.js';
import { shadowSources } from './shadow.js';
import { OPTIONS } from './mc.js';

// Header/lift on the current tack from your own heading history, the way a
// tactical compass works: median heading on this tack over the last 6 min
// (or the other tack's median plus the tacking angle).
export function compassState(sim, polar) {
  const u = sim.user;
  const idx = sim.boats.indexOf(u);
  const hist = sim.history || [];
  const port = [], stbd = [];
  for (let k = hist.length - 1; k >= 0 && hist[k].t > sim.t - 360; k--) {
    if (hist[k].t < 15) break;                        // after the start only (pre-start headings aren't a baseline)
    const r = hist[k].row;
    const hdg = r[idx * 8 + 2], twd = r[idx * 8 + 5];
    const rel = wrap(hdg - twd);
    if (Math.abs(rel) > 32 && Math.abs(rel) < 52 && r[idx * 8 + 7] === 0) (rel > 0 ? port : stbd).push(hdg);
  }
  const opt = polar.optimal(u.tws, u.level);
  const side = u.rel >= 0 ? 1 : -1;
  const mine = side > 0 ? port : stbd, other = side > 0 ? stbd : port;
  let med = null, how = '';
  if (mine.length >= 20) { med = circMean(mine); how = 'median of your last 6 min on this tack'; }
  else if (other.length >= 20) { med = norm360(circMean(other) + side * 2 * opt.upTwa); how = 'from your other tack + tacking angle'; }
  if (med === null || u.twa > 75) return { side, med: null, dev: null, how };
  const dev = side > 0 ? wrap(med - u.hdg) : wrap(u.hdg - med);     // + = lifted
  return { side, med, dev, how };
}

export class Coach {
  constructor({ polar, level = 'coach', onCue, runMC }) {
    this.polar = polar; this.level = level; this.onCue = onCue; this.runMC = runMC;
    this.reset();
  }

  reset() {
    this.last = {};               // cue key -> sim time last shown
    this.headSince = null; this.badSince = null; this.biasSaid = null;
    this.gunSaid = false; this.markSaid = false; this.nDecisions = 0;
    this.verdicts = [];           // {t, kind:'tack'|'missed', res, verdict, text}
    this.lastMissedCheck = -1e9;
    this.lastT = -1e9;
    this.firstT = undefined;
    this.lastAny = -1e9;
  }

  // Show a cue. `prompt` is the self-coaching question for "prompt" level.
  cue(sim, key, kind, text, prompt = null, cooldown = 20, always = false) {
    const t = sim.t;
    if (!always && t - (this.last[key] ?? -1e9) < cooldown) return;
    // At most one coaching cue every ~8 s (warnings may cut in after 4 s); verdicts always show.
    if (!always) {
      const gap = t - (this.lastAny ?? -1e9);
      if (gap < (kind === 'bad' || kind === 'warn' ? 4 : 8)) return;
      this.lastAny = t;
    }
    this.last[key] = t;
    const cue = { t, key, kind, text, prompt };
    if (this.level === 'off' && !always) return;
    if (this.level === 'prompt' && !prompt && !always) return;
    this.onCue?.(cue, this.level === 'prompt' && prompt ? prompt : text);
  }

  // Called from the main loop (every frame is fine; work is throttled to 2 Hz).
  tick(sim) {
    if (sim.t - this.lastT < 0.5) return;
    this.lastT = sim.t;
    const u = sim.user;
    if (!u || u.done) return;
    this._decisions(sim);
    if (sim.t < 0) return this._prestart(sim, u);
    if (!this.gunSaid) return this._gun(sim, u);
    if (u.ocs && !u.ocsCleared) return;
    this._rightOfWay(sim, u);
    this._badAir(sim, u);
    this._shifts(sim, u);
    this._layline(sim, u);
    this._leverage(sim, u);
  }

  // ---------------------------------------------------------------- start
  _prestart(sim, u) {
    const t = sim.t, c = sim.course;
    // Line bias, early and again at ~45 s if it changed.
    const bias = lineBias(c, u.twd);
    if (this.firstT === undefined) this.firstT = t;
    const due = this.biasSaid === null ? t > this.firstT + 8 : (t > -48 && this.biasSaid.t < -48 && Math.abs(bias - this.biasSaid.b) > 5);
    if (due && t < -35) {
      this.biasSaid = { t, b: bias };
      const end = bias > 0 ? 'pin' : 'committee-boat';
      this.cue(sim, 'bias' + Math.round(t), 'info',
        Math.abs(bias) < 3 ? `Line looks square (within ${Math.abs(bias).toFixed(0)} m): start where you have room and want to go.`
          : `The ${end} end is favoured by ${Math.abs(bias).toFixed(0)} m. Starting there is worth about that much; weigh it against traffic.`,
        'Which end of the line is favoured? (Head to wind, or check the line angle against your compass.)', 0);
    }
    if (t < -35) return;
    const [bx, by] = bowPos(u);
    const dtl = -lineSide(c, bx, by);
    const ttl = timeToLine(u, sim);
    const burn = -t - ttl;
    if (dtl < 0 && t > -20) this.cue(sim, 'over', 'bad', `You're over the line with ${Math.round(-t)} s to go. Get back below it now.`, 'Where is the line?', 8);
    else if (burn < -2 && dtl > 4) this.cue(sim, 'late', 'warn', `Late: you need ${Math.round(-burn)} s more than you have. Trim on and foot for the line now.`, 'Time to burn?', 10);
    else if (burn > 15 && t > -25 && dtl < 15) this.cue(sim, 'early', 'warn', `Early: ${Math.round(burn)} s to burn. Luff (↓) and hold your spot; don't reach the line yet.`, 'Time to burn?', 10);
    else if (burn >= -1 && burn < 2.5 && t > -14 && (u.ctl.eased || u.v < 1.2)) this.cue(sim, 'go', 'good', 'Go: trim on and build speed now.', null, 12);
  }

  _gun(sim, u) {
    this.gunSaid = true;
    if (u.gunDtl == null) return;                   // took over after the gun: no start to report
    if (u.ocs) { this.cue(sim, 'gun', 'bad', 'Individual recall: you were over at the gun. Bear away below the line, then restart.', 'Individual recall: are you over?', 0, true); return; }
    const d = u.gunDtl, v = u.gunSpeed;
    const good = d < 2.5 && v > 3;
    this.cue(sim, 'gun', good ? 'good' : 'warn',
      `Gun: ${d.toFixed(1)} m back at ${v.toFixed(1)} kn. (WCC top 5: 0.7 m at 4.1 kn; bottom 5: 3.5 m at 3.2 kn.)`, null, 0, true);
  }

  // ---------------------------------------------------------------- beat
  _rightOfWay(sim, u) {
    let worst = null;
    for (const o of sim.boats) {
      if (o === u || o.done || o.hidden) continue;
      if (Math.abs(o.x - u.x) > 60 || Math.abs(o.y - u.y) > 60) continue;
      const ca = closestApproach(u, o, 12);
      if (ca.d > 7 || ca.t < 1) continue;
      if (!worst || ca.t < worst.ca.t) worst = { o, ca };
    }
    if (!worst) return;
    const o = worst.o;
    const mine = giveWay(u, o) === u;
    const opp = (u.rel >= 0) !== (o.rel >= 0);
    const who = o.isGhost ? `${o.sail} (ghost)` : o.sail;
    if (mine && opp) this.cue(sim, 'row' + o.id, 'warn', `${who} on starboard, ${Math.round(worst.ca.t)} s away: you're on port. Duck behind her or tack now.`, 'Who has right of way?', 20);
    else if (mine && worst.ca.d < 4) this.cue(sim, 'rowsame', 'warn', `Closing on ${who} on the same tack: you're the one who must keep clear (windward or clear astern).`, 'Who has right of way?', 40);
    else if (opp) this.cue(sim, 'row' + o.id, 'info', `You're on starboard: ${who} must keep clear. Hold your course (don't make it hard for her).`, null, 20);
  }

  _badAir(sim, u) {
    if (u.loss > 0.03 && u.twa < 75) {
      if (this.badSince === null) this.badSince = sim.t;
      if (sim.t - this.badSince > 6) {
        const src = shadowSources(u, sim.boats)[0];
        const who = src ? `${src.boat.sail}'s ${src.backwind ? 'backwind (you are on her windward hip)' : 'wind shadow'}` : 'bad air';
        this.cue(sim, 'bad', 'warn', `In ${who}: ${(u.loss * 100).toFixed(0)}% slow. Tack away or foot off to find a clear lane.`, 'Is your air clean?', 25);
      }
    } else this.badSince = null;
  }

  _shifts(sim, u) {
    const st = compassState(sim, this.polar);
    if (st.dev === null) { this.headSince = null; return; }
    if (st.dev <= -5) {
      if (this.headSince === null) this.headSince = sim.t;
      const held = sim.t - this.headSince;
      if (held > 6) this.cue(sim, 'header', 'warn', `Headed ${Math.round(-st.dev)}° on ${st.side > 0 ? 'port' : 'starboard'} (vs your median ${Math.round(st.med)}°). Tacking puts you on the lifted tack: check for traffic and the layline.`, 'Lift or header? Check your compass.', 30);
      if (held > 25 && sim.t - this.lastMissedCheck > 60 && this.runMC) this._missedShift(sim, st);
    } else {
      this.headSince = null;
      if (st.dev >= 5) this.cue(sim, 'lift', 'good', `Lifted ${Math.round(st.dev)}°: this is the tack to be on.`, null, 90);
    }
  }

  _layline(sim, u) {
    if (u.twa > 75) return;
    const c = sim.course;
    const [mx, my] = c.mark;
    const opt = this.polar.optimal(u.tws, u.level);
    const s = u.rel >= 0 ? 1 : -1;
    const d = Math.hypot(mx - u.x, my - u.y);
    if (!this.markSaid && d < 150) {
      this.markSaid = true;
      this.cue(sim, 'mark', 'info', 'Windward mark ahead: leave it to port. Set up to approach on starboard with clear air.', 'Which layline are you on?', 0);
    }
    const toMark = bearing(mx - u.x, my - u.y);
    const other = norm360(u.twd - s * opt.upTwa);
    const off = wrap(toMark - other);
    const onLay = s > 0 ? off <= 0 : off >= 0;
    const past = s > 0 ? -off : off;              // degrees beyond the layline
    if (onLay && past > 6) {
      const beyond = d * Math.sin(past * Math.PI / 180);
      this.cue(sim, 'overstand', 'bad', `Overstanding: about ${beyond.toFixed(0)} m past the layline. Tack now.`, 'Are you past the layline?', 25);
    } else if (onLay) this.cue(sim, 'layline', 'info', `On the ${s > 0 ? 'starboard' : 'port'} layline: tack now to fetch the mark.`, 'Can you fetch the mark on the other tack?', 40);
  }

  _leverage(sim, u) {
    if (sim.t < 90) return;
    const c = sim.course;
    const myC = cross(u.x, u.y, c.axis);
    const lev = myC - sim.fleetCross;
    if (Math.abs(lev) > 150) this.cue(sim, 'leverage', 'info', `You're ${Math.abs(lev).toFixed(0)} m ${lev > 0 ? 'right' : 'left'} of the fleet: a big shift will make or break you. Consider getting back toward the middle.`, null, 150);
  }

  // ---------------------------------------------------------------- decisions
  _decisions(sim) {
    const dec = sim.decisions || [];
    while (this.nDecisions < dec.length) {
      const d = dec[this.nDecisions++];
      if (!this.runMC) continue;
      const opts = [OPTIONS[0], OPTIONS[2], OPTIONS[1]];       // what you did, keep going, tack 30 s later
      this.runMC(d.snap, { options: opts, n: 16, seed: Math.round(d.t * 10) }).then(res => {
        const mine = res[0], keep = res[1];
        const best = res.reduce((a, b) => (a.meanT < b.meanT ? a : b));
        const bl = (x) => (x * mine.blPerS).toFixed(1);
        const dKeep = keep.meanT - mine.meanT;          // + = your tack was faster
        let kind, text;
        if (best === mine || mine.meanT - best.meanT < 1) {
          kind = 'good'; text = `Tack at ${clk(d.t)}: good call. Keeping going would have cost ~${bl(Math.max(0, dKeep))} BL (your tack was fastest in ${Math.round(mine.bestRankShare * 100)}% of 16 wind futures).`;
        } else if (mine.meanT - best.meanT < 3) {
          kind = 'warn'; text = `Tack at ${clk(d.t)}: close call. "${best.label}" was ~${bl(mine.meanT - best.meanT)} BL better on average.`;
        } else {
          kind = 'bad'; text = `Tack at ${clk(d.t)}: "${best.label}" was ~${bl(mine.meanT - best.meanT)} BL better (your tack was fastest in only ${Math.round(mine.bestRankShare * 100)}% of futures).`;
        }
        this.verdicts.push({ t: d.t, kind: 'tack', verdict: kind, res, text, best, mine });
        this.cue(sim, 'verdict' + d.t, kind, text, null, 0, this.level !== 'off');
      }).catch(err => console.error(err));
    }
  }

  _missedShift(sim, st) {
    this.lastMissedCheck = sim.t;
    const t = sim.t;
    const held = Math.round(t - (this.headSince ?? t));
    const snap = sim.snapshot();
    const opts = [OPTIONS[2], OPTIONS[0]];                       // keep going vs tack now
    this.runMC(snap, { options: opts, n: 16, seed: Math.round(t * 10) + 7 }).then(res => {
      const keep = res[0], tack = res[1];
      const gainBL = (keep.meanT - tack.meanT) * keep.blPerS;
      if (gainBL > 1.5 && tack.bestRankShare > 0.55) {
        const text = `Missed shift at ${clk(t)}: you'd been ${Math.round(-st.dev)}° headed for ${held} s. Tacking then would have gained ~${gainBL.toFixed(1)} BL (better in ${Math.round(tack.bestRankShare * 100)}% of futures).`;
        this.verdicts.push({ t, kind: 'missed', verdict: 'bad', res, text, dev: st.dev, gainBL, held });
        this.cue(sim, 'missed' + t, 'bad', text, null, 0, this.level !== 'off');
      } else {
        this.verdicts.push({ t, kind: 'missed', verdict: 'ok', res, dev: st.dev, gainBL, held, text: `Header at ${clk(t)}: holding was fine (tacking ${gainBL >= 0 ? 'gained' : 'lost'} ~${Math.abs(gainBL).toFixed(1)} BL on average).` });
      }
    }).catch(err => console.error(err));
  }
}

function clk(t) { const s = Math.round(Math.abs(t)); return `${t < 0 ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
