// Patterns across your saved races (sim and take-overs). Every finding says
// how many races or decisions it rests on, and is only stated when there
// are enough of them; small samples are flagged rather than over-read.
//
// Input: race records as saved by main.js (buildRecord). Finished races feed
// results, the metre breakdown, tack counts, clear air and laylines; every
// race (finished or not) feeds starts, tack decisions and missed shifts.

const MIN_RACES = 3, MIN_TACKS = 6;
const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
const f1 = (v) => Number.isFinite(v) ? v.toFixed(1) : '—';

export function findPatterns(races, bench = null) {
  const when = (r) => r.startedAt ?? r.savedAt ?? 0;
  const A = races.filter(r => r && r.version >= 1).sort((a, b) => when(a) - when(b));
  const R = A.filter(r => r.finished !== false && r.result && r.result.rank != null);
  const out = { n: R.length, findings: [], focus: null, table: A, finished: R };
  if (!A.length) return out;
  const add = (title, text, n, kind = 'info', weight = 0) => out.findings.push({ title, text, n, kind, weight });

  // ---- results and trend
  const pctile = R.map(r => r.result.rank && r.result.nBoats ? (r.result.rank - 1) / Math.max(1, r.result.nBoats - 1) : NaN);
  if (R.length >= MIN_RACES) {
    const half = Math.floor(R.length / 2);
    const early = med(pctile.slice(0, half)), late = med(pctile.slice(half));
    const better = late < early - 0.05, worse = late > early + 0.05;
    add('Results', `Median finish at the windward mark: top ${Math.round(100 * med(pctile))}% of the fleet over ${R.length} races` +
      (half >= 2 ? `; ${better ? 'improving' : worse ? 'slipping' : 'steady'} (first half top ${Math.round(100 * early)}%, recent top ${Math.round(100 * late)}%).` : '.'),
      R.length, better ? 'good' : worse ? 'bad' : 'info');
  }

  // ---- where the metres go, summed over all races
  const lost = {};
  const titles = {};
  for (const r of R) for (const [k, m] of Object.entries(r.items || {})) {
    if (m < 0) lost[k] = (lost[k] || 0) - m;
    titles[k] = r.itemTitles?.[k] || k;
  }
  const ranked = Object.entries(lost).sort((a, b) => b[1] - a[1]);
  if (ranked.length && R.length >= MIN_RACES) {
    const [k, m] = ranked[0];
    const per = m / R.length;
    out.focus = { key: k, title: titles[k], perRace: per };
    add('Your biggest recurring loss', `${titles[k]}: ${per.toFixed(0)} m per race on average (${m.toFixed(0)} m over ${R.length} races). ` +
      (ranked[1] ? `Next: ${titles[ranked[1][0]]} (${(ranked[1][1] / R.length).toFixed(0)} m/race).` : ''), R.length, 'bad', 10);
  }

  // ---- starts
  const st = A.map(r => r.start).filter(s => s && Number.isFinite(s.dtl));
  if (st.length >= MIN_RACES) {
    const ocs = st.filter(s => s.dtl < 0).length;
    const late = st.filter(s => s.dtl > 4).length;
    const ratio = med(st.map(s => s.vRatio));
    const top = bench?.top5;
    add('Starts', `Median ${f1(med(st.map(s => s.dtl)))} m behind the line at ${Math.round(100 * ratio)}% of your upwind speed; ` +
      `late (more than 4 m back) in ${late} of ${st.length}, over in ${ocs}. ` +
      (top ? `WCC top 5: ${top.dtl.toFixed(1)} m at ${Math.round(100 * top.gunRatio)}%.` : ''), st.length,
      late / st.length > 0.4 || ocs / st.length > 0.3 ? 'bad' : 'info', late);
    const biased = st.filter(s => Number.isFinite(s.bias) && Math.abs(s.bias) >= 5);
    if (biased.length >= MIN_RACES) {
      const fav = biased.filter(s => s.favouredEnd).length;
      add('Line choice', `When one end was favoured by 5 m or more, you started in the favoured third ${fav} of ${biased.length} times.`,
        biased.length, fav / biased.length < 0.4 ? 'bad' : 'good');
    }
    const g60 = A.map(r => r.gain60).filter(Number.isFinite);
    if (g60.length >= MIN_RACES) add('First minute', `A minute after the gun you were a median ${g60.length ? (med(g60) >= 0 ? '+' : '') + med(g60).toFixed(0) : '—'} m vs the fleet` +
      (bench ? ` (WCC top 5 +${bench.top5.gain60.toFixed(0)} m, bottom 5 ${bench.bottom5.gain60.toFixed(0)} m).` : '.'), g60.length, med(g60) < -5 ? 'bad' : 'info');
  }

  // ---- tack decisions, graded against wind futures
  const tacks = A.flatMap(r => (r.tacks || []).filter(t => t.verdict).map(t => ({ ...t, race: when(r) })));
  if (tacks.length >= MIN_TACKS) {
    const good = (a) => a.filter(t => t.verdict === 'good').length;
    add('Tack decisions', `${pct(good(tacks), tacks.length)}% of your ${tacks.length} graded tacks were the best option (or within a second of it); ` +
      `the rest cost a median ${f1(med(tacks.filter(t => t.verdict !== 'good').map(t => t.lostBL)))} boat lengths each.`, tacks.length,
      good(tacks) / tacks.length < 0.5 ? 'bad' : 'good', tacks.length - good(tacks));
    const groups = [
      ['on a header of 5° or more', tacks.filter(t => Number.isFinite(t.dev) && t.dev <= -5)],
      ['with no real shift (within ±3°)', tacks.filter(t => Number.isFinite(t.dev) && Math.abs(t.dev) < 3)],
      ['while lifted', tacks.filter(t => Number.isFinite(t.dev) && t.dev >= 3)],
      ['in bad air (>3% slow)', tacks.filter(t => (t.loss ?? 0) > 0.03)],
      ['in the first 2 minutes', tacks.filter(t => t.t < 120)],
      ['within 150 m of the mark', tacks.filter(t => (t.distMark ?? 1e9) < 150)],
    ];
    const lines = groups.filter(([, a]) => a.length >= 3).map(([lab, a]) => `${lab}: ${pct(good(a), a.length)}% good (n=${a.length})`);
    if (lines.length) {
      const worst = groups.filter(([, a]) => a.length >= 3).map(([lab, a]) => ({ lab, r: good(a) / a.length, n: a.length })).sort((x, y) => x.r - y.r)[0];
      add('When your tacks work', lines.join(' · ') + (worst && worst.r < 0.45 ? `. Weakest: tacks ${worst.lab}.` : '.'), tacks.length,
        worst && worst.r < 0.45 ? 'bad' : 'info', worst ? (1 - worst.r) * worst.n : 0);
    }
  } else if (tacks.length) {
    add('Tack decisions', `${tacks.length} graded tack${tacks.length > 1 ? 's' : ''} so far; patterns need at least ${MIN_TACKS}.`, tacks.length);
  }

  // ---- missed shifts
  const missed = A.flatMap(r => (r.missed || []).filter(m => m.verdict === 'bad'));
  if (A.length >= MIN_RACES) {
    add('Missed shifts', missed.length ? `${missed.length} missed shift${missed.length > 1 ? 's' : ''} in ${A.length} races (stayed on a 6°+ header for 25 s+ when tacking would have gained), ` +
      `about ${f1(med(missed.map(m => m.gainBL)))} BL each.` : `None flagged in ${A.length} races.`, A.length, missed.length / A.length > 0.5 ? 'bad' : 'good', missed.length);
  }

  // ---- habits
  const nt = R.map(r => r.nTacks).filter(Number.isFinite);
  if (nt.length >= MIN_RACES) add('Tack count', `Median ${med(nt)} tacks on the first beat (WCC fleet: 5; each ~2.5 m).`, nt.length, med(nt) > 7 ? 'bad' : 'info');
  const ba = R.map(r => r.badAirPct).filter(Number.isFinite);
  if (ba.length >= MIN_RACES) add('Clear air', `More than 3% slow in other boats' wind for a median ${Math.round(100 * med(ba))}% of the beat` +
    (bench ? ` (WCC fleet ~${Math.round(100 * bench.fleet.badPct)}%).` : '.'), ba.length, med(ba) > 0.15 ? 'bad' : 'info');
  const ov = R.map(r => r.overstandPass).filter(Number.isFinite);
  if (ov.length >= MIN_RACES) add('Laylines', `On your final tack the mark was a median ${med(ov).toFixed(0)} m off your bow line (WCC fleet 17 m, top 5 26 m); ` +
    `overstood by more than 30 m in ${ov.filter(v => v > 30).length} of ${ov.length}.`, ov.length, ov.filter(v => v > 30).length / ov.length > 0.4 ? 'bad' : 'info');

  // ---- how much you lean on the overhead (races sailed with the helm-only rule)
  const pk = A.filter(r => Number.isFinite(r.peeks) && r.sailedS > 60);
  if (pk.length >= MIN_RACES) {
    const perMin = pk.map(r => r.peeks / (r.sailedS / 60));
    const share = pk.map(r => r.viewShare?.sailor ?? 0);
    add('Overhead peeks', `A median ${f1(med(pk.map(r => r.peeks)))} peeks per race (${f1(med(perMin))} a minute), ` +
      `${Math.round(100 * med(share))}% of the time. On the water you get none: aim to call shifts, lanes and laylines from the helm first and peek only to check.`,
      pk.length, med(share) > 0.25 ? 'bad' : 'info');
  }

  if (R.length < MIN_RACES) add('Need more races', `${R.length} finished race${R.length === 1 ? '' : 's'} saved` +
    (A.length > R.length ? ` (plus ${A.length - R.length} unfinished)` : '') + `. Results patterns start at ${MIN_RACES} finished races; they get trustworthy around 10.`, R.length);
  out.findings.sort((a, b) => (b.kind === 'bad') - (a.kind === 'bad') || b.weight - a.weight);
  return out;
}
