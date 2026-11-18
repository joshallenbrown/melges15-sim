// Bad air. Each boat casts a wind shadow along its APPARENT wind (the air
// leaving its sails streams back relative to the boat), and a boat sitting
// just to leeward and ahead backwinds the boat on its windward hip.
//
// Sizes: the WCC tracks show about -5% boat speed 15-25 m directly downwind
// of another boat and about -4% for a boat on a leeward boat's windward hip
// (tools/bad_air.py). Those are lower bounds (boats in bad air tack out
// fast), so the peak here is 6%.

import { KN, unit, wrap } from './geo.js';

export const SHADOW = {
  peak: 0.06,        // fraction of boat speed lost at the worst spot
  peakDist: 10,      // metres downstream where the shadow is strongest
  width0: 3.5,       // metres (sd) of the cone at the source
  widthGrow: 0.12,   // extra width per metre downstream (data: ~-2% at 6-15 m off the centreline)
  backwind: 0.04,
  maxLoss: 0.25,
  range: 60,         // ignore pairs further apart than this
};

// Shadow axis (unit vector, direction the disturbed air travels relative
// to the boat) for a boat in wind (tws kn, twd).
function apparentFlow(b) {
  const [wx, wy] = unit(b.twd);
  const fx = -wx * b.tws * KN, fy = -wy * b.tws * KN;    // air motion
  const [hx, hy] = unit(b.hdg);
  const ax = fx - hx * b.v, ay = fy - hy * b.v;           // relative to the boat
  const m = Math.hypot(ax, ay) || 1;
  return [ax / m, ay / m];
}

// Sets b.loss for every boat (0..maxLoss). Boats that finished the leg or
// ghosts flagged `noShadow` cast nothing.
export function computeShadows(boats) {
  const n = boats.length;
  const axes = boats.map(apparentFlow);
  for (let i = 0; i < n; i++) {
    const B = boats[i];
    if (B.done) { B.loss = 0; continue; }
    let keep = 1;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const A = boats[j];
      if (A.done || A.noShadow) continue;
      const dx = B.x - A.x, dy = B.y - A.y;
      if (dx > SHADOW.range || dx < -SHADOW.range || dy > SHADOW.range || dy < -SHADOW.range) continue;
      const strength = A.ctl.eased ? 0.5 : 1;
      // Shadow cone along A's apparent wind.
      const [axv, ayv] = axes[j];
      const along = dx * axv + dy * ayv;
      if (along > 0) {
        const crossD = Math.abs(dx * ayv - dy * axv);
        const sd = SHADOW.width0 + SHADOW.widthGrow * along;
        const fa = (along / SHADOW.peakDist) * Math.exp(1 - along / SHADOW.peakDist);
        const s = SHADOW.peak * strength * fa * Math.exp(-0.5 * (crossD / sd) ** 2);
        keep *= 1 - s;
      }
      // Backwind: B on A's windward hip, same tack, both upwind.
      if (A.twa < 75 && B.twa < 75 && Math.sign(A.rel) === Math.sign(B.rel)) {
        const wbeam = A.hdg + (A.rel >= 0 ? -90 : 90);    // A's windward side
        const [wx, wy] = unit(wbeam);
        const [hx, hy] = unit(A.hdg);
        const lat = dx * wx + dy * wy;
        const lon = dx * hx + dy * hy;
        if (lat > 1 && lat < 20 && lon > -14 && lon < 6) {
          const s = SHADOW.backwind * strength * Math.exp(-0.5 * ((lat - 8) / 5) ** 2) * Math.exp(-0.5 * ((lon + 3) / 5) ** 2);
          keep *= 1 - s;
        }
      }
    }
    B.loss = Math.min(SHADOW.maxLoss, 1 - keep);
  }
}

// Which boats are hurting B's wind, and by how much (for cues).
export function shadowSources(B, boats) {
  const out = [];
  for (const A of boats) {
    if (A === B || A.done || A.noShadow || A.hidden) continue;
    const dx = B.x - A.x, dy = B.y - A.y;
    if (Math.abs(dx) > SHADOW.range || Math.abs(dy) > SHADOW.range) continue;
    let s = 0;
    const [axv, ayv] = apparentFlow(A);
    const along = dx * axv + dy * ayv;
    if (along > 0) {
      const crossD = Math.abs(dx * ayv - dy * axv);
      const sd = SHADOW.width0 + SHADOW.widthGrow * along;
      const fa = (along / SHADOW.peakDist) * Math.exp(1 - along / SHADOW.peakDist);
      s += SHADOW.peak * (A.ctl?.eased ? 0.5 : 1) * fa * Math.exp(-0.5 * (crossD / sd) ** 2);
    }
    if (A.twa < 75 && B.twa < 75 && Math.sign(A.rel) === Math.sign(B.rel)) {
      const [wx, wy] = unit(A.hdg + (A.rel >= 0 ? -90 : 90));
      const [hx, hy] = unit(A.hdg);
      const lat = dx * wx + dy * wy, lon = dx * hx + dy * hy;
      if (lat > 1 && lat < 20 && lon > -14 && lon < 6) s += SHADOW.backwind * Math.exp(-0.5 * ((lat - 8) / 5) ** 2) * Math.exp(-0.5 * ((lon + 3) / 5) ** 2);
    }
    if (s > 0.004) out.push({ boat: A, loss: s, backwind: along <= 0 });
  }
  return out.sort((a, b) => b.loss - a.loss);
}

// Shadow intensity at an arbitrary point from a set of boats (for drawing).
export function shadowAt(x, y, boats, skip = null) {
  let keep = 1;
  for (const A of boats) {
    if (A === skip || A.done || A.noShadow) continue;
    const dx = x - A.x, dy = y - A.y;
    if (Math.abs(dx) > SHADOW.range || Math.abs(dy) > SHADOW.range) continue;
    const [axv, ayv] = apparentFlow(A);
    const along = dx * axv + dy * ayv;
    if (along <= 0) continue;
    const crossD = Math.abs(dx * ayv - dy * axv);
    const sd = SHADOW.width0 + SHADOW.widthGrow * along;
    const fa = (along / SHADOW.peakDist) * Math.exp(1 - along / SHADOW.peakDist);
    keep *= 1 - SHADOW.peak * (A.ctl.eased ? 0.5 : 1) * fa * Math.exp(-0.5 * (crossD / sd) ** 2);
  }
  return 1 - keep;
}

export { wrap };
