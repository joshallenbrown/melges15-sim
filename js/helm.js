// Helm view: what you see from the cockpit. Eye ~1.1 m above the water,
// ~100 deg field of view, looking along your heading (Q/E to look around).
// Puffs are darker water that fades with distance; boats are sails on the
// water at true size; the start line is NOT drawn (sight the pin and the
// committee boat); the windward mark is a small orange buoy.

import { D2R, unit, norm360, wrap, bearing, BOAT_LEN } from './geo.js';

const EYE = 1.1;          // m, helm's eye above the water
export const FOV = 115;   // deg, horizontal
const MAST = 6.2;         // m, approx. rig height
export const PANO_H = 62; // px (css) height of the 360° strip at the bottom

export function drawHelm(ctx, S) {
  const W = ctx.canvas.width, H = ctx.canvas.height, dpr = S.dpr || 1;
  const u = S.user;
  const L = norm360(u.hdg + (S.look || 0));
  const fx = Math.sin(L * D2R), fy = Math.cos(L * D2R);
  const rx = fy, ry = -fx;                                  // right of the view direction
  const [hx, hy] = unit(u.hdg);
  const cx = u.x - hx * 1.2, cy = u.y - hy * 1.2;           // helm sits ~1.2 m aft of centre
  const focal = (W / 2) / Math.tan(FOV / 2 * D2R);
  const hz = H * 0.40;
  const P = (x, y, z) => {
    const dx = x - cx, dy = y - cy;
    const f = dx * fx + dy * fy;
    if (f < 0.25) return null;
    const l = dx * rx + dy * ry;
    return [W / 2 + l / f * focal, hz + (EYE - z) / f * focal, f];
  };
  const env = { P, focal, dpr, W, H, hz };

  // sky and water
  const g = ctx.createLinearGradient(0, 0, 0, hz);
  g.addColorStop(0, '#7fb0d6'); g.addColorStop(1, '#dbe7ef');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, hz + 1);
  const gw = ctx.createLinearGradient(0, hz, 0, H);
  gw.addColorStop(0, '#8aa3b3'); gw.addColorStop(0.06, '#4a7590'); gw.addColorStop(0.35, '#2b5a78'); gw.addColorStop(1, '#173f5a');
  ctx.fillStyle = gw; ctx.fillRect(0, hz, W, H - hz);
  if (S.wind && S.wind.p.pressureSd > 0) drawWater(ctx, env, S, cx, cy, L);

  // everything on the water, far to near
  const items = [];
  const c = S.course;
  if (c) {
    items.push({ d: dist(c.mark, cx, cy), draw: () => buoy(ctx, env, c.mark, 0.75, 1.6, '#ff7a1a') });
    items.push({ d: dist(c.pin, cx, cy), draw: () => { buoy(ctx, env, c.pin, 0.5, 1.2, '#ff7a1a'); flagPole(ctx, env, c.pin, 2.6, '#ffd21a'); } });
    items.push({ d: dist(c.boat, cx, cy), draw: () => committeeBoat(ctx, env, c) });
  }
  for (const b of S.boats) {
    if (b === u || b.isUser || b.hidden) continue;
    const d = Math.hypot(b.x - cx, b.y - cy);
    if (d > 1500) continue;
    items.push({ d, draw: () => sailboat(ctx, env, b, d, S) });
  }
  items.sort((a, b) => b.d - a.d);
  for (const it of items) it.draw();

  ownBoat(ctx, env, u);
  drawHelmOverlay(ctx, S);
}

// On top of the 2D or the 3D helm view: 360° strip, mini-map, look label.
export function drawHelmOverlay(ctx, S) {
  const W = ctx.canvas.width, H = ctx.canvas.height, dpr = S.dpr || 1;
  const u = S.user;
  drawPanorama(ctx, S, u, dpr);
  if (S.minimap) drawMiniMap(ctx, S, u, dpr);
  if (Math.abs(S.look || 0) > 4) {
    ctx.font = `600 ${13 * dpr}px -apple-system, sans-serif`;
    const txt = `Looking ${Math.abs(Math.round(S.look))}° ${S.look < 0 ? 'left' : 'right'}${Math.abs(S.look) > 150 ? ' (behind you)' : ''} · F = back to the bow`;
    const tw = ctx.measureText(txt).width, ty = H - (PANO_H + 18) * dpr;
    ctx.fillStyle = 'rgba(8,16,26,0.7)'; ctx.fillRect(W / 2 - tw / 2 - 8 * dpr, ty - 15 * dpr, tw + 16 * dpr, 21 * dpr);
    ctx.fillStyle = '#e8eef5'; ctx.fillText(txt, W / 2 - tw / 2, ty);
  }
}

