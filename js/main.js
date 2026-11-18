// App shell: loop, input, panels, race end, replay.

import { Polar } from './polar.js';
import { Sim, fmtT, ordinal } from './sim.js';
import { buildPresets, lineSide, lineBias, lineFrac } from './course.js';
import { Camera, drawScene, drawChart } from './render.js';
import { Replay } from './replay.js';
import { OPTIONS } from './mc.js';
import { timeToLine } from './bots.js';
import { bowPos } from './boat.js';
import { wrap, norm360, upwind, cross, KN, BOAT_LEN, circMean } from './geo.js';
import { drawHelm, drawHelmOverlay, panoramaRect, FOV } from './helm.js';
import { Helm3D } from './helm3d.js';
import { Coach, compassState } from './coach.js';
import { analyze, tracksFromSim, tracksFromReplay, clock } from './report.js';
import { findPatterns } from './patterns.js';

const $ = (id) => document.getElementById(id);
const cal = await (await fetch('data/calibration.json')).json();
const polar = new Polar(cal.polar);
const presets = buildPresets(cal);
const bench = await (await fetch('data/benchmarks.json')).json();
const dpr = Math.min(2, window.devicePixelRatio || 1);

const S = {
  mode: 'race', sim: null, replay: null, replayData: {}, cam: new Camera(), view: 'helm', look: 0, coach: null,
  speed: 1, paused: true, keys: {}, laylines: false, scrubT: null, overlay: null, ended: false,
  whatIf: null, worker: null, jobs: new Map(), jobId: 0, grades: [], lastUi: 0,
};

// ------------------------------------------------------------------ setup UI
for (const p of Object.values(presets)) {
  const o = document.createElement('option');
  o.value = p.key; o.textContent = p.label + (p.calibrated ? '' : ' *');
  $('preset').appendChild(o);
}
for (let r = 1; r <= 6; r++) {
  const o = document.createElement('option');
  o.value = r; o.textContent = `WCC race ${r} (${r <= 4 ? 'Sept 19' : 'Sept 20'}, real)`;
  $('replayRace').appendChild(o);
}
$('replayRace').value = '5';

