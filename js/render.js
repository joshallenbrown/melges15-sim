// Drawing: the race area seen from above, rotated so the course axis
// (upwind) points up the screen, the way tactics are drawn on a whiteboard.

import { D2R, unit, wrap, norm360, BOAT_LEN, KN } from './geo.js';
import { SHADOW } from './shadow.js';

export class Camera {
  constructor() { this.cx = 0; this.cy = 0; this.scale = 2.0; this.axis = 0; this.follow = true; }
  // world (x east, y north) -> screen px
  toScreen(x, y, W, H) {
    const a = this.axis * D2R, dx = x - this.cx, dy = y - this.cy;
    const xr = dx * Math.cos(a) - dy * Math.sin(a);
    const yr = dx * Math.sin(a) + dy * Math.cos(a);
    return [W / 2 + xr * this.scale, H / 2 - yr * this.scale];
  }
  toWorld(sx, sy, W, H) {
    const a = this.axis * D2R;
    const xr = (sx - W / 2) / this.scale, yr = (H / 2 - sy) / this.scale;
    return [this.cx + xr * Math.cos(a) + yr * Math.sin(a), this.cy - xr * Math.sin(a) + yr * Math.cos(a)];
  }
  screenAngle(hdg) { return (hdg - this.axis) * D2R; }
}

const WATER = [11, 42, 63];
const PUFF = [3, 20, 42];
const LULL = [36, 74, 94];

export function drawScene(ctx, cam, S) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const dpr = S.dpr || 1;
  ctx.save();
  ctx.fillStyle = `rgb(${WATER.join(',')})`;
  ctx.fillRect(0, 0, W, H);
  if (S.wind) drawPressure(ctx, cam, S, W, H, dpr);
  if (S.view === 'coach' && S.wind) drawWindArrows(ctx, cam, S, W, H, dpr);
  drawGrid(ctx, cam, W, H, dpr);
  drawCourse(ctx, cam, S, W, H, dpr);
  if (S.view === 'coach' || S.laylines) drawLaylines(ctx, cam, S, W, H, dpr);
  if (S.view === 'coach') for (const b of S.boats) if (!b.done && !b.hidden) drawShadow(ctx, cam, b, W, H, dpr);
  drawTrails(ctx, cam, S, W, H, dpr);
  for (const b of S.boats) if (!b.hidden) drawWake(ctx, cam, b, W, H, dpr);
  for (const b of S.boats) if (!b.isUser && !b.hidden) drawBoat(ctx, cam, b, S, W, H, dpr);
  for (const b of S.boats) if (b.isUser && !b.hidden) drawBoat(ctx, cam, b, S, W, H, dpr);
  ctx.restore();
}