function dist(p, cx, cy) { return Math.hypot(p[0] - cx, p[1] - cy); }

// Pressure on the water: darker ripples in puffs, glassy patches in lulls,
// harder to read the further away they are.
function drawWater(ctx, env, S, cx, cy, L) {
  const { P } = env;
  const sd = Math.max(0.05, S.wind.p.pressureSd);
  const rings = [];
  for (let r = 4; r < 700; r *= 1.16) rings.push(r);
  const half = FOV / 2 + 6;
  for (let a = -half; a < half; a += 3) {
    const d0 = (L + a) * D2R, d1 = (L + a + 3) * D2R;
    const s0 = Math.sin(d0), c0 = Math.cos(d0), s1 = Math.sin(d1), c1 = Math.cos(d1);
    for (let k = 0; k < rings.length - 1; k++) {
      const r0 = rings[k], r1 = rings[k + 1], rm = (r0 + r1) / 2;
      const dm = (L + a + 1.5) * D2R;
      const p = S.wind.pressure(cx + Math.sin(dm) * rm, cy + Math.cos(dm) * rm, S.t) / sd;
      const vis = Math.min(1, 1.7 * Math.exp(-rm / 190));
      const kk = Math.max(-1, Math.min(1, p / 1.5)) * vis;
      if (Math.abs(kk) < 0.06) continue;
      const q = [P(cx + s0 * r0, cy + c0 * r0, 0), P(cx + s1 * r0, cy + c1 * r0, 0), P(cx + s1 * r1, cy + c1 * r1, 0), P(cx + s0 * r1, cy + c0 * r1, 0)];
      if (q.some(v => !v)) continue;
      ctx.fillStyle = kk > 0 ? `rgba(6,30,52,${0.65 * kk})` : `rgba(160,192,210,${-0.5 * kk})`;
      ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]);
      for (let j = 1; j < 4; j++) ctx.lineTo(q[j][0], q[j][1]);
      ctx.closePath(); ctx.fill();
    }
  }
}

function poly(ctx, pts, fill, stroke, lw = 1) {
  if (pts.some(p => !p)) return false;
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  return true;
}

function haze(d) { return Math.max(0.35, 1 - d / 2200); }

function sailboat(ctx, env, b, d, S) {
  const { P, focal, dpr } = env;
  const [hx, hy] = unit(b.hdg);
  const sx = hy, sy = -hx;                                   // boat's starboard side
  const pt = (along, side, z) => P(b.x + hx * along + sx * side, b.y + hy * along + sy * side, z);
  const a = haze(d) * (b.isGhost ? 0.55 : 1);
  ctx.globalAlpha = a;
  // topsides in the boat's colour (waterline outline), white deck on top
  poly(ctx, [pt(2.3, 0, 0.05), pt(0.8, 0.8, 0.0), pt(-2.25, 0.7, 0.0), pt(-2.25, -0.7, 0.0), pt(0.8, -0.8, 0.0)], b.color || '#888', null);
  poly(ctx, [pt(2.3, 0, 0.4), pt(0.8, 0.85, 0.42), pt(-2.3, 0.75, 0.36), pt(-2.3, -0.75, 0.36), pt(0.8, -0.85, 0.42)], '#e3e8ec', 'rgba(0,0,0,0.3)', 1);
  const leeward = (b.rel ?? 1) >= 0 ? 1 : -1;               // port tack: sails to starboard
  const twa = b.twa ?? 45;
  const flap = b.ctl?.eased || b.ctl?.mode === 'tack' || b.ctl?.mode === 'penalty' || twa < 25;
  let ang = Math.max(6, Math.min(80, twa * 0.5)) * D2R;
  if (flap) ang = Math.min(85, twa * 0.5 + 30) * D2R;
  const boom = 2.7;
  const main = [pt(0.7, 0, MAST), pt(0.7, 0, 0.9), pt(0.7 - Math.cos(ang) * boom, leeward * Math.sin(ang) * boom, 0.9)];
  const jib = [pt(2.2, 0, 0.6), pt(0.75, 0, MAST * 0.72), pt(2.2 - Math.cos(ang * 0.8) * 1.9, leeward * Math.sin(ang * 0.8) * 1.1, 0.6)];
  const sail = flap ? 'rgba(235,240,245,0.75)' : 'rgba(250,252,255,0.95)';
  // draw the sail further from us first
  const order = (Math.hypot(b.x - S.user.x, b.y - S.user.y) > 0 && main[1] && jib[0] && main[1][2] > jib[0][2]) ? [main, jib] : [jib, main];
  for (const s of order) poly(ctx, s, sail, 'rgba(120,135,150,0.8)', 0.8 * dpr);
  if (d < 85 && main.every(Boolean)) {
    const px = (main[0][0] + main[1][0] + main[2][0]) / 3, py = (main[0][1] + main[1][1] * 2 + main[2][1]) / 4;
    const fs = Math.max(7 * dpr, Math.min(28 * dpr, 0.9 / d * focal));
    ctx.font = `700 ${fs}px -apple-system, sans-serif`;
    ctx.fillStyle = 'rgba(20,30,45,0.85)';
    const txt = b.sail.replace(' (real)', '');
    ctx.fillText(txt, px - ctx.measureText(txt).width / 2, py);
  }
  ctx.globalAlpha = 1;
}