const canvas = $('view'), ctx = canvas.getContext('2d');
let helm3d = null;
try { helm3d = new Helm3D($('stage')); } catch (err) { console.warn('3D view unavailable', err); }
const chart = $('chart'), cctx = chart.getContext('2d');
const comp = $('compass'), compCtx = comp.getContext('2d');
function resize() {
  for (const c of [canvas, chart]) {
    const r = c.getBoundingClientRect();
    c.width = Math.max(10, r.width * dpr); c.height = Math.max(10, r.height * dpr);
  }
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ worker
function worker() {
  if (!S.worker) {
    S.worker = new Worker('js/worker.js', { type: 'module' });
    S.worker.onmessage = (e) => {
      const job = S.jobs.get(e.data.id);
      if (!job) return;
      if (e.data.progress !== undefined) job.onProgress?.(e.data.progress);
      else { S.jobs.delete(e.data.id); e.data.error ? job.reject(e.data.error) : job.resolve(e.data.result); }
    };
  }
  return S.worker;
}
function runMC(sim, snap, opts = {}) {
  const id = ++S.jobId;
  return new Promise((resolve, reject) => {
    S.jobs.set(id, { resolve, reject, onProgress: opts.onProgress });
    worker().postMessage({
      id, cal, preset: sim.preset, course: sim.course, wind: sim.wind, snap,
      options: opts.options ?? OPTIONS, n: opts.n ?? 40, horizon: 900, seed: opts.seed ?? 1,
      ghostTracks: sim.ghostTracks,
    });
  });
}

// ------------------------------------------------------------------ races
function newRace() {
  endRace(); clearInterval(S.finishIv);
  const preset = presets[$('preset').value];
  const fleet = $('fleet').value ? Number($('fleet').value) : preset.fleet;
  S.sim = new Sim({ cal, polar, preset, seed: Number($('seed').value) || 1, userLevel: Number($('level').value),
                    startAt: Number($('startAt').value), fleetSize: fleet });
  S.mode = 'race'; S.ended = false; S.paused = true; S.scrubT = null; S.whatIf = null; S.grades = [];
  S.cam.axis = S.sim.course.axis; S.cam.follow = true; S.cam.scale = 2.2; S.look = 0;
  S.sim.onBeforeUserTack = tackContext; S.viewTime = {}; S.peek = false; setView('helm');
  newCoach();
  beginRace('race');
  $('whatIf').innerHTML = 'After the start, press <b>W</b> to grade tack-or-hold against 40 wind futures.';
  showIntro(preset);
}

// What a Race-tab race is: generated, not a replay. Same venue + race # = same wind.
const raceName = (preset, seed) => `${preset.short || preset.label} #${seed}`;
const RACE_DAY = { 1: 'Sept 19', 2: 'Sept 19', 3: 'Sept 19', 4: 'Sept 19', 5: 'Sept 20', 6: 'Sept 20' };

function showIntro(preset) {
  overlay(`
    <h2>${raceName(preset, S.sim.seed)}</h2>
    <p class="sub">${preset.note}${preset.calibrated ? '' : ' <span class="pill est">estimate</span>'}</p>
    <p><b>A generated race, not a replay.</b> ${preset.basis ? `The wind (how big and how often it shifts, how strong the puffs are,
    the wind speed) and the course follow ${preset.basis}, but the shifts themselves are new, drawn from race #${S.sim.seed}.` :
    'The wind and course are a guess at Mission Bay until a bay race is calibrated.'}
    The same venue and race # always give the same wind, so friends can sail the identical race and compare.
    To sail an actual race, use <b>Replay WCC 2026</b> and take over a boat.</p>
    <p>Start, then sail the first beat to the windward mark against ${S.sim.boats.length - 1} boats from the real WCC fleet
    (each sails at its own speed and skill from the results).</p>
    <p><b>Helm view</b> is what you'd see from the boat: no line drawn, no standings, puffs only as darker water, and
    instruments like a Vakaros (speed, heading, timer, line distance, lift/header). It's the only view while you race:
    hold <b>V</b> for a quick look at the overhead, as you'd glance around on the water (My races counts the peeks).
    After you round, the overhead and coach views open up for the debrief.
    <b>Cues</b> (top bar) coach you during the race; every tack you make is graded against wind futures within seconds.</p>
    <div class="keys">
      <kbd>Q E</kbd><span>Look left / right (or drag the view; click the 360° strip to look that way). <kbd>F</kbd> back to the bow. <kbd>M</kbd> mini-map of boats within 250 m.</span>
      <kbd>← →</kbd><span>Steer. On autopilot (close-hauled) they pinch/foot a degree at a time.</span>
      <kbd>↓</kbd><span>Hold to luff (ease sheets, slow down). Release to trim.</span>
      <kbd>Space</kbd><span>Tack (or gybe when running)</span>
      <kbd>C</kbd><span>Close-hauled autopilot: follows the shifts at the best upwind angle</span>
      <kbd>X</kbd><span>Take a penalty (two turns)</span>
      <kbd>W</kbd><span>What if? Grade tack vs hold right now (40 wind futures)</span>
      <kbd>V</kbd><span>Hold to peek at the overhead; let go to get back to the helm. After the race: helm → overhead → coach overhead (true wind, shadows, laylines)</span>
      <kbd>L</kbd><span>Laylines in the overhead</span>
      <kbd>R</kbd><span>Rewind 15 s with the same wind (branch)</span>
      <kbd>P</kbd><span>Pause · <kbd>1</kbd>–<kbd>4</kbd> speed · scroll to zoom · drag to pan · <kbd>F</kbd> follow</span>
    </div>
    <button class="primary" id="go">Start the sequence (Enter)</button>`);
  $('go').onclick = () => { closeOverlay(); S.paused = false; };
}

function overlay(html) { $('overlay').innerHTML = `<div class="card">${html}</div>`; $('overlay').classList.remove('hidden'); S.overlay = true; }
function closeOverlay() { $('overlay').classList.add('hidden'); S.overlay = null; }

// ------------------------------------------------------------------ replay
async function loadReplay(n) {
  endRace(); clearInterval(S.finishIv);
  if (!S.replayData[n]) S.replayData[n] = await (await fetch(`data/race${n}.json`)).json();
  S.replay = new Replay(S.replayData[n], cal, polar);
  const sel = $('replayBoat');
  sel.innerHTML = '';
  for (const b of S.replay.boats) {
    const o = document.createElement('option');
    o.value = b.sail; o.textContent = `${b.sail}${b.place ? `  (${ordinal(b.place)})` : ''}`;
    sel.appendChild(o);
  }
  S.replay.setTime(-30);
  S.cam.axis = S.replay.course.axis; S.cam.follow = true; S.cam.scale = 1.4;
  S.mode = 'replay'; S.sim = null; S.paused = true; S.ended = false; S.scrubT = null;
  closeOverlay();                                   // the Race tab's intro card isn't for the replay
  $('takeOver').classList.remove('hidden'); $('backToReplay').classList.add('hidden');
  const d = S.replay.d;
  $('whatIf').innerHTML = `Race ${d.race}: wind ${d.twsModelKn.toFixed(1)} kn (HRRR model), direction from the fleet's headings.
    Pick a boat, scrub to a moment, then <b>Take over from here</b>. Trackers drop out often; gaps are filled with a
    likely path, and boats drawn faded are in a gap of more than 30 s (position estimated).`;
}

function takeOver() {
  endRace(); clearInterval(S.finishIv);
  const r = S.replay;
  const sail = $('replayBoat').value;
  const t = Math.round(r.t);
  S.sim = r.takeOver(sail, t);
  S.mode = 'takeover'; S.ended = false; S.paused = true; S.scrubT = null; S.grades = []; S.look = 0;
  S.sim.onBeforeUserTack = tackContext; S.viewTime = {}; S.peek = false; setView('helm');
  newCoach();
  beginRace('takeover', { race: r.d.race, sail, t });
  $('takeOver').classList.add('hidden'); $('backToReplay').classList.remove('hidden');
  const lvl = S.sim.user.level;
  overlay(`<h2>You are ${sail}, from ${fmtT(t)}</h2>
    <p>The real fleet carries on exactly as it sailed (ghosts: they cast wind shadow but can't react). Your boat sails at
    ${sail}'s own measured upwind pace (speed level ${lvl.toFixed(2)}). The wind is the direction the fleet's headings imply,
    ${r.d.twsModelKn.toFixed(1)} kn. Your real track is the blue ghost.</p>
    <p class="sub">Goal: beat your real self to the windward mark. W grades tack-or-hold here too.</p>
    <button class="primary" id="go">Go (Enter)</button>`);
  $('go').onclick = () => { closeOverlay(); S.paused = false; };
}

// ------------------------------------------------------------------ input
const keyMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'ease', ArrowUp: 'trim', q: 'lookL', Q: 'lookL', e: 'lookR', E: 'lookR' };
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && S.overlay && $('go')) { e.preventDefault(); $('go').click(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); e.target.blur(); }
  const k = keyMap[e.key];
  if (k) { S.keys[k] = true; e.preventDefault(); return; }
  const sim = S.sim;
  switch (e.key) {
    case ' ': e.preventDefault(); if (sim && live()) sim.userTack(); else if (S.mode === 'replay') S.paused = !S.paused; break;
    case 'c': case 'C': if (sim && live()) sim.userClose(); break;
    case 'x': case 'X': if (sim && live()) sim.userPenalty(); break;
    case 'p': case 'P': case 'Escape': togglePause(); break;
    case 'v': case 'V': if (racing()) { if (!e.repeat) peek(true); } else toggleView(); break;
    case 'f': case 'F': S.cam.follow = true; S.look = 0; break;
    case 'm': case 'M': S.minimap = !S.minimap; break;
    case 'l': case 'L': S.laylines = !S.laylines; break;
    case 'w': case 'W': whatIf(); break;
    case 'r': case 'R': rewind(15); break;
    case '1': setSpeed(1); break; case '2': setSpeed(2); break; case '3': setSpeed(4); break; case '4': setSpeed(8); break;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'v' || e.key === 'V') peek(false);
  const k = keyMap[e.key];
  if (k) { S.keys[k] = false; if (k === 'ease' && S.sim && live()) S.sim.userEase(false); }
});
for (const b of document.querySelectorAll('#touch button')) {
  const k = b.dataset.k;
  b.addEventListener('pointerdown', () => {
    if (k === 'tack') S.sim?.userTack(); else if (k === 'close') S.sim?.userClose(); else S.keys[k] = true;
  });
  b.addEventListener('pointerup', () => { S.keys[k] = false; if (k === 'ease') S.sim?.userEase(false); });
}
function live() { return S.mode !== 'replay' && !S.ended && S.scrubT === null; }
// While racing (start sequence to the mark) you sail from the helm, as on the
// water. Hold V (or the view button) for a quick look at the overhead; each
// peek is counted. After the race, in review and in Replay, V cycles the views.
function racing() { return (S.mode === 'race' || S.mode === 'takeover') && !!S.sim && !S.ended && S.scrubT === null; }
function peek(on) {
  if (on && racing() && !S.peek) {
    S.peek = true; S.cam.follow = true; setView('sailor');
    if (S.cur) S.cur.peeks = (S.cur.peeks || 0) + 1;
  } else if (!on && S.peek) { S.peek = false; if (racing()) setView('helm'); }
}
function syncView() {
  const r = racing();
  if (r && !S.peek && S.view !== 'helm') setView('helm');
  if (!r) S.peek = false;
  const b = $('btnView');
  const label = r ? (S.peek ? 'Overhead (peek)' : 'Hold V: peek overhead') : VIEWS[S.view];
  if (b.textContent !== label) {
    b.textContent = label;
    b.title = r ? 'Helm view only while racing. Hold V, or press and hold here, for a quick look at the overhead.' : 'V: helm / overhead / coach overhead';
  }
  b.classList.toggle('on', !!S.peek);
}
window.addEventListener('blur', () => { peek(false); for (const k in S.keys) S.keys[k] = false; });
function togglePause() { if (S.overlay) return; S.paused = !S.paused; }
const VIEWS = { helm: 'Helm view', sailor: 'Overhead', coach: 'Coach overhead' };
function setView(v) { S.view = v; }
function toggleView() { setView(S.view === 'helm' ? 'sailor' : S.view === 'sailor' ? 'coach' : 'helm'); }
function setSpeed(v) {
  S.speed = v;
  for (const b of document.querySelectorAll('#speedBtns button')) b.classList.toggle('on', Number(b.dataset.speed) === v);
}
$('btnView').addEventListener('pointerdown', (e) => { if (racing()) { e.preventDefault(); peek(true); } });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('btnView').addEventListener(ev, () => peek(false));
$('btnView').onclick = () => { if (!racing()) toggleView(); };
$('btnFit').onclick = () => { S.cam.follow = true; S.look = 0; };
$('btnPause').onclick = togglePause;
for (const b of document.querySelectorAll('#speedBtns button')) b.onclick = () => setSpeed(Number(b.dataset.speed));
$('newRace').onclick = newRace;
$('takeOver').onclick = takeOver;
$('backToReplay').onclick = () => loadReplay(Number($('replayRace').value));
$('replayRace').onchange = () => loadReplay(Number($('replayRace').value));
for (const t of document.querySelectorAll('.tab')) {
  t.onclick = () => {
    for (const x of document.querySelectorAll('.tab')) x.classList.toggle('on', x === t);
    const m = t.dataset.mode;
    $('about').classList.toggle('hidden', m !== 'about');
    $('progress').classList.toggle('hidden', m !== 'progress');
    if (m === 'progress') renderProgress();
    $('raceSetup').classList.toggle('hidden', m !== 'race');
    $('replaySetup').classList.toggle('hidden', m !== 'replay');
    if (m === 'race' && S.mode !== 'race') newRace();
    if (m === 'replay' && S.mode === 'race') loadReplay(Number($('replayRace').value));
    if (m === 'about') renderAbout();
  };
}

// mouse: zoom + pan
let drag = null;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const f = Math.exp(-e.deltaY * 0.0015);
  S.cam.scale = Math.max(0.15, Math.min(25, S.cam.scale * f));
}, { passive: false });
const helmOn = () => S.view === 'helm' && S.sim && S.scrubT === null && S.mode !== 'replay';
canvas.addEventListener('pointerdown', (e) => {
  if (helmOn()) {
    const r = canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    const P = panoramaRect(canvas.width, canvas.height, dpr);
    if (px >= P.x0 && px <= P.x1 && py >= P.y0 && py <= P.y0 + P.h) {
      S.look = wrap((px - P.x0) / (P.x1 - P.x0) * 360 - 180);
      return;
    }
  }
  drag = { x: e.clientX, y: e.clientY, cx: S.cam.cx, cy: S.cam.cy, look: S.look };
  canvas.style.cursor = 'grabbing';
});
window.addEventListener('pointerup', () => { drag = null; canvas.style.cursor = 'grab'; });
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (helmOn()) {
    // drag the scene: drag right to turn your head left (and vice versa)
    const degPerPx = FOV / canvas.getBoundingClientRect().width;
    S.look = wrap(drag.look - (e.clientX - drag.x) * degPerPx * 1.2);
    return;
  }
  const dx = (e.clientX - drag.x) * dpr, dy = (e.clientY - drag.y) * dpr;
  if (Math.abs(dx) + Math.abs(dy) > 4) S.cam.follow = false;
  const a = S.cam.axis * Math.PI / 180;
  const xr = -dx / S.cam.scale, yr = dy / S.cam.scale;
  S.cam.cx = drag.cx + xr * Math.cos(a) + yr * Math.sin(a);
  S.cam.cy = drag.cy - xr * Math.sin(a) + yr * Math.cos(a);
});

// timeline
$('scrub').addEventListener('input', () => {
  const v = Number($('scrub').value);
  if (S.mode === 'replay') { S.replay.setTime(v); S.paused = true; return; }
  if (!S.sim?.history?.length) return;
  S.paused = true;
  const last = S.sim.history[S.sim.history.length - 1].t;
  S.scrubT = v >= last ? null : v;
});
$('branch').onclick = () => branchAt(S.scrubT ?? (S.sim ? S.sim.t : null));

function branchAt(t) {
  const sim = S.sim;
  if (!sim || t === null || !sim.snaps?.length) return;
  const snap = [...sim.snaps].reverse().find(s => s.t <= t + 0.01);
  if (!snap) return;
  sim.restore(snap);
  if (S.cur?.sim === sim) S.cur.rewinds++;
  S.scrubT = null; S.ended = false; S.paused = true; closeOverlay();
  sim.log('start', `Branched at ${fmtT(snap.t)}: same wind, your call.`, sim.user);
}
function rewind(secs) {
  if (!S.sim || S.mode === 'replay') return;
  branchAt(S.sim.t - secs);
}

// ------------------------------------------------------------------ what if
async function whatIf() {
  const sim = S.sim;
  if (!sim || S.mode === 'replay') return;
  const u = sim.user;
  if (sim.t < 0 || !u.started || u.done) { $('whatIf').textContent = 'Available after you start and before you round.'; return; }
  if (u.twa > 80) { $('whatIf').textContent = 'Get back upwind first: this grades tack vs hold on the beat.'; return; }
  S.paused = true;
  const snap = sim.snapshot();
  const t = sim.t;
  $('whatIf').innerHTML = `Sailing 4 options × 40 wind futures from ${fmtT(t)}… <div class="bar"><div id="wiBar" style="width:0%"></div></div>`;
  try {
    const res = await runMC(sim, snap, { onProgress: (p) => { const b = $('wiBar'); if (b) b.style.width = `${p * 100}%`; } });
    $('whatIf').innerHTML = mcTable(res, t);
  } catch (err) {
    $('whatIf').textContent = 'Monte Carlo failed: ' + err;
    console.error(err);
  }
}

function mcTable(res, t, did = null) {
  const best = res.reduce((a, b) => (a.meanT < b.meanT ? a : b));
  const rows = res.map(o => {
    const d = o.meanT - best.meanT;
    const blTxt = o !== best ? `(${(d * o.blPerS).toFixed(1)} BL)` : '';
    return `<span class="${o === best ? 'best' : ''}">${o.label}${did === o.key ? ' ← you' : ''}</span>
            <span>${o === best ? 'best' : `+${d.toFixed(1)} s ${blTxt}`}</span>
            <span>${Math.round(o.bestRankShare * 100)}% · #${o.meanRank.toFixed(1)}</span>`;
  }).join('');
  return `<div class="sub">From ${fmtT(t)}: average time to the mark vs the best option; share of futures where each was fastest; average rounding place.</div>
    <div class="opt" style="margin-top:6px">${rows}</div>`;
}