// Pressure as smooth light/dark water: sampled on a coarse grid into a small
// offscreen image and scaled up with smoothing (no blocky cells).
let PRESS_CANVAS = null;
function drawPressure(ctx, cam, S, W, H, dpr) {
  const cell = 16 * dpr;
  const nx = Math.ceil(W / cell) + 2, ny = Math.ceil(H / cell) + 2;
  PRESS_CANVAS ??= document.createElement('canvas');
  const oc = PRESS_CANVAS;
  if (oc.width !== nx || oc.height !== ny) { oc.width = nx; oc.height = ny; }
  const og = oc.getContext('2d');
  const img = og.createImageData(nx, ny);
  const amp = S.view === 'coach' ? 1 : 0.85;
  const sd = Math.max(0.05, S.wind.p.pressureSd);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [x, y] = cam.toWorld((i - 0.5) * cell, (j - 0.5) * cell, W, H);
      let p = S.wind.pressure(x, y, S.t) / sd;
      if (S.view !== 'coach') p += 0.25 * Math.sin(x * 0.09 + y * 0.07) * Math.cos(x * 0.05 - y * 0.11);
      const k = Math.max(-1, Math.min(1, p / 1.6)) * amp;
      const C = k > 0 ? PUFF : LULL, f = Math.abs(k);
      const o = (j * nx + i) * 4;
      img.data[o] = WATER[0] + (C[0] - WATER[0]) * f;
      img.data[o + 1] = WATER[1] + (C[1] - WATER[1]) * f;
      img.data[o + 2] = WATER[2] + (C[2] - WATER[2]) * f;
      img.data[o + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(oc, -cell, -cell, nx * cell, ny * cell);
  ctx.restore();
  drawRipples(ctx, cam, S, W, H, dpr);
}

// A faint ripple texture that drifts downwind (gives the water some life).
let RIPPLE = null;
function rippleTile() {
  if (RIPPLE) return RIPPLE;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 260; k++) {
    const x = rnd() * 256, y = rnd() * 256, w = 6 + rnd() * 18;
    g.strokeStyle = `rgba(255,255,255,${0.04 + rnd() * 0.08})`;
    g.lineWidth = 0.8 + rnd() * 0.8;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + w / 2, y - 1.5 - rnd() * 2, x + w, y); g.stroke();
    for (const [dx, dy] of [[-256, 0], [256, 0], [0, -256], [0, 256]]) {
      if (x + w > 256 || x < 0 || y < 4 || y > 252) { g.beginPath(); g.moveTo(x + dx, y + dy); g.quadraticCurveTo(x + w / 2 + dx, y - 2 + dy, x + w + dx, y + dy); g.stroke(); }
    }
  }
  RIPPLE = c;
  return c;
}
function drawRipples(ctx, cam, S, W, H, dpr) {
  const pat = ctx.createPattern(rippleTile(), 'repeat');
  if (!pat || !pat.setTransform) return;
  const twd = S.wind ? S.wind.baseDir(S.t) : cam.axis;
  const drift = (S.t * 1.2) % 256;
  const m = new DOMMatrix();
  // ripple crests lie across the wind and drift downwind; scale with the zoom (1 tile ~ 30 m)
  const k = Math.max(0.2, cam.scale * 30 / 256);
  const a = (twd - cam.axis);
  m.translateSelf(W / 2, H / 2).rotateSelf(a).scaleSelf(k, k).translateSelf(0, drift);
  pat.setTransform(m);
  ctx.save();
  ctx.globalAlpha = Math.min(0.7, 0.15 + cam.scale * 0.06);
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function drawWindArrows(ctx, cam, S, W, H, dpr) {
  const step = 90 * dpr;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1.2 * dpr;
  const out = {};
  for (let sy = step / 2; sy < H; sy += step) {
    for (let sx = step / 2; sx < W; sx += step) {
      const [x, y] = cam.toWorld(sx, sy, W, H);
      S.wind.at(x, y, S.t, out);
      const len = (8 + out.tws * 2.6) * dpr;
      const a = cam.screenAngle(out.twd + 180);           // direction the air moves
      const dx = Math.sin(a) * len, dy = -Math.cos(a) * len;
      ctx.beginPath(); ctx.moveTo(sx - dx / 2, sy - dy / 2); ctx.lineTo(sx + dx / 2, sy + dy / 2); ctx.stroke();
      const hx = sx + dx / 2, hy = sy + dy / 2;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - Math.sin(a - 0.4) * 6 * dpr, hy + Math.cos(a - 0.4) * 6 * dpr);
      ctx.lineTo(hx - Math.sin(a + 0.4) * 6 * dpr, hy + Math.cos(a + 0.4) * 6 * dpr);
      ctx.fill();
      ctx.font = `${10 * dpr}px ui-monospace, monospace`;
      ctx.fillText(`${Math.round(norm360(out.twd))}°`, sx + 6 * dpr, sy + 14 * dpr);
    }
  }
}

