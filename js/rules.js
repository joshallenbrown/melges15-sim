// Right of way, simplified to the part-2 rules that decide a first beat:
//   13  a boat past head-to-wind but not yet close-hauled keeps clear
//   10  on opposite tacks, port keeps clear of starboard
//   11  same tack, overlapped: windward keeps clear
//   12  same tack, not overlapped: clear astern keeps clear
//   44  a boat doing penalty turns keeps clear (rule 21 in spirit)
// Not modelled: 15/16 limits on the right-of-way boat, 17 (proper course),
// 18 mark-room, 19 obstructions. Contact is hull-to-hull within ~1 m.

import { unit, BOAT_LEN } from './geo.js';

export function giveWay(a, b) {
  if (a.ctl.mode === 'penalty' && b.ctl.mode !== 'penalty') return a;
  if (b.ctl.mode === 'penalty' && a.ctl.mode !== 'penalty') return b;
  if (a.r13 && !b.r13) return a;
  if (b.r13 && !a.r13) return b;
  const ta = a.rel >= 0 ? 1 : -1, tb = b.rel >= 0 ? 1 : -1;     // +1 port
  if (ta !== tb) return ta > 0 ? a : b;
  // Same tack. Clear astern? (b's bow behind a's stern, along a's heading)
  const [hx, hy] = unit(a.hdg);
  const lon = (b.x - a.x) * hx + (b.y - a.y) * hy;
  if (lon < -BOAT_LEN) return b;          // b clear astern of a
  if (lon > BOAT_LEN) return a;           // a clear astern of b
  // Overlapped: windward keeps clear. Which side of a is b on?
  const wbeam = a.hdg + (ta > 0 ? -90 : 90);
  const [wx, wy] = unit(wbeam);
  const lat = (b.x - a.x) * wx + (b.y - a.y) * wy;
  return lat > 0 ? b : a;
}

// Gap between two hulls. Each hull is a capsule: a 3.6 m centre segment
// with 0.6 m radius (4.8 m long, 1.2 m wide), so a pointed bow 0.5 m off
// someone's transom is a near miss, not contact. Contact = gap below 0.
export function hullDist(a, b) {
  const [ax, ay] = unit(a.hdg), [bx, by] = unit(b.hdg);
  const h = 1.8;
  return segSeg(a.x - ax * h, a.y - ay * h, a.x + ax * h, a.y + ay * h,
                b.x - bx * h, b.y - by * h, b.x + bx * h, b.y + by * h) - 1.2;
}

function segSeg(x1, y1, x2, y2, x3, y3, x4, y4) {
  if (segsIntersect(x1, y1, x2, y2, x3, y3, x4, y4)) return 0;
  return Math.min(ptSeg(x1, y1, x3, y3, x4, y4), ptSeg(x2, y2, x3, y3, x4, y4),
                  ptSeg(x3, y3, x1, y1, x2, y2), ptSeg(x4, y4, x1, y1, x2, y2));
}
function ptSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / L;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function segsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return false;
  const u = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const v = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

// Closest approach of two boats' centres over the next `horizon` seconds,
// holding course and speed. Returns {t, d}.
export function closestApproach(a, b, horizon = 6) {
  const [ax, ay] = unit(a.hdg), [bx, by] = unit(b.hdg);
  const px = b.x - a.x, py = b.y - a.y;
  const vx = bx * b.v - ax * a.v, vy = by * b.v - ay * a.v;
  const vv = vx * vx + vy * vy;
  let t = vv > 1e-6 ? -(px * vx + py * vy) / vv : 0;
  t = Math.max(0, Math.min(horizon, t));
  return { t, d: Math.hypot(px + vx * t, py + vy * t) };
}

export const CONTACT_M = 0;