// ------------------------------------------------------------------ coach + cues
function newCoach() {
  $('cues').innerHTML = '';
  S.coach = new Coach({
    polar, level: $('cueLevel').value,
    onCue: (cue, text) => showCue(cue, text),
    runMC: (snap, o) => runMC(S.sim, snap, o),
  });
}
$('cueLevel').onchange = () => { if (S.coach) S.coach.level = $('cueLevel').value; $('cueLevel').blur(); };

function showCue(cue, text) {
  const box = $('cues');
  const el = document.createElement('div');
  el.className = `cue ${cue.kind}`;
  el.innerHTML = `<span class="ct">${fmtT(cue.t)}</span>${text}`;
  box.prepend(el);
  while (box.children.length > 3) box.lastChild.remove();
  const life = cue.key.startsWith('verdict') || cue.key.startsWith('missed') ? 11000 : 7000;
  setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 450); }, life);
  S.sim?.events.push({ t: cue.t, type: cue.kind === 'bad' ? 'rule' : cue.kind === 'good' ? 'mark' : 'start', text: '💬 ' + text, boat: 0 });
}

// ------------------------------------------------------------------ race end
function finishRace() {
  const sim = S.sim;
  S.ended = true; S.paused = true;
  const u = sim.user;
  const R = analyze(tracksFromSim(sim));
  const isReplay = S.mode === 'takeover';
  let head;
  if (isReplay) {
    const realMe = sim.boats.find(b => b.id === 1000);
    const realT = realMe?.realRound;
    const rank = 1 + sim.boats.filter(b => b.isGhost && b.id !== 1000 && b.realRound != null && b.realRound < u.rounded).length;
    const vs = realT != null ? (u.rounded - realT) : null;
    head = `<p class="sub">Real race: WCC 2026 race ${S.cur?.from?.race ?? ''} (${RACE_DAY[S.cur?.from?.race] ?? ''}), as ${u.realSail} from ${fmtT(S.cur?.from?.t ?? 0)}</p>
      <h2>Rounded at ${fmtT(u.rounded)}: ${ordinal(rank)} vs the real fleet</h2>
      <p>${vs === null ? '' : vs < 0 ? `<span class="good">${(-vs).toFixed(0)} s ahead of the real ${u.realSail}</span>` : `<span class="bad">${vs.toFixed(0)} s behind the real ${u.realSail}</span>`}
      (the real ${u.realSail} rounded at ${realT != null ? fmtT(realT) : 'n/a'}).</p>`;
  } else {
    const lead = Math.min(...sim.boats.filter(b => b.rounded !== null).map(b => b.rounded));
    head = `<p class="sub">${raceName(sim.preset, sim.seed)} · generated race (same race # = same wind)</p>
      <h2>You rounded ${ordinal(u.roundRank)} of ${sim.boats.length}</h2>
      <p>${u.roundRank === 1 ? 'Led at the windward mark.' : `${(u.rounded - lead).toFixed(0)} s behind the leader (≈${((u.rounded - lead) * R.vmg / BOAT_LEN).toFixed(0)} boat lengths).`}</p>`;
  }
  overlay(`${head}${reportHtml(R, 'sim')}
    <div id="verdicts"></div>
    <p class="sub" id="saveStatus">Saving to My races…</p>
    <p style="margin-top:12px"><button class="primary" id="again">Sail it again (same wind)</button>
    <button id="next">Next race</button> <button id="review">Review timeline</button></p>`);
  drawGainChart(R, (S.coach?.verdicts || []));
  renderVerdicts();
  $('again').onclick = () => newRace();
  $('next').onclick = () => { $('seed').value = Number($('seed').value) + 1; newRace(); };
  $('review').onclick = () => { closeOverlay(); S.scrubT = sim.history[0].t; setView('coach'); };
  // Save right away; persist() saves again as late tack verdicts come back.
  if (S.cur?.sim === sim) { S.cur.R = R; persist(S.cur); }
  // Verdicts for tacks made just before the finish may still be coming back.
  clearInterval(S.finishIv);
  let tries = 0;
  S.finishIv = setInterval(() => {
    if (S.sim !== sim || ++tries > 25) { clearInterval(S.finishIv); return; }
    renderVerdicts(); drawGainChart(R, S.coach?.verdicts || []);
  }, 1500);
}

// ------------------------------------------------------------------ saving
// Every race you sail gets one record, keyed by when it began. It is saved
// the moment the race ends (rounding, time limit, new race, take-over, the
// My races tab, refreshing or closing the page) and again as late tack
// verdicts come back; each save replaces the last one for that race.
// Races you leave before 20 s after the gun (and before any tack) aren't kept.
function beginRace(mode, from = null) {
  S.cur = { sim: S.sim, coach: S.coach, mode, from, viewTime: S.viewTime, startedAt: Date.now(), t0: S.sim.t,
            rewinds: 0, R: null, timer: null, sig: '', announced: false };
}
function endRace() {
  const c = S.cur;
  S.cur = null;
  if (c) persist(c);
}
const pendingVerdicts = (c) => (c.sim.decisions?.length || 0) - (c.coach?.verdicts || []).filter(v => v.kind === 'tack').length;

function recordFor(c) {
  const sim = c.sim, u = sim.user;
  const finished = u.rounded !== null && u.done;
  const sailed = c.mode === 'race' ? sim.t > 20 : sim.t - c.t0 > 20;
  if (!finished && !sailed && !(sim.decisions?.length)) return null;
  let R = finished ? c.R : null;
  if (!R) { try { R = analyze(tracksFromSim(sim)); } catch (err) { console.error('analyze', err); } }
  return buildRecord(c, R, finished);
}

// Save now (if anything changed since the last save). unloading: the page is
// going away, so send it with sendBeacon and don't wait for verdicts.
function persist(c, { unloading = false, wait = true } = {}) {
  const sig = `${c.sim.user.rounded}|${(c.coach?.verdicts || []).length}|${Math.round(c.sim.t)}|${c.rewinds}|${c.peeks || 0}`;
  if (sig === c.sig) return Promise.resolve(true);
  const rec = recordFor(c);
  if (!rec) return Promise.resolve(false);
  c.sig = sig;
  const done = saveRace(rec, unloading).then(ok => { announceSave(c, rec, ok); return ok; });
  if (wait && !unloading && !c.timer && pendingVerdicts(c) > 0) {
    let tries = 0;
    c.timer = setInterval(() => {
      const last = pendingVerdicts(c) <= 0 || ++tries > 20;
      if (last) { clearInterval(c.timer); c.timer = null; }
      persist(c, { wait: false });
    }, 1500);
  }
  return done;
}

function announceSave(c, rec, ok) {
  const status = $('saveStatus');
  if (status && S.cur === c) {
    status.innerHTML = ok ? `<span class="good">✓ Saved to My races${HOSTED ? ' (in this browser)' : ''}</span>${pendingVerdicts(c) > 0 ? ' (updating as the last tack verdicts come back)' : ''}.`
      : '<span class="warn">Saved in this browser only</span>: open the sim from <code>node server.mjs</code> to keep races on disk.';
  }
  if (c.announced && ok) return;
  c.announced = true;
  toast(ok ? (rec.finished ? 'Race saved to My races' : 'Unfinished race saved to My races') : 'Race saved in this browser only (server not reachable)', ok ? 'good' : 'warn');
}

