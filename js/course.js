// Venue presets (built from calibration.json) and the race-course layout.

import { unit, D2R, BOAT_LEN } from './geo.js';

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

export function buildPresets(cal) {
  const b = cal.polar.fits.up_p80[1];                 // speed ~ TWS^b upwind
  const pick = (races) => {
    const sh = cal.shifts.filter(s => races.includes(s.race));
    const pr = cal.pressure.filter(s => races.includes(s.race));
    const co = cal.course.filter(s => races.includes(s.race));
    return {
      tws: mean(sh.map(s => s.tws_model_kn)),
      oscSd: median(sh.map(s => s.osc_sd_deg)),
      periodS: median(sh.map(s => s.period_min)) * 60,
      trendSd: Math.max(0.15, Math.sqrt(mean(sh.map(s => s.trend_deg_per_min ** 2)))),
      pressureSd: median(pr.map(p => p.smoothed.sd)) / b,
      beat: median(co.map(c => c.beat_len_m)),
      line: median(co.map(c => c.line_len_m)),
    };
  };
  const skew = Math.sqrt(mean(cal.course.map(c => Math.asin(Math.max(-1, Math.min(1, c.bias_m_pin_upwind / c.line_len_m))) ** 2))) / D2R;
  const d19 = pick([1, 2, 3, 4]);
  const d20 = pick([5, 6]);
  return {
    ocean19: {
      key: 'ocean19', label: 'Ocean, Sept 19 sea breeze (WCC races 1-4)', calibrated: true,
      wind: { tws: d19.tws, twd: 275, axis: 275, oscSd: d19.oscSd, periodS: d19.periodS, trendSd: d19.trendSd,
              pressureSd: d19.pressureSd, sideGrad: 0 },
      beat: d19.beat, line: d19.line, fleet: 21, lineSkewSd: Math.min(skew, 10),
      note: `HRRR ${d19.tws.toFixed(1)} kn; shifts ±${d19.oscSd.toFixed(1)}° every ~${(d19.periodS / 60).toFixed(0)} min; puffs ±${(d19.pressureSd * 100).toFixed(0)}%`,
    },
    ocean20: {
      key: 'ocean20', label: 'Ocean, Sept 20 light air (WCC races 5-6)', calibrated: true,
      wind: { tws: d20.tws, twd: 255, axis: 255, oscSd: d20.oscSd, periodS: d20.periodS, trendSd: d20.trendSd,
              pressureSd: d20.pressureSd, sideGrad: 0 },
      beat: d20.beat, line: d20.line, fleet: 21, lineSkewSd: Math.min(skew, 10),
      note: `HRRR ${d20.tws.toFixed(1)} kn; shifts ±${d20.oscSd.toFixed(1)}° every ~${(d20.periodS / 60).toFixed(0)} min; puffs ±${(d20.pressureSd * 100).toFixed(0)}%`,
    },
    bay: {
      key: 'bay', label: 'Mission Bay (ESTIMATE, not calibrated)', calibrated: false,
      wind: { tws: 7, twd: 280, axis: 280, oscSd: 8, periodS: 240, trendSd: 0.3, pressureSd: 0.28, sideGrad: 0 },
      beat: 550, line: 90, fleet: 11, lineSkewSd: 6,
      note: 'Guessed: shiftier and puffier than the ocean, shorter course, smaller fleet. Send a bay race to calibrate.',
    },
  };
}

// Course: origin at the line centre. Pin (left end facing upwind) and
// committee boat (right end). Windward mark `beat` metres up the setup wind.
export function layCourse(preset, wind, rng) {
  const axis = preset.wind.axis;
  const setupDir = wind.baseDir(-300);                  // RC sets up ~5 min before
  const skew = rng.normal(0, preset.lineSkewSd);         // how square the line is
  const lineDir = setupDir + skew;                       // the wind the line is square to
  const [lx, ly] = unit(lineDir + 90);                   // from pin toward committee
  const half = preset.line / 2;
  const pin = [-lx * half, -ly * half];
  const boat = [lx * half, ly * half];
  const markDir = setupDir + rng.normal(0, 3);
  const [mx, my] = unit(markDir);
  const mark = [mx * preset.beat, my * preset.beat];
  return makeCourse(pin, boat, mark, axis);
}

export function makeCourse(pin, boat, mark, axis) {
  // Unit normal to the line pointing to the course side (upwind).
  let nx = -(boat[1] - pin[1]), ny = boat[0] - pin[0];
  const m = Math.hypot(nx, ny);
  nx /= m; ny /= m;
  const [ux, uy] = unit(axis);
  if (nx * ux + ny * uy < 0) { nx = -nx; ny = -ny; }
  return { pin, boat, mark, axis, nx, ny, lineLen: m, markR: 2 * BOAT_LEN };
}

// Signed distance of a point to the line: + = course side.
export function lineSide(c, x, y) { return (x - c.pin[0]) * c.nx + (y - c.pin[1]) * c.ny; }
// Fraction along the line from pin (0) to committee (1).
export function lineFrac(c, x, y) {
  const dx = c.boat[0] - c.pin[0], dy = c.boat[1] - c.pin[1];
  return ((x - c.pin[0]) * dx + (y - c.pin[1]) * dy) / (dx * dx + dy * dy);
}
export function linePoint(c, f) {
  return [c.pin[0] + (c.boat[0] - c.pin[0]) * f, c.pin[1] + (c.boat[1] - c.pin[1]) * f];
}
// Favoured end in metres: + = pin is further upwind in wind `twd`.
export function lineBias(c, twd) {
  const [ux, uy] = unit(twd);
  return (c.pin[0] - c.boat[0]) * ux + (c.pin[1] - c.boat[1]) * uy;
}

export const PALETTE = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6',
  '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1',
  '#000075', '#a9a9a9', '#ffffff', '#ff8c69', '#7fffd4'];

// The real WCC fleet, best average finish first.
export function roster(cal, n) {
  const all = Object.entries(cal.avg_place).sort((a, b) => a[1] - b[1]);
  const picks = [];
  if (n >= all.length) picks.push(...all);
  else for (let i = 0; i < n; i++) picks.push(all[Math.round(i * (all.length - 1) / Math.max(1, n - 1))]);
  return picks.map(([sail, place], i) => ({
    sail, avgPlace: place, iq: 1 - (all.findIndex(a => a[0] === sail)) / (all.length - 1),
  }));
}