function drawGrid(ctx, cam, W, H, dpr) {
  // 100 m rings around the camera centre's nearest 100 m, faint
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  const span = Math.max(W, H) / cam.scale;
  const step = span > 2000 ? 500 : 100;
  const x0 = Math.floor((cam.cx - span) / step) * step, y0 = Math.floor((cam.cy - span) / step) * step;
  for (let x = x0; x < cam.cx + span; x += step) {
    const [ax, ay] = cam.toScreen(x, cam.cy - span, W, H), [bx, by] = cam.toScreen(x, cam.cy + span, W, H);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  for (let y = y0; y < cam.cy + span; y += step) {
    const [ax, ay] = cam.toScreen(cam.cx - span, y, W, H), [bx, by] = cam.toScreen(cam.cx + span, y, W, H);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
}

function drawCourse(ctx, cam, S, W, H, dpr) {
  const c = S.course;
  if (!c) return;
  const [px, py] = cam.toScreen(c.pin[0], c.pin[1], W, H);
  const [bx, by] = cam.toScreen(c.boat[0], c.boat[1], W, H);
  ctx.setLineDash([6 * dpr, 6 * dpr]);
  ctx.strokeStyle = S.t < 30 ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(bx, by); ctx.stroke();
  ctx.setLineDash([]);
  // pin
  buoy(ctx, px, py, Math.max(4 * dpr, 0.8 * cam.scale), dpr);
  // committee boat: a rectangle along the line
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(cam.screenAngle(Math.atan2(c.boat[0] - c.pin[0], c.boat[1] - c.pin[1]) / D2R));
  const L = Math.max(16 * dpr, 9 * cam.scale), Bw = Math.max(6 * dpr, 3 * cam.scale);
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 6 * dpr; ctx.shadowOffsetX = 2 * dpr; ctx.shadowOffsetY = 2 * dpr;
  ctx.fillStyle = '#eef1f4';
  ctx.beginPath();
  ctx.moveTo(0, -L / 2); ctx.quadraticCurveTo(Bw / 2, -L / 5, Bw / 2, L / 2); ctx.lineTo(-Bw / 2, L / 2); ctx.quadraticCurveTo(-Bw / 2, -L / 5, 0, -L / 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#b9c3cc'; ctx.fillRect(-Bw * 0.3, -L * 0.05, Bw * 0.6, L * 0.35);
  ctx.fillStyle = '#ff8a1f'; ctx.fillRect(Bw * 0.1, -L * 0.15, Bw * 0.35, Bw * 0.25);
  ctx.restore();
  // windward mark + zone
  const [mx, my] = cam.toScreen(c.mark[0], c.mark[1], W, H);
  ctx.strokeStyle = 'rgba(255,138,31,0.35)';
  ctx.setLineDash([3 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.arc(mx, my, 3 * BOAT_LEN * cam.scale, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  buoy(ctx, mx, my, Math.max(5 * dpr, 0.9 * cam.scale), dpr);
  label(ctx, 'Windward mark', mx + 8 * dpr, my - 8 * dpr, dpr, 'rgba(255,200,150,0.8)');
}

function drawLaylines(ctx, cam, S, W, H, dpr) {
  const c = S.course;
  if (!c || !S.polar) return;
  const twd = S.laylineTwd ?? S.wind?.baseDir(S.t);
  if (twd === undefined) return;
  const th = S.polar.optimal(S.wind ? S.wind.baseTws(S.t) : 7, S.user?.level ?? 0.3).upTwa;
  const len = 1200;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1 * dpr;
  for (const sgn of [-1, 1]) {
    const [ux, uy] = unit(twd + sgn * th + 180);
    const [ax, ay] = cam.toScreen(c.mark[0], c.mark[1], W, H);
    const [bx, by] = cam.toScreen(c.mark[0] + ux * len, c.mark[1] + uy * len, W, H);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
}

function drawShadow(ctx, cam, b, W, H, dpr) {
  if (!b.tws || b.v < 0.3) return;
  const [wx, wy] = unit(b.twd);
  const fx = -wx * b.tws * KN, fy = -wy * b.tws * KN;
  const [hx, hy] = unit(b.hdg);
  let ax = fx - hx * b.v, ay = fy - hy * b.v;
  const m = Math.hypot(ax, ay) || 1; ax /= m; ay /= m;
  const len = 45, w0 = SHADOW.width0, w1 = SHADOW.width0 + SHADOW.widthGrow * len;
  const px = -ay, py = ax;
  const pts = [[b.x + px * w0, b.y + py * w0], [b.x + ax * len + px * w1, b.y + ay * len + py * w1],
               [b.x + ax * len - px * w1, b.y + ay * len - py * w1], [b.x - px * w0, b.y - py * w0]]
    .map(([x, y]) => cam.toScreen(x, y, W, H));
  const [s0x, s0y] = cam.toScreen(b.x, b.y, W, H);
  const [s1x, s1y] = cam.toScreen(b.x + ax * len, b.y + ay * len, W, H);
  const g = ctx.createLinearGradient(s0x, s0y, s1x, s1y);
  g.addColorStop(0, 'rgba(0,0,0,0.0)'); g.addColorStop(0.25, 'rgba(0,0,0,0.22)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(...pts[0]); for (const p of pts.slice(1)) ctx.lineTo(...p); ctx.closePath(); ctx.fill();
}

function drawTrails(ctx, cam, S, W, H, dpr) {
  if (!S.trail) return;
  for (const b of S.boats) {
    if (b.hidden) continue;
    const pts = S.trail(b);
    if (!pts || pts.length < 2) continue;
    const mine = b.isUser;
    if (!mine && S.view !== 'coach' && !S.allTrails) continue;
    ctx.lineWidth = (mine ? 2 : 1) * dpr;
    ctx.strokeStyle = mine ? 'rgba(255,255,255,0.7)' : hexA(b.color, 0.35);
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      if (!p) { started = false; continue; }
      const [sx, sy] = cam.toScreen(p[0], p[1], W, H);
      if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
}

// A short, fading wake behind each boat (longer when fast).
function drawWake(ctx, cam, b, W, H, dpr) {
  if ((b.v || 0) < 0.6) return;
  const [hx, hy] = unit(b.hdg);
  const len = Math.min(14, 2 + b.v * 3);                       // metres: a dinghy's wake is short
  const [sx, sy] = cam.toScreen(b.x - hx * 2.2, b.y - hy * 2.2, W, H);
  if (sx < -200 || sy < -200 || sx > W + 200 || sy > H + 200) return;
  const [ex, ey] = cam.toScreen(b.x - hx * (2.2 + len), b.y - hy * (2.2 + len), W, H);
  const w0 = Math.max(1 * dpr, 0.7 * cam.scale), w1 = Math.max(2 * dpr, 1.6 * cam.scale);
  const px = -(ey - sy), py = ex - sx;
  const m = Math.hypot(px, py) || 1;
  const nx = px / m, ny = py / m;
  const g = ctx.createLinearGradient(sx, sy, ex, ey);
  g.addColorStop(0, 'rgba(235,245,255,0.22)'); g.addColorStop(1, 'rgba(235,245,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(sx + nx * w0, sy + ny * w0); ctx.lineTo(ex + nx * w1, ey + ny * w1);
  ctx.lineTo(ex - nx * w1, ey - ny * w1); ctx.lineTo(sx - nx * w0, sy - ny * w0);
  ctx.closePath(); ctx.fill();
}

export function drawBoat(ctx, cam, b, S, W, H, dpr) {
  const [sx, sy] = cam.toScreen(b.x, b.y, W, H);
  if (sx < -60 || sy < -60 || sx > W + 60 || sy > H + 60) return;
  const minPx = 14 * dpr;
  const k = Math.max(cam.scale, minPx / BOAT_LEN);        // px per metre for the hull
  const L = BOAT_LEN * k, B = 1.8 * k;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(cam.screenAngle(b.hdg));
  ctx.globalAlpha = (b.isGhost ? 0.55 : b.done ? 0.45 : 1) * (b.est === 2 ? 0.5 : 1);   // est 2: long tracker dropout, position guessed
  const hull = new Path2D();
  hull.moveTo(0, -L / 2);
  hull.quadraticCurveTo(B / 2, -L / 6, B * 0.42, L / 2);
  hull.lineTo(-B * 0.42, L / 2);
  hull.quadraticCurveTo(-B / 2, -L / 6, 0, -L / 2);
  // soft shadow on the water
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 5 * dpr; ctx.shadowOffsetX = 2 * dpr; ctx.shadowOffsetY = 2 * dpr;
  const col = b.color || '#ccc';
  ctx.fillStyle = col;
  ctx.fill(hull);
  ctx.shadowColor = 'transparent';
  // deck highlight: white deck inside coloured topsides
  const deck = new Path2D();
  deck.moveTo(0, -L / 2 + 0.08 * L);
  deck.quadraticCurveTo(B * 0.38, -L / 6, B * 0.33, L / 2 - 0.04 * L);
  deck.lineTo(-B * 0.33, L / 2 - 0.04 * L);
  deck.quadraticCurveTo(-B * 0.38, -L / 6, 0, -L / 2 + 0.08 * L);
  ctx.fillStyle = b.isUser ? '#dfe6ee' : 'rgba(240,244,248,0.92)';
  ctx.fill(deck);
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = b.isUser ? '#000' : 'rgba(0,0,0,0.55)';
  ctx.stroke(hull);
  // crew on the windward rail when zoomed in
  const twa = b.twa ?? 45;
  const side = (b.rel ?? 1) >= 0 ? 1 : -1;               // port tack: sails to starboard (+x), crew to port (-x)
  if (k > 5 && !b.isGhost) {
    ctx.fillStyle = 'rgba(25,35,50,0.95)';
    const cxw = -side * B * (twa < 110 ? 0.5 : 0.3);
    for (const y of [0.1 * L, 0.27 * L]) { ctx.beginPath(); ctx.arc(cxw, y, 0.22 * k, 0, 7); ctx.fill(); }
  }
  // sails: curved (cambered) main from the mast, jib from the bow
  const mastY = -L / 2 + 0.35 * L;
  let ang = Math.max(6, Math.min(80, twa * 0.5));
  const flapping = b.ctl?.eased || b.ctl?.stop || b.ctl?.mode === 'tack' || b.ctl?.mode === 'penalty' || twa < 25;
  if (flapping) ang = b.ctl?.mode === 'tack' || twa < 25 ? 0 : Math.min(85, ang + 35);
  const sail = (x0, y0, len, a, depth) => {
    const ex = x0 + Math.sin(a * D2R) * len * side, ey = y0 + Math.cos(a * D2R) * len;
    const mx = (x0 + ex) / 2, my = (y0 + ey) / 2;
    const nx = (ey - y0) / len * side, ny = -(ex - x0) / len * side;   // to leeward of the chord
    const p = new Path2D();
    p.moveTo(x0, y0);
    p.quadraticCurveTo(mx + nx * depth * len * (flapping ? 0.2 : 1), my + ny * depth * len * (flapping ? 0.2 : 1), ex, ey);
    p.closePath();
    return p;
  };
  const jib = sail(0, -L / 2 + 0.04 * L, 0.42 * L, ang * 0.8, 0.22);
  const main = sail(0, mastY, 0.62 * L, ang, 0.2);
  for (const p of [jib, main]) {
    ctx.fillStyle = flapping ? 'rgba(235,240,245,0.6)' : 'rgba(250,252,255,0.93)';
    ctx.fill(p);
    ctx.strokeStyle = 'rgba(120,135,150,0.9)'; ctx.lineWidth = 1 * dpr;
    if (flapping) ctx.setLineDash([3 * dpr, 2 * dpr]);
    ctx.stroke(p);
    ctx.setLineDash([]);
  }
  ctx.fillStyle = '#333';
  ctx.beginPath(); ctx.arc(0, mastY, Math.max(1.2 * dpr, 0.08 * k), 0, 7); ctx.fill();
  ctx.restore();
  if (b.isUser) {
    ctx.strokeStyle = 'rgba(79,179,255,0.9)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.arc(sx, sy, L * 0.85, 0, Math.PI * 2); ctx.stroke();
  }
  const showLabel = b.isUser || S.view === 'coach' || cam.scale > 3 || S.labels;
  if (showLabel) {
    let txt = b.sail;
    if (b.ocs && !b.ocsCleared) txt += ' OCS';
    if (b.ctl?.mode === 'penalty') txt += ' ⟳';
    if (b.roundRank) txt += ` #${b.roundRank}`;
    label(ctx, txt, sx + L * 0.6, sy - L * 0.6, dpr, b.ocs && !b.ocsCleared ? '#ff7070' : b.isUser ? '#fff' : 'rgba(255,255,255,0.75)');
  }
}

function buoy(ctx, x, y, r, dpr) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4 * dpr; ctx.shadowOffsetX = 1.5 * dpr; ctx.shadowOffsetY = 1.5 * dpr;
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  g.addColorStop(0, '#ffc08a'); g.addColorStop(0.5, '#ff7a1a'); g.addColorStop(1, '#c4520a');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function dot(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
function label(ctx, txt, x, y, dpr, color) {
  ctx.font = `600 ${11 * dpr}px -apple-system, sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(txt, x + 1, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(txt, x, y);
}
function hexA(hex, a) {
  if (!hex || hex[0] !== '#') return `rgba(200,200,200,${a})`;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ------------------------------------------------------------ shift chart
// series: [{pts:[[t,deg]...], color, width, dots}] ; marks: [{t, color}]
export function drawChart(ctx, opts) {
  const W = ctx.canvas.width, H = ctx.canvas.height, dpr = opts.dpr || 1;
  ctx.clearRect(0, 0, W, H);
  const padL = 46 * dpr, padR = 10 * dpr, padT = 14 * dpr, padB = 16 * dpr;
  const all = opts.series.flatMap(s => s.pts.filter(Boolean));
  if (!all.length) {
    ctx.fillStyle = 'rgba(232,238,245,0.4)';
    ctx.font = `${12 * dpr}px -apple-system, sans-serif`;
    ctx.fillText(opts.empty || 'Wind history appears here.', padL, H / 2);
    return;
  }
  const t0 = opts.t0 ?? Math.min(...all.map(p => p[0])), t1 = opts.t1 ?? Math.max(...all.map(p => p[0]));
  const ref = opts.ref ?? all[0][1];
  const lin = !!opts.linear;                     // plain numbers (metres), not compass degrees
  const dv = (v) => lin ? v - ref : wrap(v - ref);
  const devs = all.map(p => dv(p[1]));
  let lo = Math.min(...devs, -6), hi = Math.max(...devs, 6);
  const padD = (hi - lo) * 0.1; lo -= padD; hi += padD;
  const X = (t) => padL + (t - t0) / Math.max(1, t1 - t0) * (W - padL - padR);
  const Y = (d) => padT + (hi - d) / (hi - lo) * (H - padT - padB);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(232,238,245,0.45)';
  ctx.font = `${10 * dpr}px ui-monospace, monospace`;
  const span = hi - lo;
  const stepD = lin ? (span > 300 ? 100 : span > 120 ? 50 : span > 50 ? 20 : 10) : (span > 30 ? 10 : 5);
  for (let d = Math.ceil(lo / stepD) * stepD; d <= hi; d += stepD) {
    ctx.strokeStyle = lin && d === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(padL, Y(d)); ctx.lineTo(W - padR, Y(d)); ctx.stroke();
    ctx.fillText(lin ? `${d > 0 ? '+' : ''}${d} m` : `${Math.round(norm360(ref + d))}°`, 4 * dpr, Y(d) + 3 * dpr);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  const stepT = (t1 - t0) > 900 ? 120 : 60;
  for (let t = Math.ceil(t0 / stepT) * stepT; t <= t1; t += stepT) {
    ctx.beginPath(); ctx.moveTo(X(t), padT); ctx.lineTo(X(t), H - padB); ctx.stroke();
    const s = Math.abs(t);
    ctx.fillText(`${t < 0 ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, X(t) + 2 * dpr, H - 3 * dpr);
  }
  for (const m of opts.marks || []) {
    ctx.strokeStyle = m.color; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(X(m.t), padT); ctx.lineTo(X(m.t), H - padB); ctx.stroke();
  }
  for (const s of opts.series) {
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = (s.width || 1.5) * dpr;
    if (s.dash) ctx.setLineDash(s.dash.map(v => v * dpr));
    if (s.dots) {
      for (const p of s.pts) if (p) { ctx.beginPath(); ctx.arc(X(p[0]), Y(dv(p[1])), 1.6 * dpr, 0, 7); ctx.fill(); }
    } else {
      ctx.beginPath();
      let on = false;
      for (const p of s.pts) {
        if (!p) { on = false; continue; }
        const x = X(p[0]), y = Y(dv(p[1]));
        if (!on) { ctx.moveTo(x, y); on = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  if (opts.cursor !== undefined) {
    ctx.strokeStyle = 'rgba(79,179,255,0.9)'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(X(opts.cursor), padT); ctx.lineTo(X(opts.cursor), H - padB); ctx.stroke();
  }
  // legend
  let lx = padL + 4 * dpr;
  for (const s of opts.series) {
    if (!s.label) continue;
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 3 * dpr, 10 * dpr, 3 * dpr);
    ctx.fillStyle = 'rgba(232,238,245,0.7)';
    ctx.fillText(s.label, lx + 14 * dpr, 9 * dpr);
    lx += ctx.measureText(s.label).width + 30 * dpr;
  }
}