function toast(text, kind = 'good') {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = text; el.className = `show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = ''; }, 3500);
}

// Refreshing, closing or hiding the page saves what you've sailed so far.
window.addEventListener('pagehide', () => { if (S.cur) persist(S.cur, { unloading: true }); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && S.cur) persist(S.cur, { unloading: true });
});

// What it looked like when you decided to tack (kept with the verdict for patterns).
function tackContext(sim) {
  const u = sim.user, c = sim.course;
  const st = compassState(sim, polar);
  const rank = sim.standings().findIndex(b => b.isUser) + 1;
  return { dev: st.dev, loss: u.loss, side: u.rel >= 0 ? 'port' : 'stbd', rank, twa: u.twa,
           distMark: Math.hypot(c.mark[0] - u.x, c.mark[1] - u.y) };
}

// One saved record per race: what you did, how it went, every decision.
// Unfinished races (finished: false) keep the start and the decisions but no
// result or metre breakdown, which need the whole beat.
function buildRecord(c, R, finished) {
  const sim = c.sim, coach = c.coach, u = sim.user, crs = sim.course;
  const verdicts = coach?.verdicts || [];
  const tacks = (sim.decisions || []).map(d => {
    const v = verdicts.find(x => x.kind === 'tack' && Math.abs(x.t - d.t) < 0.6);
    return { t: d.t, ...(d.ctx || {}), verdict: v?.verdict ?? null,
             lostBL: v ? (v.mine.meanT - v.best.meanT) * v.mine.blPerS : null,
             best: v?.best?.key ?? null, shareBest: v?.mine?.bestRankShare ?? null };
  });
  const missed = verdicts.filter(v => v.kind === 'missed').map(v => ({ t: v.t, verdict: v.verdict, gainBL: v.gainBL, dev: v.dev, held: v.held }));
  const bias = lineBias(crs, sim.wind.baseDir(0));
  const frac = u.startFrac ?? u.gunFrac ?? null;
  const vt = c.viewTime || {};
  const total = Object.values(vt).reduce((a, v) => a + v, 0) || 1;
  const nBoats = c.mode === 'takeover' ? sim.boats.filter(b => b.isGhost && b.id !== 1000).length + 1 : sim.boats.length;
  const st = R?.start;
  const fin = finished && R;
  return {
    version: 2, id: String(c.startedAt), startedAt: c.startedAt, savedAt: Date.now(), finished,
    raceT: Math.round(sim.t), sailedS: Math.round(sim.t - c.t0), rewinds: c.rewinds, peeks: c.peeks || 0,
    mode: c.mode, takeover: c.mode === 'takeover' ? c.from : null,
    preset: sim.preset.key, seed: sim.seed, fleet: sim.boats.filter(b => !b.isGhost).length, level: u.level,
    cues: coach?.level, viewShare: Object.fromEntries(Object.entries(vt).map(([k, v]) => [k, +(v / total).toFixed(2)])),
    result: { rank: finished ? (R?.finish.rank ?? u.roundRank) : null, nBoats, behindLeaderS: fin ? R.finish.behindLeader : null,
              roundedAt: finished ? u.rounded : null, penalties: u.penalties },
    start: st && st.dtl !== null ? { dtl: st.dtl, v: st.v, vRatio: st.vRatio, twa: st.twa, frac, ocs: !!u.ocs, crossedAt: st.crossedAt,
             bias, favouredEnd: Math.abs(bias) >= 5 && frac != null && (bias > 0 ? frac < 0.34 : frac > 0.66) } : null,
    gain60: R && sim.t >= 60 ? R.gainAt(60) : null,
    items: fin ? Object.fromEntries(R.items.map(i => [i.key, Math.round(i.m * 10) / 10])) : {},
    itemTitles: fin ? Object.fromEntries(R.items.map(i => [i.key, i.title])) : {},
    nTacks: R ? R.tacks.length : (sim.decisions?.length ?? 0),
    lifted: R?.lifted ?? null, headed: R?.headed ?? null, badAirPct: R?.badPct ?? null,
    overstandPass: fin ? (R.overstand?.pass ?? null) : null,
    tacks, missed,
  };
}

// Races live on disk (data/my-races via server.mjs) and, as a backup, in this
// browser's localStorage. Opening My races uploads any the server is missing.
const LS_KEY = 'm15-races';
// On your Mac (node server.mjs) races also go to disk. On the shared website
// there's no server: each person's races stay in their own browser.
const HOSTED = !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
const raceKey = (r) => String(r.id ?? r.startedAt ?? r.savedAt);
function localRaces() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]').filter(r => r && typeof r === 'object'); } catch { return []; }
}
function storeLocal(rec) {
  try {
    const all = localRaces().filter(r => raceKey(r) !== raceKey(rec));
    all.push(rec);
    localStorage.setItem(LS_KEY, JSON.stringify(all.slice(-300)));
  } catch { /* storage full or blocked */ }
}
async function postRace(rec, unloading = false) {
  const body = JSON.stringify(rec);
  if (unloading && navigator.sendBeacon) {
    try { return navigator.sendBeacon('api/races', new Blob([body], { type: 'application/json' })); } catch { /* fall through */ }
  }
  try {
    const r = await fetch('api/races', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60000 });
    return r.ok;
  } catch { return false; }
}
async function saveRace(rec, unloading = false) {
  storeLocal(rec);
  return HOSTED ? true : postRace(rec, unloading);
}

async function loadRaces() {
  const local = localRaces();
  if (HOSTED) return { races: local, from: 'device', uploaded: 0 };
  let disk = null;
  try {
    const r = await fetch('api/races', { cache: 'no-store' });
    if (r.ok) disk = await r.json();
  } catch { /* plain static server */ }
  if (!Array.isArray(disk)) return { races: local, from: 'browser', uploaded: 0 };
  const byKey = new Map(disk.map(r => [raceKey(r), r]));
  let uploaded = 0;
  for (const r of local) {
    const d = byKey.get(raceKey(r));
    if (d && (d.savedAt || 0) >= (r.savedAt || 0)) continue;
    byKey.set(raceKey(r), r);
    if (await postRace(r)) uploaded++;
  }
  return { races: [...byKey.values()], from: 'disk', uploaded };
}

async function renderProgress() {
  const el = $('progress');
  el.innerHTML = '<div class="inner"><p class="sub">Loading…</p></div>';
  if (S.cur) await persist(S.cur);          // the race you're in shows up too (as unfinished until you round)
  const { races, from, uploaded } = await loadRaces();
  const P = findPatterns(races, bench);
  const rows = [...P.table].reverse().slice(0, 60).map(r => {
    const tk = (r.tacks || []).filter(t => t.verdict);
    const fin = r.finished !== false && r.result?.rank != null;
    return `<tr class="${fin ? '' : 'dnf'}"><td>${new Date(r.startedAt ?? r.savedAt).toLocaleString()}</td><td>${r.mode === 'takeover' ? `Real: WCC race ${r.takeover?.race} as ${r.takeover?.sail}` : `${presets[r.preset] ? raceName(presets[r.preset], r.seed) : r.preset}`}</td>
      <td>${fin ? `${r.result.rank}/${r.result.nBoats}` : `not finished${Number.isFinite(r.raceT) ? ` (left at ${fmtT(r.raceT)})` : ''}`}</td><td>${Number.isFinite(r.start?.dtl) ? r.start.dtl.toFixed(1) + ' m' : '—'}</td>
      <td>${Number.isFinite(r.gain60) ? (r.gain60 >= 0 ? '+' : '') + r.gain60.toFixed(0) + ' m' : '—'}</td>
      <td>${tk.length ? `${tk.filter(t => t.verdict === 'good').length}/${tk.length}` : '—'}</td><td>${r.nTacks ?? '—'}</td><td>${r.cues || ''}</td></tr>`;
  }).join('');
  const nAll = P.table.length, nUn = nAll - P.n;
  el.innerHTML = `<div class="inner">
    <h1>My races</h1>
    <p class="sub">${nAll} race${nAll === 1 ? '' : 's'} saved${nUn ? ` (${P.n} finished, ${nUn} not finished)` : ''}, ${from === 'disk' ? 'in <code>data/my-races/</code>' : from === 'device' ? 'in this browser on this device (they stay private to you; clearing site data deletes them)' : '<span class="warn">in this browser only</span> (open the sim from <code>node server.mjs</code> to keep them on disk)'}.
    Every race and take-over you sail past 20 s after the gun is kept, with each tack, what it looked like when you made it,
    and how it graded against wind futures. Unfinished races count toward starts and tack decisions, not results.</p>
    ${uploaded ? `<p class="good">Recovered ${uploaded} race${uploaded === 1 ? '' : 's'} that were only in this browser and saved ${uploaded === 1 ? 'it' : 'them'} to disk.</p>` : ''}
    ${P.n >= 2 ? '<div class="gainwrap"><canvas id="progChart" style="width:100%;height:160px"></canvas><div class="sub">Blue: finish at the windward mark (top of chart = 1st). Orange: metres vs the fleet a minute after the gun. Finished races only.</div></div>' : ''}
    <h2>Patterns</h2>
    ${P.findings.map(f => `<div class="focus ${f.kind === 'good' ? 'good' : ''}" style="${f.kind === 'info' ? 'border-color: var(--accent)' : ''}"><h4>${f.title} <span class="sub">(n=${f.n})</span></h4><div>${f.text}</div></div>`).join('') || '<p class="sub">Sail a race to start.</p>'}
    ${P.focus ? `<p><b>Work on next:</b> ${P.focus.title}. ${(ADVICE_LINE[P.focus.key] || '')}</p>` : ''}
    <h2>Races</h2>
    <table><tr><th>When</th><th>Course</th><th>At the mark</th><th>Behind line at gun</th><th>vs fleet at 1 min</th><th>Good tacks</th><th>Tacks</th><th>Cues</th></tr>${rows}</table>
    ${nAll ? '<p style="margin-top:14px"><button id="dlRaces">Download my races (JSON)</button> <span class="sub">to keep a copy or send to a friend</span></p>' : ''}
  </div>`;
  if ($('dlRaces')) $('dlRaces').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(P.table, null, 1)], { type: 'application/json' }));
    a.download = `melges15-races-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  if (P.n >= 2) progressChart(P.finished);
}