function buoy(ctx, env, p, r, h, color) {
  const { P, focal, dpr } = env;
  const base = P(p[0], p[1], 0), top = P(p[0], p[1], h);
  if (!base || !top) return;
  const w = Math.max(2 * dpr, 2 * r / base[2] * focal);
  const hgt = Math.max(3 * dpr, base[1] - top[1]);
  ctx.fillStyle = color;
  ctx.fillRect(base[0] - w / 2, base[1] - hgt, w, hgt);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(base[0], base[1] - hgt, w / 2, hgt);
}

function flagPole(ctx, env, p, h, color) {
  const { P, dpr } = env;
  const base = P(p[0], p[1], 1), top = P(p[0], p[1], h);
  if (!base || !top) return;
  ctx.strokeStyle = '#333'; ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath(); ctx.moveTo(base[0], base[1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
  const fw = Math.max(3 * dpr, (base[1] - top[1]) * 0.35);
  ctx.fillStyle = color; ctx.fillRect(top[0], top[1], fw, fw * 0.7);
}

function committeeBoat(ctx, env, c) {
  const { P } = env;
  const dx = c.boat[0] - c.pin[0], dy = c.boat[1] - c.pin[1];
  const m = Math.hypot(dx, dy) || 1;
  const ax = dx / m, ay = dy / m;                            // along the line
  const nx = -ay, ny = ax;
  const at = (along, side, z) => P(c.boat[0] + ax * along + nx * side, c.boat[1] + ay * along + ny * side, z);
  poly(ctx, [at(-1, -4.5, 0.9), at(1.4, -3.5, 1.0), at(1.4, 3.5, 1.0), at(-1, 4.5, 0.9), at(-1.4, 3.5, 0.9), at(-1.4, -3.5, 0.9)], '#eef1f4', 'rgba(0,0,0,0.4)', 1);
  poly(ctx, [at(-0.9, -1.5, 2.4), at(0.9, -1.5, 2.4), at(0.9, 1.5, 2.4), at(-0.9, 1.5, 2.4)], '#c8d0d8', 'rgba(0,0,0,0.3)', 1);
  const base = at(0, 0, 2.4), top = at(0, 0, 6);
  if (base && top) {
    ctx.strokeStyle = '#444'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(base[0], base[1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
    const fw = Math.max(4, (base[1] - top[1]) * 0.3);
    ctx.fillStyle = '#ff7a1a'; ctx.fillRect(top[0], top[1], fw, fw * 0.7);
  }
}

function ownBoat(ctx, env, u) {
  const { P, W, H, dpr } = env;
  const [hx, hy] = unit(u.hdg);
  const sx = hy, sy = -hx;
  const pt = (along, side, z) => P(u.x + hx * along + sx * side, u.y + hy * along + sy * side, z);
  const bow = pt(2.3, 0, 0.35), sp = pt(0.6, 0.88, 0.45), pp = pt(0.6, -0.88, 0.45);
  const sn = pt(-0.6, 0.9, 0.5), pn = pt(-0.6, -0.9, 0.5);
  if (bow && sp && pp && sn && pn) {
    poly(ctx, [bow, sp, sn, [sn[0], H], [pn[0], H], pn, pp], '#e6ebef', 'rgba(40,50,60,0.6)', 1.5 * dpr);
    // mast
    const mb = pt(0.7, 0, 0.5), mt = pt(0.7, 0, 9);
    if (mb && mt) { ctx.strokeStyle = 'rgba(60,70,80,0.9)'; ctx.lineWidth = 4 * dpr; ctx.beginPath(); ctx.moveTo(mb[0], mb[1]); ctx.lineTo(mt[0], Math.max(-10, mt[1])); ctx.stroke(); }
    // jib: see-through, so you can look under/through it for boats to leeward
    const leeward = u.rel >= 0 ? 1 : -1;
    const ang = Math.max(6, Math.min(80, u.twa * 0.5)) * D2R * 0.8;
    const jib = [pt(2.2, 0, 0.6), pt(0.75, 0, MAST * 0.72), pt(2.2 - Math.cos(ang) * 1.9, leeward * Math.sin(ang) * 1.1, 0.6)];
    poly(ctx, jib, 'rgba(255,255,255,0.22)', 'rgba(255,255,255,0.6)', 1.5 * dpr);
  }
}


// 360° strip: everything around you at its bearing, bow in the middle,
// astern at the ends. Stands in for glancing around and peripheral vision.
// The bright window is where the main view is looking. Click it to look there.
export function panoramaRect(W, H, dpr) {
  const x0 = 262 * dpr, x1 = W - 10 * dpr;
  const h = PANO_H * dpr;
  return { x0, x1, y0: H - h - 8 * dpr, h };
}

function drawPanorama(ctx, S, u, dpr) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const { x0, x1, y0, h } = panoramaRect(W, H, dpr);
  const w = x1 - x0;
  const X = (rb) => x0 + (wrap(rb) + 180) / 360 * w;
  const hz = y0 + h * 0.62;
  ctx.save();
  ctx.fillStyle = 'rgba(8,16,26,0.78)';
  ctx.fillRect(x0, y0, w, h);
  // sky / water halves
  ctx.fillStyle = 'rgba(127,176,214,0.18)'; ctx.fillRect(x0, y0, w, hz - y0);
  ctx.fillStyle = 'rgba(30,70,95,0.35)'; ctx.fillRect(x0, hz, w, y0 + h - hz);
  // where the main view is looking
  const look = S.look || 0, half = FOV / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  const a = X(look - half), b = X(look + half);
  if (a < b) ctx.fillRect(a, y0, b - a, h); else { ctx.fillRect(x0, y0, b - x0, h); ctx.fillRect(a, y0, x1 - a, h); }
  // bearing ticks
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
  ctx.font = `${9 * dpr}px ui-monospace, monospace`; ctx.fillStyle = 'rgba(232,238,245,0.55)';
  for (const [rb, lab] of [[-180, 'astern'], [-90, 'port beam'], [0, 'bow'], [90, 'stbd beam'], [180, '']]) {
    const x = X(rb === 180 ? 179.9 : rb);
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); ctx.stroke();
    if (lab) ctx.fillText(lab, Math.min(x + 3 * dpr, x1 - 50 * dpr), y0 + 10 * dpr);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.moveTo(x0, hz); ctx.lineTo(x1, hz); ctx.stroke();
  // things on the water, far first; size falls off with distance
  const items = [];
  const rel = (x, y) => wrap(bearing(x - u.x, y - u.y) - u.hdg);
  const c = S.course;
  if (c) {
    items.push({ d: Math.hypot(c.boat[0] - u.x, c.boat[1] - u.y), rb: rel(c.boat[0], c.boat[1]), kind: 'rc' });
    items.push({ d: Math.hypot(c.pin[0] - u.x, c.pin[1] - u.y), rb: rel(c.pin[0], c.pin[1]), kind: 'pin' });
    items.push({ d: Math.hypot(c.mark[0] - u.x, c.mark[1] - u.y), rb: rel(c.mark[0], c.mark[1]), kind: 'mark' });
  }
  for (const o of S.boats) {
    if (o === u || o.isUser || o.hidden) continue;
    const d = Math.hypot(o.x - u.x, o.y - u.y);
    if (d > 1200) continue;
    items.push({ d, rb: rel(o.x, o.y), kind: 'boat', o });
  }
  items.sort((p, q) => q.d - p.d);
  let lastLabel = null;
  for (const it of items) {
    const x = X(it.rb);
    const k = Math.max(0.12, Math.min(1, 40 / Math.max(it.d, 1)));     // 1 at 40 m, small far away
    if (it.kind === 'boat') {
      const sh = (6 + 34 * k) * dpr, sw = sh * 0.45;
      ctx.globalAlpha = it.o.isGhost ? 0.6 : 1;
      ctx.fillStyle = it.o.color || '#ccc';
      ctx.fillRect(x - sw * 0.6, hz - 1.5 * dpr, sw * 1.2, Math.max(2 * dpr, 4 * k * dpr));
      ctx.fillStyle = 'rgba(245,248,252,0.95)';
      ctx.beginPath(); ctx.moveTo(x, hz - sh); ctx.lineTo(x + sw * 0.5, hz - 2 * dpr); ctx.lineTo(x - sw * 0.5, hz - 2 * dpr); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      if (it.d < 90 && (lastLabel === null || Math.abs(x - lastLabel) > 26 * dpr)) {
        ctx.fillStyle = 'rgba(232,238,245,0.85)';
        ctx.fillText(it.o.sail.replace(' (real)', '*'), x - 8 * dpr, y0 + h - 3 * dpr);
        lastLabel = x;
      }
    } else if (it.kind === 'rc') {
      const bw = (10 + 26 * k) * dpr, bh = (3 + 8 * k) * dpr;
      ctx.fillStyle = '#dfe5ea'; ctx.fillRect(x - bw / 2, hz - bh, bw, bh);
      ctx.fillStyle = '#ff7a1a'; ctx.fillRect(x, hz - bh - (8 + 10 * k) * dpr, (5 + 5 * k) * dpr, (4 + 4 * k) * dpr);
      ctx.fillStyle = 'rgba(232,238,245,0.85)'; ctx.fillText('RC', x - 6 * dpr, y0 + h - 3 * dpr);
    } else {
      const r = (2 + 5 * k) * dpr;
      ctx.fillStyle = '#ff7a1a';
      ctx.beginPath(); ctx.arc(x, hz - r, r, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,200,150,0.9)'; ctx.fillText(it.kind === 'pin' ? 'pin' : 'mark', x - 8 * dpr, y0 + h - 3 * dpr);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.strokeRect(x0, y0, w, h);
  ctx.restore();
}

// Optional (M): the picture in your head from looking around: boats and
// marks within 250 m, bow up. No wind, no line, no laylines.
function drawMiniMap(ctx, S, u, dpr) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const R = 95 * dpr, range = 250;
  const cx = W - R - 14 * dpr, cy = H - PANO_H * dpr - R - 24 * dpr;
  const k = R / range;
  const toXY = (x, y) => {
    const dx = x - u.x, dy = y - u.y;
    const a = -u.hdg * D2R;                                   // rotate so the bow points up
    const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
    return [cx + rx * k, cy - ry * k, Math.hypot(rx, ry)];
  };
  ctx.save();
  ctx.fillStyle = 'rgba(8,16,26,0.72)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.beginPath(); ctx.arc(cx, cy, R / 2, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.stroke();
  ctx.font = `${9 * dpr}px ui-monospace, monospace`; ctx.fillStyle = 'rgba(232,238,245,0.5)';
  ctx.fillText('125 m', cx + 2 * dpr, cy - R / 2 - 2 * dpr);
  const edge = (x, y, color, lab) => {
    let [px, py, d] = toXY(x, y);
    if (d * k > R - 4 * dpr) { const f = (R - 6 * dpr) / (d * k); px = cx + (px - cx) * f; py = cy + (py - cy) * f; }
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px, py, 3.5 * dpr, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(232,238,245,0.75)';
    const lw = ctx.measureText(lab).width;
    ctx.fillText(lab, px + 4 * dpr + lw > cx + R ? px - lw - 4 * dpr : px + 4 * dpr, py - 3 * dpr);
  };
  const c = S.course;
  if (c) { edge(c.boat[0], c.boat[1], '#dfe5ea', 'RC'); edge(c.pin[0], c.pin[1], '#ff7a1a', 'pin'); edge(c.mark[0], c.mark[1], '#ff7a1a', 'mark'); }
  for (const o of S.boats) {
    if (o === u || o.isUser || o.hidden) continue;
    const [px, py, d] = toXY(o.x, o.y);
    if (d > range) continue;
    const a = (o.hdg - u.hdg) * D2R;
    ctx.save(); ctx.translate(px, py); ctx.rotate(a);
    ctx.fillStyle = o.color || '#ccc'; ctx.globalAlpha = o.isGhost ? 0.6 : 1;
    ctx.beginPath(); ctx.moveTo(0, -5 * dpr); ctx.lineTo(3 * dpr, 4 * dpr); ctx.lineTo(-3 * dpr, 4 * dpr); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(cx, cy - 7 * dpr); ctx.lineTo(cx + 4 * dpr, cy + 5 * dpr); ctx.lineTo(cx - 4 * dpr, cy + 5 * dpr); ctx.closePath(); ctx.fill();
  ctx.restore();
}
