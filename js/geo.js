// Angle and vector helpers. Conventions used everywhere:
//   x = metres east, y = metres north
//   headings are compass degrees (0 = north, 90 = east)
//   TWD = the direction the wind comes FROM
//   rel = wrap(heading - TWD): positive = port tack, negative = starboard
//   TWA = |rel|

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const KN = 0.514444;           // metres per second per knot
export const BOAT_LEN = 4.6;          // Melges 15, metres

export function wrap(a) {             // to (-180, 180]
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}
export function norm360(a) { return ((a % 360) + 360) % 360; }
export function unit(deg) { return [Math.sin(deg * D2R), Math.cos(deg * D2R)]; }
export function bearing(dx, dy) { return norm360(Math.atan2(dx, dy) * R2D); }
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, f) { return a + (b - a) * f; }

// Upwind progress (metres) of point (x, y) along the wind axis `axisDeg`.
export function upwind(x, y, axisDeg) {
  const [ux, uy] = unit(axisDeg);
  return x * ux + y * uy;
}
// Cross-course offset: + = right of the axis, facing upwind.
export function cross(x, y, axisDeg) {
  const [ux, uy] = unit(axisDeg);
  return x * uy - y * ux;
}

// Circular mean of a list of degrees.
export function circMean(arr) {
  let s = 0, c = 0;
  for (const a of arr) { s += Math.sin(a * D2R); c += Math.cos(a * D2R); }
  return norm360(Math.atan2(s, c) * R2D);
}