const ADVICE_LINE = {
  start: 'Use "Start at 1:00" for quick reps: park two lengths back, trim on at zero time-to-burn, cross footing at full speed.',
  shifts: 'Sail with Cues on "Prompts only" and call lift/header from the compass before each tack.',
  badair: 'After the start, check your lane every 20 s; tack or foot clear within 20 s of getting bad air.',
  tacks: 'Only tack for a 5°+ header, a lane, or the layline.',
  layline: 'Call laylines in Helm view without the overhead; tack a little short and lay the mark on starboard.',
  penalties: 'Decide port/starboard crossings early: duck by 5-10° rather than late.',
};

function progressChart(R) {
  const c = $('progChart');
  if (!c) return;
  const rect = c.getBoundingClientRect();
  c.width = rect.width * dpr; c.height = rect.height * dpr;
  const g = c.getContext('2d');
  const W = c.width, H = c.height, pad = 30 * dpr;
  g.clearRect(0, 0, W, H);
  const X = (i) => pad + i / Math.max(1, R.length - 1) * (W - 2 * pad);
  g.strokeStyle = 'rgba(255,255,255,0.1)';
  g.beginPath(); g.moveTo(pad, H / 2); g.lineTo(W - pad, H / 2); g.stroke();
  const line = (vals, color, Y) => {
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2 * dpr; g.beginPath();
    vals.forEach((v, i) => { if (!Number.isFinite(v)) return; const y = Y(v); i ? g.lineTo(X(i), y) : g.moveTo(X(i), y); });
    g.stroke();
    vals.forEach((v, i) => { if (Number.isFinite(v)) { g.beginPath(); g.arc(X(i), Y(v), 3 * dpr, 0, 7); g.fill(); } });
  };
  line(R.map(r => (r.result.rank - 1) / Math.max(1, r.result.nBoats - 1)), '#4fb3ff', (v) => pad + v * (H - 2 * pad));
  line(R.map(r => r.gain60), '#ffb547', (v) => H / 2 - Math.max(-60, Math.min(60, v)) / 60 * (H / 2 - pad));
}

function renderVerdicts() {
  const el = $('verdicts');
  if (!el) return;
  const v = [...(S.coach?.verdicts || [])].sort((a, b) => a.t - b.t);
  const pending = (S.sim?.decisions?.length || 0) - v.filter(x => x.kind === 'tack').length;
  if (!v.length && !pending) { el.innerHTML = '<p class="sub">No tacks to grade.</p>'; return; }
  el.innerHTML = '<h3 style="margin-top:12px">Your decisions, sailed out against wind futures</h3>' +
    v.map(x => `<div class="sub" style="margin:4px 0"><span class="${x.verdict === 'good' || x.verdict === 'ok' ? 'good' : x.verdict === 'warn' ? 'warn' : 'bad'}">●</span> ${x.text}</div>`).join('') +
    (pending > 0 ? `<div class="sub">Grading ${pending} more…</div>` : '');
}

// Shared by the sim debrief and the real-race report card.
function reportHtml(R, source, sail = null) {
  const B = bench;
  const items = [...R.items].sort((a, b) => a.m - b.m);
  const losses = items.filter(i => i.m < -3).slice(0, 3);
  const wins = items.filter(i => i.m > 5).sort((a, b) => b.m - a.m).slice(0, 2);
  const st = R.start;
  const who = sail ? sail : 'you';
  const startLine = st.dtl === null ? '' : `<tr><th>At the gun</th><td>${st.dtl < 0 ? `<span class="bad">over by ${(-st.dtl).toFixed(1)} m</span>` : `${st.dtl.toFixed(1)} m behind`} at ${st.v.toFixed(1)} kn, ${Math.round(st.twa)}° to the wind</td>
      <td class="sub">WCC top 5: ${B.top5.dtl.toFixed(1)} m at ${B.top5.gunKn.toFixed(1)} kn · bottom 5: ${B.bottom5.dtl.toFixed(1)} m at ${B.bottom5.gunKn.toFixed(1)} kn</td></tr>`;
  const g60 = R.gainAt(60);
  const focus = (it, good = false) => `<div class="focus ${good ? 'good' : ''}">
      <h4>${it.title}<span class="m">${it.m >= 0 ? '+' : '−'}${Math.abs(it.m).toFixed(0)} m</span></h4>
      <div>${it.detail}</div>
      ${good ? '' : `<div class="drill"><b>In the sim:</b> ${it.sim}</div><div class="drill"><b>On the water:</b> ${it.water}</div>
      ${it.at != null && source === 'real' ? `<button class="resail" data-t="${Math.round(it.at)}">Re-sail this moment (${clock(Math.max(-60, it.at))})</button>` : ''}`}
    </div>`;
  return `
    <div class="gainwrap"><canvas id="gainChart" style="width:100%;height:150px"></canvas>
      <div class="sub">Metres ahead (+) or behind (−) the fleet median, start to windward mark. Dots: ${who === 'you' ? 'your' : 'the'} tacks${who === 'you' ? ' (green = good call, red = a better option existed)' : ''}.</div></div>
    <table>${startLine}
      <tr><th>A minute later</th><td>${g60 === null ? '—' : `${g60 >= 0 ? '+' : ''}${g60.toFixed(0)} m vs the fleet median`}</td><td class="sub">top 5: +${B.top5.gain60.toFixed(0)} m · bottom 5: ${B.bottom5.gain60.toFixed(0)} m</td></tr>
      <tr><th>Tacks</th><td>${R.tacks.length}</td><td class="sub">WCC median 5</td></tr>
    </table>
    <p class="sub">In the WCC races, the top five were ${B.top5.gain60.toFixed(0)} m up on the fleet a minute after the gun and the bottom five ${Math.abs(B.bottom5.gain60).toFixed(0)} m down: the start decides a lot.</p>
    <h3>${losses.length ? 'Where the metres went' : 'No big losses'}</h3>
    ${losses.map(i => focus(i)).join('') || '<p class="sub">Nothing cost more than a few metres.</p>'}
    ${wins.length ? '<h3>What worked</h3>' + wins.map(i => focus(i, true)).join('') : ''}`;
}

function drawGainChart(R, verdicts) {
  const c = $('gainChart');
  if (!c) return;
  const r = c.getBoundingClientRect();
  c.width = r.width * dpr; c.height = r.height * dpr;
  const g = c.getContext('2d');
  const pts = R.gain.filter(Boolean);
  if (!pts.length) return;
  const marks = R.tacks.map(t => {
    const v = verdicts.find(x => x.kind === 'tack' && Math.abs(x.t - t) < 6);
    return { t, color: v ? (v.verdict === 'good' ? '#3ddc84' : v.verdict === 'warn' ? '#ffb547' : '#ff5a5a') : 'rgba(255,255,255,0.5)' };
  });
  for (const v of verdicts) if (v.kind === 'missed' && v.verdict === 'bad') marks.push({ t: v.t, color: '#ff5a5a' });
  drawChart(g, { series: [{ pts: pts.map(([t, m]) => [t, m]), color: '#4fb3ff', width: 2, label: 'metres vs fleet median' }],
                 marks, dpr, t0: 0, t1: R.tEnd, ref: 0, linear: true });
}

// ------------------------------------------------------------------ real-race report card
function reportCard() {
  const r = S.replay;
  if (!r) return;
  const sail = $('replayBoat').value;
  const R = analyze(tracksFromReplay(r, sail));
  const est = r.roundEst[sail] ? ' (estimated: radio gap at the mark)' : '';
  overlay(`<h2>${sail}: race ${r.d.race} first beat</h2>
    <p>Finished ${r.place[sail] ? ordinal(r.place[sail]) : '—'}; ${ordinal(R.finish.rank)} at the windward mark at ${fmtT(R.tEnd)}${est}.
    Wind direction is the fleet-inferred one, so shift numbers are compared with the rest of the fleet in the same race.</p>
    ${reportHtml(R, 'real', sail)}
    <p class="sub">"Re-sail this moment" puts you in ${sail} just before it, against the real fleet as ghosts, with cues on.</p>
    <p><button class="primary" id="go">Close</button></p>`);
  drawGainChart(R, []);
  $('go').onclick = closeOverlay;
  for (const b of document.querySelectorAll('.resail')) b.onclick = () => {
    closeOverlay();
    r.setTime(Math.max(-60, Number(b.dataset.t)));
    takeOver();
  };
}
$('reportCard').onclick = reportCard;

// ------------------------------------------------------------------ loop
let lastT = performance.now();
function frame(now) {
  const real = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  S.frameDt = real;
  // One error must not stop the loop (it would freeze the whole app).
  // look around (Q/E), also while paused; the view stays where you leave it (F = bow)
  if (S.keys.lookL) S.look = wrap(S.look - 150 * real);
  else if (S.keys.lookR) S.look = wrap(S.look + 150 * real);
  try { if (!S.paused && !S.overlay) advance(real * S.speed); } catch (err) { console.error('advance', err); }
  try { syncView(); } catch (err) { console.error('view', err); }
  try { draw(); } catch (err) { console.error('draw', err); }
  try { if (now - S.lastUi > 150) { S.lastUi = now; ui(); } } catch (err) { console.error('ui', err); }
  requestAnimationFrame(frame);
}

function advance(dt) {
  if (S.mode === 'replay') {
    const r = S.replay;
    r.setTime(Math.min(r.tMax, r.t + dt));
    if (r.t >= r.tMax) S.paused = true;
    return;
  }
  const sim = S.sim;
  if (!sim || S.ended || S.scrubT !== null) return;
  const u = sim.user;
  const steps = Math.max(1, Math.round(dt / 0.25));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const manual = u.ctl.mode === 'manual';
    const rate = manual ? 30 : 5;
    if (S.keys.left) sim.userSteer(-rate * h);
    if (S.keys.right) sim.userSteer(rate * h);
    if (S.keys.ease) sim.userEase(true);
    sim.step(h);
    S.viewTime[S.view] = (S.viewTime[S.view] || 0) + h;
    try { S.coach?.tick(sim); } catch (err) { console.error('coach', err); }
    if (u.done && u.rounded !== null && !S.ended) { finishRace(); break; }
    if (sim.t > sim.tMax) {
      S.ended = true; S.paused = true;
      overlay('<h2>Time limit</h2><p>The race timed out before you rounded. It is saved to My races as unfinished (your start and tacks still count).</p><button class="primary" id="go">New race</button>');
      $('go').onclick = newRace;
      if (S.cur?.sim === sim) persist(S.cur);
      break;
    }
  }
}

function sceneFromHistory(sim, t) {
  const h = sim.history.find(x => x.t >= t) ?? sim.history[sim.history.length - 1];
  return sim.boats.map((b, i) => {
    const r = h.row;
    const x = r[i * 8], y = r[i * 8 + 1];
    return { ...b, x, y, hdg: r[i * 8 + 2], v: r[i * 8 + 3], twd: r[i * 8 + 5], tws: r[i * 8 + 6],
             rel: wrap(r[i * 8 + 2] - r[i * 8 + 5]), twa: Math.abs(wrap(r[i * 8 + 2] - r[i * 8 + 5])),
             hidden: !Number.isFinite(x), done: b.rounded !== null && b.rounded <= t, roundRank: b.rounded !== null && b.rounded <= t ? b.roundRank : null,
             ctl: { ...b.ctl, mode: r[i * 8 + 7] ? 'penalty' : 'close', eased: false } };
  });
}

function draw() {
  const W = canvas.width, H = canvas.height;
  let scene;
  if (S.mode === 'replay' && S.replay) {
    const r = S.replay;
    const sel = $('replayBoat').value;
    const boats = r.boats.map(b => ({ ...b, isUser: b.sail === sel }));
    scene = { course: r.course, boats, t: r.t, view: S.view, polar, laylineTwd: r.twdAt(r.t), laylines: S.laylines,
              trail: (b) => r.trail(b, r.t), allTrails: true, dpr, labels: true };
    const me = boats.find(b => b.isUser && !b.hidden);
    if (S.cam.follow && me) { S.cam.cx = me.x; S.cam.cy = me.y; }
  } else if (S.sim) {
    const sim = S.sim;
    const t = S.scrubT ?? sim.t;
    const boats = S.scrubT !== null ? sceneFromHistory(sim, S.scrubT) : sim.boats;
    scene = { course: sim.course, boats, t, view: S.view, polar, wind: sim.wind, user: sim.user, laylines: S.laylines,
              laylineTwd: S.view === 'coach' ? sim.wind.baseDir(t) : sim.user.twd, dpr,
              trail: (b) => trail(sim, b, t), allTrails: S.scrubT !== null };
    const me = boats.find(b => b.isUser);
    if (S.cam.follow && me) {
      // look ahead a little up the course
      S.cam.cx = me.x; S.cam.cy = me.y;
    }
  }
  if (!scene) return;
  const helm = S.view === 'helm' && S.sim && S.scrubT === null && S.mode !== 'replay';
  const use3d = helm && helm3d?.ok && !S.flat;
  helm3d?.setVisible(use3d);
  if (use3d) {
    const hs = { ...scene, user: S.sim.user, look: S.look, minimap: S.minimap };
    helm3d.render(hs, S.frameDt || 0.016);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawHelmOverlay(ctx, hs);
  } else if (helm) {
    drawHelm(ctx, { ...scene, user: S.sim.user, look: S.look, minimap: S.minimap });
  } else drawScene(ctx, S.cam, scene);
}

function trail(sim, b, t) {
  const idx = sim.boats.indexOf(sim.boats.find(x => x.id === b.id));
  const pts = [];
  const H = sim.history;
  const secs = b.isUser ? 240 : 60;
  for (let k = H.length - 1; k >= 0; k -= 2) {
    const h = H[k];
    if (h.t > t) continue;
    if (h.t < t - secs) break;
    const x = h.row[idx * 8], y = h.row[idx * 8 + 1];
    pts.push(Number.isFinite(x) ? [x, y] : null);
  }
  if (!b.hidden) pts.unshift([b.x, b.y]);
  return pts;
}

// ------------------------------------------------------------------ panels
function stat(k, v, cls = '', wide = false) { return `<div class="stat${wide ? ' wide' : ''}"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`; }

function ui() {
  if (S.mode === 'replay' && S.replay) { $('atlas').classList.add('hidden'); $('standBox').classList.remove('hidden'); return uiReplay(); }
  const sim = S.sim;
  if (!sim) return;
  const u = sim.user;
  const t = S.scrubT ?? sim.t;
  $('clock').textContent = fmtT(t);
  $('phase').textContent = S.scrubT !== null ? 'Reviewing (Branch to sail on from here)' : t < 0 ? 'Pre-start' : u.done ? 'Rounded' : u.started ? 'First beat' : u.ocs && !u.ocsCleared ? 'OCS: return below the line' : 'Start';
  $('btnPause').textContent = S.paused ? 'Resume' : 'Pause';
  const c = sim.course;
  const opt = polar.optimal(u.tws, u.level);
  const helm = S.view === 'helm' && S.scrubT === null && S.mode !== 'replay';
  $('standBox').classList.toggle('hidden', helm && !S.ended);
  $('atlas').classList.toggle('hidden', !helm || S.ended);
  if (helm) { uiHelm(sim, u, c, t); drawCompass(sim); drawShiftChart(sim, t); logAndScrub(sim); $('hint').textContent = hint(sim); return; }
  let html = '';
  if (t < 0) {
    const [bx, by] = bowPos(u);
    const dtl = -lineSide(c, bx, by);
    const ttl = timeToLine(u, sim);
    const burn = -t - ttl;
    const bias = lineBias(c, S.view === 'coach' ? sim.wind.baseDir(t) : u.twd);
    const f = lineFrac(c, bx, by);
    html += stat('Distance to line', `${dtl.toFixed(0)} m`, dtl < 0 ? 'bad' : '');
    html += stat('Time to burn', `${burn.toFixed(0)} s`, burn < 0 ? 'bad' : burn < 5 ? 'warn' : 'good');
    html += stat('Line bias', Math.abs(bias) < 2 ? 'square' : `${bias > 0 ? 'pin' : 'boat'} +${Math.abs(bias).toFixed(0)} m`);
    html += stat('Along the line', f < 0 ? 'left of pin' : f > 1 ? 'right of boat' : `${Math.round(f * 100)}% from pin`);
  }
  html += stat('Speed', `${(u.v / KN).toFixed(1)} kn`);
  html += stat('Heading', `${Math.round(u.hdg)}°`);
  html += stat('TWA', `${Math.round(u.twa)}° ${u.rel >= 0 ? 'P' : 'S'}`, u.twa < opt.upTwa - 4 ? 'warn' : '');
  html += stat(u.ctl.mode === 'close' ? 'Autopilot' : 'Steering', u.ctl.mode === 'close' ? (u.ctl.offset > 0.5 ? `footing ${u.ctl.offset.toFixed(0)}°` : u.ctl.offset < -0.5 ? `pinching ${(-u.ctl.offset).toFixed(0)}°` : 'close-hauled') : u.ctl.mode === 'penalty' ? 'penalty turns' : u.ctl.eased ? 'luffing' : 'manual');
  if (t >= 0) {
    const vmgKn = (u.v / KN) * Math.cos(u.twa * Math.PI / 180);
    html += stat('VMG', `${vmgKn.toFixed(2)} kn`, vmgKn > opt.upVmg * 0.95 ? 'good' : '');
    const dm = Math.hypot(c.mark[0] - u.x, c.mark[1] - u.y);
    html += stat('To mark', `${dm.toFixed(0)} m`);
  }
  html += `<div class="stat wide"><div class="k">Bad air ${(u.loss * 100).toFixed(1)}%</div><div class="bar"><div style="width:${Math.min(100, u.loss / 0.12 * 100)}%"></div></div></div>`;
  if (S.view === 'coach') html += stat('Wind here', `${Math.round(u.twd)}° ${u.tws.toFixed(1)} kn`, '', true);
  if (u.owesPenalty) html += stat('Penalty owed', 'Press X', 'bad', true);
  $('hud').innerHTML = html;
  drawCompass(sim);
  // standings
  let rows;
  if (S.mode === 'takeover') {
    const all = sim.boats.filter(b => !b.hidden || b.isUser).map(b => ({ b, key: b.isUser ? (u.rounded ?? (1e5 + remaining(sim, u))) : (b.realRound != null && b.realRound <= t ? b.realRound : 1e5 + remaining(sim, b)) }));
    rows = all.sort((a, b) => a.key - b.key).map(x => x.b);
  } else rows = sim.standings();
  const myI = rows.findIndex(b => b.isUser);
  const show = rows.slice(0, 6);
  if (myI >= 6) show.push(rows[myI]);
  $('standings').innerHTML = show.map((b) => {
    const i = rows.indexOf(b);
    const tag = b.rounded != null && b.rounded <= t ? ` rounded ${fmtT(b.rounded)}` : '';
    return `<div class="${b.isUser ? 'me' : ''}">${String(i + 1).padStart(2)}. ${b.isUser ? 'YOU' : b.sail}${tag}${b.ocs && !b.ocsCleared ? ' OCS' : ''}</div>`;
  }).join('');
  drawShiftChart(sim, t);
  logAndScrub(sim);
  $('hint').textContent = hint(sim);
}

function logAndScrub(sim) {
  const ev = sim.events.slice(-40).reverse();
  $('log').innerHTML = ev.map(e => `<div class="${e.type}"><span class="t">${fmtT(e.t)}</span>${e.text}</div>`).join('');
  const H = sim.history;
  if (H.length) {
    $('scrub').min = H[0].t; $('scrub').max = H[H.length - 1].t;
    $('scrub').value = S.scrubT ?? H[H.length - 1].t;
    $('scrubLabel').textContent = S.scrubT !== null ? `reviewing ${fmtT(S.scrubT)}` : '';
  }
}

// Helm view: only what you'd have on the water (a Vakaros-style display).
function uiHelm(sim, u, c, t) {
  let line = '';
  if (t < 0) {
    const [bx, by] = bowPos(u);
    const dtl = -lineSide(c, bx, by);
    const burn = -t - timeToLine(u, sim);
    line = `<div class="row"><div><div class="k">LINE</div><div class="v sm">${dtl.toFixed(0)} m</div></div>
      <div><div class="k">BURN</div><div class="v sm ${burn < 0 ? 'head' : ''}">${burn.toFixed(0)} s</div></div></div>`;
  }
  const st = compassState(sim, polar);
  const lift = st.dev === null ? '—' : `${st.dev >= 0 ? 'LIFT' : 'HEAD'} ${Math.abs(st.dev).toFixed(0)}°`;
  $('atlas').innerHTML = `
    <div class="row"><div><div class="k">${t < 0 ? 'TIMER' : 'ELAPSED'}</div><div class="v">${fmtT(t)}</div></div>
      <div><div class="k">SPEED</div><div class="v">${(u.v / KN).toFixed(1)}</div></div>
      <div><div class="k">HDG</div><div class="v">${String(Math.round(u.hdg) % 360).padStart(3, '0')}</div></div></div>
    ${line}
    <div class="row"><div><div class="k">TACTICAL</div><div class="v sm ${st.dev === null ? '' : st.dev >= 0 ? 'lift' : 'head'}">${lift}</div></div>
      <div><div class="k">RC COURSE</div><div class="v sm">${String(Math.round(c.axis) % 360).padStart(3, '0')}°</div></div></div>`;
  let html = stat('Speed', `${(u.v / KN).toFixed(1)} kn`) + stat('Heading', `${Math.round(u.hdg)}°`);
  html += stat(u.ctl.mode === 'close' ? 'Autopilot' : 'Steering', u.ctl.mode === 'close' ? (u.ctl.offset > 0.5 ? `footing ${u.ctl.offset.toFixed(0)}°` : u.ctl.offset < -0.5 ? `pinching ${(-u.ctl.offset).toFixed(0)}°` : 'close-hauled') : u.ctl.mode === 'penalty' ? 'penalty turns' : u.ctl.eased ? 'luffing' : 'manual');
  html += stat('On the water', 'no standings, no line drawn, no wind arrows', '', true);
  if (u.owesPenalty) html += stat('Penalty owed', 'Press X', 'bad', true);
  $('hud').innerHTML = html;
}

function remaining(sim, b) {
  const c = sim.course;
  return upwind(c.mark[0], c.mark[1], c.axis) - upwind(b.x, b.y, c.axis);
}

function hint(sim) {
  const u = sim.user;
  if (S.scrubT !== null) return 'Reviewing: drag the timeline, then "Branch from here" to sail on with the same wind.';
  if (sim.t < 0) return S.view === 'helm' ? 'Sight the pin and the committee boat; LINE and BURN are your Atlas readings. ↓ luff, C close-hauled, Q/E look, hold V to peek overhead.' : 'Find your spot, burn time with ↓, hit the line at speed at the gun. C = close-hauled autopilot.';
  if (u.ocs && !u.ocsCleared) return 'OCS: bear away below the line (← / →), then come back up and start.';
  if (!u.started) return 'Cross the line between the pin and the committee boat to start.';
  return S.view === 'helm' ? 'Space tack · drag or Q/E to look (F = bow) · click the 360° strip · M mini-map · W what if · hold V to peek overhead' : S.peek ? 'Peeking at the overhead: let go of V to get back to the helm.' : 'Space to tack. W = what if (tack vs hold). V = cycle views.';
}

function drawCompass(sim) {
  const u = sim.user;
  const W = comp.width, H = comp.height;
  compCtx.clearRect(0, 0, W, H);
  const st = compassState(sim, polar);
  compCtx.fillStyle = 'rgba(232,238,245,0.55)';
  compCtx.font = '11px -apple-system, sans-serif';
  if (st.dev === null) {
    compCtx.fillText('Sail upwind a minute on each tack to set the baseline.', 6, 50);
    $('compassNote').textContent = '';
    return;
  }
  const { dev, med, side, how } = st;
  const cx = W / 2, scale = (W / 2 - 12) / 15;
  compCtx.fillStyle = 'rgba(255,90,90,0.18)'; compCtx.fillRect(12, 30, W / 2 - 12, 26);
  compCtx.fillStyle = 'rgba(61,220,132,0.18)'; compCtx.fillRect(cx, 30, W / 2 - 12, 26);
  compCtx.strokeStyle = 'rgba(255,255,255,0.4)';
  for (let d = -15; d <= 15; d += 5) { compCtx.beginPath(); compCtx.moveTo(cx + d * scale, 56); compCtx.lineTo(cx + d * scale, 62); compCtx.stroke(); }
  const x = cx + Math.max(-15, Math.min(15, dev)) * scale;
  compCtx.fillStyle = dev >= 0 ? '#3ddc84' : '#ff5a5a';
  compCtx.fillRect(x - 3, 26, 6, 34);
  compCtx.fillStyle = 'rgba(232,238,245,0.85)';
  compCtx.font = '600 13px ui-monospace, monospace';
  compCtx.fillText(`${side > 0 ? 'Port' : 'Stbd'} ${Math.round(u.hdg)}°  median ${Math.round(med)}°`, 6, 16);
  compCtx.font = '11px -apple-system, sans-serif';
  compCtx.fillText('headed', 14, 80); compCtx.fillText('lifted', W - 46, 80);
  $('compassNote').innerHTML = `<span class="${dev >= 0 ? 'good' : 'bad'}">${dev >= 0 ? 'Lifted' : 'Headed'} ${Math.abs(dev).toFixed(0)}°</span> · ${how}`;
}

function drawShiftChart(sim, t) {
  const u = sim.user, idx = sim.boats.indexOf(u);
  const H = sim.history;
  const opt = polar.optimal(sim.wind.p.tws, u.level);
  const compassPts = [], local = [], base = [];
  for (const h of H) {
    const hdg = h.row[idx * 8 + 2], twd = h.row[idx * 8 + 5];
    const rel = wrap(hdg - twd);
    if (Math.abs(rel) > 25 && Math.abs(rel) < 60 && h.t > 0) compassPts.push([h.t, norm360(hdg - Math.sign(rel) * opt.upTwa)]);
    local.push([h.t, twd]);
    base.push([h.t, h.base]);
  }
  const series = [{ pts: compassPts, color: 'rgba(255,255,255,0.75)', dots: true, label: 'wind from your compass' }];
  if (S.view === 'coach' || S.ended) {
    series.push({ pts: local, color: '#4fb3ff', label: 'true wind at your boat' });
    series.push({ pts: base, color: 'rgba(255,181,71,0.8)', dash: [4, 3], label: 'course average' });
    if (S.ended) {
      const fut = [];
      for (let k = H[H.length - 1].t; k < H[H.length - 1].t + 300; k += 10) fut.push([k, sim.wind.baseDir(k)]);
      series.push({ pts: fut, color: 'rgba(255,181,71,0.35)', dash: [2, 4] });
    }
  }
  const marks = (sim.decisions || []).map(d => ({ t: d.t, color: 'rgba(255,255,255,0.25)' }));
  for (const g of S.grades) marks.push({ t: g.t, color: g.best === g.mine ? 'rgba(61,220,132,0.8)' : 'rgba(255,90,90,0.8)' });
  drawChart(cctx, { series, marks, dpr, cursor: S.scrubT ?? undefined, ref: sim.wind.p.twd,
                    t0: H.length ? H[0].t : -120, t1: Math.max(H.length ? H[H.length - 1].t : 0, 60) + (S.ended ? 300 : 0),
                    empty: 'Your compass-derived wind appears once you sail upwind. Coach view adds the true wind.' });
}

function uiReplay() {
  const r = S.replay;
  $('clock').textContent = fmtT(r.t);
  $('phase').textContent = `WCC race ${r.d.race} · ${r.d.day}${S.paused ? ' · paused (Space to play)' : ''}`;
  $('btnPause').textContent = S.paused ? 'Play' : 'Pause';
  const sel = $('replayBoat').value;
  const b = r.boats.find(x => x.sail === sel);
  let html = '';
  if (b && !b.hidden) {
    html += stat('Speed', `${(b.v / KN).toFixed(1)} kn`);
    html += stat('Heading', `${Math.round(b.hdg)}°`);
    html += stat('TWA (inferred)', `${Math.round(b.twa)}° ${b.rel >= 0 ? 'P' : 'S'}`);
    html += stat('Finished', b.place ? ordinal(b.place) : '—');
  } else html += stat('Boat', 'no data at this moment', 'warn', true);
  html += stat('Fleet wind (inferred)', `${Math.round(r.twdAt(r.t))}° · ${r.d.twsModelKn.toFixed(1)} kn model`, '', true);
  $('hud').innerHTML = html;
  compCtx.clearRect(0, 0, comp.width, comp.height);
  $('compassNote').textContent = '';
  const c = r.course;
  const vis = r.boats.filter(x => !x.hidden);
  const ord = vis.map(x => ({ x, k: x.rounded != null ? x.rounded : 1e5 + (upwind(c.mark[0], c.mark[1], c.axis) - upwind(x.x, x.y, c.axis)) }))
    .sort((a, b) => a.k - b.k).map(o => o.x);
  $('standings').innerHTML = ord.slice(0, 12).map((x, i) => `<div class="${x.sail === sel ? 'me' : ''}">${String(i + 1).padStart(2)}. ${x.sail}${x.rounded != null ? ' rounded ' + fmtT(x.rounded) : ''}${x.place ? ` (fin ${ordinal(x.place)})` : ''}</div>`).join('');
  $('log').innerHTML = `<div>OCS at the gun: ${r.d.ocs.length ? r.d.ocs.join(', ') : 'none'}</div>`;
  const pts = r.twd.t.map((t, i) => [t, r.twd.deg[i]]);
  const marks = [];
  if (b) {
    let prev = null;
    for (let i = 0; i < b.tr.x.length; i += 1) {
      const t = b.tr.t0 + i;
      if (b.tr.h[i] === null || t < 0) continue;
      const rel = wrap(b.tr.h[i] - r.twdAt(t));
      const s = Math.abs(rel) < 80 ? Math.sign(rel) : null;
      if (s !== null && prev !== null && s !== prev) marks.push({ t, color: 'rgba(255,255,255,0.3)' });
      if (s !== null) prev = s;
    }
  }
  drawChart(cctx, { series: [{ pts, color: '#ffb547', label: `race ${r.d.race}: wind direction inferred from the fleet (30 s)` }],
                    marks, dpr, cursor: r.t, t0: Math.min(-60, r.tMin), t1: r.tMax, ref: circMean(r.twd.deg) });
  $('scrub').min = Math.max(-360, r.tMin); $('scrub').max = r.tMax; $('scrub').value = r.t;
  $('scrubLabel').textContent = 'tack marks = selected boat';
  $('hint').textContent = 'Space = play/pause · drag the timeline · pick a boat, then Take over from here.';
}

// ------------------------------------------------------------------ about
function renderAbout() {
  const sh = cal.shifts, lg = cal.legs, mv = cal.maneuvers;
  const row = (cells) => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
  $('about').innerHTML = `<div class="inner">
  <h1>How the sim is built</h1>
  <p>Everything below comes from the Vakaros RaceSense tracks of the Melges 15 WCC 2026 (22 boats, 6 races, Sept 19–20,
  ocean course off Mission Beach). No boat carried a wind instrument, so wind <b>direction</b> is inferred from the fleet's
  headings (the mid-point between port and starboard upwind headings, every 30 s) and wind <b>speed</b> is NOAA's HRRR model
  for the race hour (treat it as ±2 kn). Checked against the course: the inferred wind is within 5–7° of the bearing the race
  committee set the windward mark on in 4 of 6 races (races 4 and 6 were 16–17° off, likely a shift after the mark was set), and it sits
  a few degrees right of the mark every time, so treat absolute directions as ±5°. In every race the end of the line it calls
  favoured had better average finishers than the other end (race 4 by a hair).</p>

  <h2>Boat (Melges 15)</h2>
  <table><tr><th>Race</th><th>Model wind</th><th>Upwind angle</th><th>Upwind median / p80</th><th>Downwind angle</th><th>Downwind median / p80</th></tr>
  ${lg.map(r => row([r.race, `${r.tws_model_kn.toFixed(1)} kn`, `${r.up_twa.toFixed(0)}°`, `${r.up_p50.toFixed(2)} / ${r.up_p80.toFixed(2)} kn`, `${r.dn_twa.toFixed(0)}°`, `${r.dn_p50.toFixed(2)} / ${r.dn_p80.toFixed(2)} kn`])).join('')}</table>
  <p>Tacks cost a median <b>${mv.tack.all.median_m.toFixed(1)} m</b> (${mv.tack.all.n} tacks; ${mv.tack['19'].median_m.toFixed(1)} m in the Sept 19 breeze);
  speed bottoms at ${(mv.tack.all.median_min_speed_ratio * 100).toFixed(0)}% and is back to 90% in ~${mv.tack.all.median_recover_s.toFixed(0)} s.
  Gybes: ${mv.gybe.all.median_m.toFixed(1)} m. The sim's boat model reproduces 2.8 m and 57% in a test tack at 8 kn.</p>
  <p>Wind shadow: boats 15–25 m directly downwind of another were ~5% slower; a boat on a leeward boat's windward hip ~4% slower.
  The sim uses a 6% peak (the data understate it: boats in bad air tack out fast).</p>

  <h2>Wind</h2>
  <table><tr><th>Race</th><th>Shift size (SD)</th><th>Range</th><th>Period</th><th>Trend</th></tr>
  ${sh.map(s => row([s.race, `±${s.osc_sd_deg.toFixed(1)}°`, `${s.osc_range_deg.toFixed(0)}°`, `${s.period_min.toFixed(1)} min`, `${s.trend_deg_per_min >= 0 ? '+' : ''}${s.trend_deg_per_min.toFixed(2)}°/min`])).join('')}</table>
  <p>Puffs: smoothed over 30 s, a boat's speed vs the fleet varied ±7–11%, stayed correlated ~30 s, and boats more than ~75 m apart
  didn't share puffs. There was no measurable left/right difference across the course (under 0.3° per 100 m).
  The generator reproduces the shift size, period and puff strength (tests/wind.test.mjs).</p>

  <h2>Starts</h2>
  <p>At the gun the real fleet was a median 2.4 m behind the line (p25 0.9 m, p75 4.7 m) at 3.7 kn, 14% were over.
  Finishing place correlated with upwind gain 2 minutes after the gun (ρ 0.33–0.72) far more than with distance to the line
  at the gun (ρ 0.03–0.28). The favoured third of the line produced the better average finish in 4 of 6 races.</p>

  <h2>How the bots compare with the real fleet</h2>
  <p>The same measurements on the six real races and on simulated races (<code>node tests/realism.mjs</code>):</p>
  <table><tr><th></th><th>Real WCC</th><th>Bots</th></tr>
  <tr><td>Distance behind the line at the gun (p25 / median / p75)</td><td>0.4 / 1.5 / 4.1 m</td><td>0.6 / 3.3 / 9.0 m</td></tr>
  <tr><td>Over the line at the gun</td><td>20%</td><td>16%</td></tr>
  <tr><td>Speed at the gun (median)</td><td>3.7 kn</td><td>3.0 kn</td></tr>
  <tr><td>Started within 10 s / 30 s of the gun</td><td>68% / 86%</td><td>69% / 89%</td></tr>
  <tr><td>Sailing the wrong way (TWA &gt; 90°) in the first 2 min</td><td>1.3%</td><td>2.8%</td></tr>
  <tr><td>Off the wind during the beat</td><td>0.5%</td><td>0.7%</td></tr>
  <tr><td>Tacks on the first beat (p25 / median / p75)</td><td>4 / 5 / 6</td><td>4 / 5 / 8</td></tr>
  <tr><td>Windward mark left to port</td><td>78% (mark position estimated)</td><td>98%</td></tr>
  <tr><td>Distance right of the mark passing it (median)</td><td>5 m</td><td>8 m</td></tr>
  <tr><td>First boat to the mark / first-to-last spread</td><td>677 s / 244 s</td><td>590 s / 188 s</td></tr>
  <tr><td>Boat pairs within 3 m (boat-seconds per race)</td><td>14</td><td>42</td></tr></table>
  <p>Bots park a boat length or two below the line, foot in at the gun like the real fleet (median 53° to the wind),
  dip quickly if over, keep clear by ducking or heading up early, tack only when the tack itself is clear, and round the
  windward mark to port (shooting it if they need to). A rounded bot sails clear and leaves the course.
  Their speeds span the real fleet's spread and barely track their finishing place, as in the data: the best finishers
  were not the fastest boats. They still start a bit further back and are a bit slower to the first mark than the real leaders.</p>

  <h2>Training loop</h2>
  <p>Helm view gives you only what you'd have in the boat, and it's the only view while you race (hold V for a brief peek
  at the overhead); cues and decision verdicts come during the race; the debrief puts
  metres on each part of the beat and suggests a sim drill and an on-water drill; and the Replay tab's <b>Report card</b>
  runs any real WCC boat (or your own races, once imported) through the same measures. In the WCC data the top five per race
  were ${bench.top5.dtl.toFixed(1)} m behind the line at ${bench.top5.gunKn.toFixed(1)} kn and +${bench.top5.gain60.toFixed(0)} m
  on the fleet a minute later; the bottom five ${bench.bottom5.dtl.toFixed(1)} m at ${bench.bottom5.gunKn.toFixed(1)} kn and
  ${bench.bottom5.gain60.toFixed(0)} m.</p>

  <h2>What is simplified</h2>
  <ul>
    <li>Rules: 10, 11, 12, 13 and penalty turns; 15/16 as "no penalty if the right-of-way boat just tacked, gybed or swung
      its course". No mark-room (18), no proper-course limits. Bots average about 3 incidents a race, mostly in the pre-start shuffle.</li>
    <li>No current (it was ~0.1–0.2 kn), no waves, no leeway.</li>
    <li>Mission Bay is a guess until it is calibrated from a bay race.</li>
  </ul></div>`;
}

window.__app = S;   // for the browser tests and debugging
S.helm3d = helm3d;
newRace();
requestAnimationFrame(frame);
