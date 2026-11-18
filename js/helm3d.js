// 3D helm view (WebGL via three.js): what you see from the windward side of
// the cockpit. Real hulls that heel to leeward, cambered sails with sail
// numbers, crew hiking on the rail, a reflective sea whose ripples follow the
// wind, with puffs as darker ruffled water and lulls glassy, plus sky, sun and
// haze. The 360° strip and mini-map are drawn on top by helm.js.
//
// Coordinates: sim x = east, y = north  ->  three X = x, Z = -y, Y = up.
// A heading h (compass deg) is a yaw of -h about +Y (boat bow = -Z).

import * as THREE from 'three';
import { D2R, wrap, unit } from './geo.js';
import { FOV } from './helm.js';

const SUN = new THREE.Vector3(-0.55, 0.62, 0.56).normalize();   // afternoon sun, south-west
const ZENITH = new THREE.Color('#3a78c0');
const HORIZON = new THREE.Color('#a6c4da');
const DEEP = new THREE.Color('#0a2f4a');
const MID = new THREE.Color('#1d5878');
const MAST_Z = -0.7;          // mast 1.6 m aft of the bow
const PRESS_N = 64, PRESS_SIZE = 1600;

export class Helm3D {
  constructor(stage) {
    this.ok = false;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (e) { console.warn('WebGL unavailable', e); return; }
    const r = this.renderer;
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.domElement.id = 'view3d';
    stage.insertBefore(r.domElement, stage.firstChild);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(HORIZON.clone(), 1500, 7000);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.08, 9000);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(new THREE.HemisphereLight('#cfe3f5', '#24485c', 1.1));
    const sun = new THREE.DirectionalLight('#fff3df', 2.4);
    sun.position.copy(SUN).multiplyScalar(100);
    this.scene.add(sun);
    this._sky();
    this._water();
    this.hull = buildHull();
    this.boats = new Map();
    this.courseObj = null;
    this.courseKey = '';
    this.lastPress = -1e9;
    this.pressCenter = new THREE.Vector2(1e9, 1e9);
    this.time = 0;
    this.ok = true;
  }

  setVisible(v) { if (this.renderer) this.renderer.domElement.style.display = v ? 'block' : 'none'; }

  _sky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSun: { value: SUN }, uZenith: { value: ZENITH }, uHorizon: { value: HORIZON } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 uSun; uniform vec3 uZenith; uniform vec3 uHorizon; varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(h, 0.45));
          if (d.y < 0.0) col = uHorizon * 0.92;
          float s = max(dot(d, uSun), 0.0);
          col += vec3(1.0, 0.92, 0.78) * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.18);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(8000, 32, 16), mat);
    this.scene.add(this.sky);
  }

  _water() {
    this.pressData = new Uint8Array(PRESS_N * PRESS_N * 4).fill(128);
    this.pressTex = new THREE.DataTexture(this.pressData, PRESS_N, PRESS_N, THREE.RGBAFormat);
    this.pressTex.magFilter = THREE.LinearFilter; this.pressTex.minFilter = THREE.LinearFilter;
    this.pressTex.wrapS = this.pressTex.wrapT = THREE.ClampToEdgeWrapping;
    this.pressTex.needsUpdate = true;
    this.waterU = {
      uTime: { value: 0 }, uSun: { value: SUN }, uZenith: { value: ZENITH }, uHorizon: { value: HORIZON },
      uDeep: { value: DEEP }, uMid: { value: MID }, uPress: { value: this.pressTex },
      uPC: { value: new THREE.Vector2() }, uPS: { value: PRESS_SIZE }, uWind: { value: new THREE.Vector2(0, 1) },
      uBoats: { value: Array.from({ length: 24 }, () => new THREE.Vector4()) },   // x, z, heading dir x, z
      uBoatV: { value: new Array(24).fill(0) }, uNB: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.waterU, fog: false,
      vertexShader: `varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uSun; uniform vec3 uZenith; uniform vec3 uHorizon;
        uniform vec3 uDeep; uniform vec3 uMid; uniform sampler2D uPress; uniform vec2 uPC; uniform float uPS; uniform vec2 uWind;
        uniform vec4 uBoats[24]; uniform float uBoatV[24]; uniform int uNB;
        varying vec3 vWorld;
        vec2 rot(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c*v.x - s*v.y, s*v.x + c*v.y); }
        // slope of one wave train a*sin(k(d.p) - wt), deep-water dispersion
        vec2 wv(vec2 p, vec2 d, float k, float a, float t){ float w = sqrt(9.81 * k); return d * (a * k * cos(dot(d, p) * k - w * t)); }
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        // gradient of a drifting noise field (irregular wavelets)
        vec2 ngrad(vec2 p, float sc){
          float e = 0.35, h0 = vnoise(p * sc);
          return vec2(vnoise((p + vec2(e, 0.0)) * sc) - h0, vnoise((p + vec2(0.0, e)) * sc) - h0) / e;
        }
        void main(){
          vec2 p = vWorld.xz;
          float dist = length(cameraPosition - vWorld);
          vec2 uv = (p - uPC) / uPS + 0.5;
          float edge = smoothstep(0.0, 0.08, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
          float pr = (texture2D(uPress, uv).r * 2.0 - 1.0) * edge;            // + puff, - lull
          float rough = clamp(1.0 + 1.1 * pr, 0.3, 2.2);                      // puffs ruffle the water
          vec2 w = normalize(uWind);
          float t = uTime;
          // detail fades with distance (no shimmer), but far water keeps an average roughness
          float f1 = 1.0 / (1.0 + dist / 160.0), f2 = 1.0 / (1.0 + dist / 55.0), f3 = 1.0 / (1.0 + dist / 22.0);
          vec2 g = vec2(0.0);
          g += wv(p, rot(vec2(0.70, 0.71), 0.0), 0.045, 0.40, t);                      // ocean swell
          g += wv(p, rot(vec2(0.62, 0.78), 0.4), 0.07, 0.18, t);
          // wind chop: many trains spread around the wind direction
          g += (wv(p, rot(w,  0.10), 0.50, 0.050, t) + wv(p, rot(w, -0.45), 0.62, 0.040, t)
              + wv(p, rot(w,  0.55), 0.80, 0.032, t) + wv(p, rot(w, -0.20), 1.05, 0.026, t)) * rough * f1;
          g += (wv(p, rot(w,  0.85), 1.45, 0.016, t) + wv(p, rot(w, -0.75), 1.90, 0.013, t)
              + wv(p, rot(w,  0.30), 2.60, 0.009, t) + wv(p, rot(w, -1.05), 3.40, 0.007, t)) * rough * f2;
          g += (wv(p, rot(w,  0.20), 9.0, 0.0028, t) + wv(p, rot(w, -0.55), 13.0, 0.0020, t)) * rough * f3;
          // irregular wavelets, nearly fixed in the water (real ripples barely move), so
          // the surface streams past at your own speed; larger patches stay visible far off
          vec2 drift = w * t * 0.3;
          float f4 = 1.0 / (1.0 + dist / 450.0);
          g += (ngrad(p - drift, 0.55) * 0.10 + ngrad(p * 1.7 - drift * 1.3, 0.9) * 0.06) * rough * f2;
          g += (ngrad(p - drift * 0.6, 0.11) * 0.16 + ngrad(p - drift * 0.4, 0.045) * 0.12) * rough * f4;
          vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
          vec3 v = normalize(cameraPosition - vWorld);
          // roughness of the surface as seen from here: near detail + an average for the far field
          // (rough water seen at a distance doesn't mirror the horizon: facets tilt toward you)
          float r0 = clamp(0.25 * rough + 0.45 * rough * (1.0 - f2), 0.0, 1.0);
          float ndv = max(dot(n, v), 0.0);
          float fres = (0.02 + 0.98 * pow(1.0 - ndv, 5.0)) * mix(1.0, 0.38, r0);
          vec3 r = reflect(-v, n);
          r.y = abs(r.y);
          vec3 skySharp = mix(uHorizon, uZenith, pow(clamp(r.y, 0.0, 1.0), 0.45));
          vec3 skyBlur = mix(uHorizon, uZenith, 0.62);
          vec3 sky = mix(skySharp, skyBlur, r0);
          // water body: a little lighter where the wave faces look into the light
          vec3 body = mix(uMid, uDeep, clamp(0.5 + 0.55 * pr, 0.0, 1.0));
          body *= 0.7 + 0.55 * clamp(dot(n, normalize(uSun + vec3(0.0, 0.6, 0.0))), 0.0, 1.0);
          vec3 col = mix(body, sky, fres);
          // sun glitter: sharp sparkles on facets + a broad sheen
          float sd = max(dot(r, uSun), 0.0);
          float sparkle = pow(sd, 900.0) * 6.0 + pow(sd, 120.0) * 0.9 + pow(sd, 18.0) * 0.06;
          col += vec3(1.0, 0.96, 0.88) * sparkle * (0.6 + 0.4 * rough);
          // tiny crests catching light in the puffs
          float crest = smoothstep(0.82, 0.97, vnoise((p - drift * 1.2) * 1.3)) * max(pr, 0.0) * f2;
          col = mix(col, vec3(0.85, 0.9, 0.95), crest * 0.25);
          // flecks of foam on the surface (more in puffs): they sit in the water and slide past you
          float fl = smoothstep(0.93, 0.995, vnoise((p - drift) * 2.2)) * smoothstep(0.6, 0.995, vnoise((p - drift) * 0.37 + 7.0));
          col = mix(col, vec3(0.86, 0.91, 0.95), fl * f3 * (0.25 + 0.35 * max(rough - 0.6, 0.0)));
          // bow waves and wakes: a Kelvin wedge (~19.5 deg) of foam behind each moving boat,
          // broken up by the (fixed) water texture so it streams past
          float foam = 0.0;
          for (int i = 0; i < 24; i++) {
            if (i >= uNB) break;
            vec4 B = uBoats[i];
            vec2 rel = p - B.xy;
            if (abs(rel.x) > 40.0 || abs(rel.y) > 40.0) continue;
            float spd = uBoatV[i];
            if (spd < 0.4) continue;
            vec2 d = B.zw;
            float ahead = dot(rel, d);                         // + toward the bow
            float lat = abs(rel.x * d.y - rel.y * d.x);
            float back = 2.3 - ahead;                          // metres behind the bow
            if (back < -0.6 || back > 38.0) continue;
            float sf = clamp((spd - 0.4) / 2.5, 0.0, 1.0);
            float arm = 0.36 * max(back, 0.0) + 0.75;           // wake arms (hull half-beam at the bow)
            float wArm = exp(-pow((lat - arm) / (0.22 + 0.035 * back), 2.0)) * exp(-back / (7.0 + 5.0 * sf));
            float wMid = exp(-pow(lat / (0.55 + 0.05 * back), 2.0)) * exp(-back / (4.0 + 4.0 * sf)) * step(4.6, back);
            float bow = exp(-pow((lat - 0.8) / 0.3, 2.0)) * smoothstep(-0.6, 0.6, back) * (1.0 - smoothstep(2.0, 5.5, back));
            foam = max(foam, sf * (0.55 * wArm + 0.45 * wMid + 0.7 * bow));
          }
          float tex = 0.45 + 0.75 * vnoise((p - drift) * 3.1) * vnoise((p - drift) * 0.9 + 3.0);
          col = mix(col, vec3(0.9, 0.94, 0.97), clamp(foam * tex, 0.0, 0.85) * (0.4 + 0.6 * f2));
          col = mix(col, uHorizon, 0.8 * smoothstep(900.0, 6500.0, dist));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const geo = new THREE.PlaneGeometry(9000, 9000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(geo, mat);
    this.scene.add(this.water);
  }

  _updatePressure(S, cx, cz) {
    const w = S.wind;
    if (!w || !(w.p.pressureSd > 0)) { if (this.pressFlat !== true) { this.pressData.fill(128); this.pressTex.needsUpdate = true; this.pressFlat = true; } return; }
    this.pressFlat = false;
    const moved = Math.hypot(cx - this.pressCenter.x, cz - this.pressCenter.y);
    if (S.t - this.lastPress < 0.3 && moved < 120) return;
    this.lastPress = S.t;
    this.pressCenter.set(cx, cz);
    this.waterU.uPC.value.set(cx, cz);
    const sd = w.p.pressureSd;
    const d = this.pressData;
    for (let j = 0; j < PRESS_N; j++) {
      for (let i = 0; i < PRESS_N; i++) {
        const X = cx + ((i + 0.5) / PRESS_N - 0.5) * PRESS_SIZE;
        const Z = cz + ((j + 0.5) / PRESS_N - 0.5) * PRESS_SIZE;
        const p = w.pressure(X, -Z, S.t) / sd;
        const v = Math.max(0, Math.min(255, 128 + 64 * p));
        const k = (j * PRESS_N + i) * 4;
        d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
      }
    }
    this.pressTex.needsUpdate = true;
  }

  _course(c, twd) {
    const key = `${c.pin}|${c.boat}|${c.mark}`;
    if (key === this.courseKey) return;
    if (this.courseObj) this.scene.remove(this.courseObj);
    this.courseKey = key;
    const g = new THREE.Group();
    const orange = new THREE.MeshStandardMaterial({ color: '#ff6a10', roughness: 0.45, emissive: '#3a1200' });
    const mark = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.78, 1.7, 28), orange);
    mark.position.set(c.mark[0], 0.7, -c.mark[1]);
    g.add(mark);
    const pin = new THREE.Group();
    const pb = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 1.1, 24), orange);
    pb.position.y = 0.45;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.6, 8), new THREE.MeshStandardMaterial({ color: '#333' }));
    pole.position.y = 1.9;
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.42), new THREE.MeshStandardMaterial({ color: '#ffd21a', side: THREE.DoubleSide }));
    flag.position.set(0.3, 3.0, 0);
    pin.add(pb, pole, flag);
    pin.position.set(c.pin[0], 0, -c.pin[1]);
    g.add(pin);
    // Committee boat: a bigger white hull with a cabin, anchored head to wind.
    const rc = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: '#f2f4f6', roughness: 0.4 });
    const hull = new THREE.Mesh(this.hull.sides, white);
    hull.scale.set(1.7, 2.0, 1.85);
    const deck = new THREE.Mesh(this.hull.deck, new THREE.MeshStandardMaterial({ color: '#c9d1d8', roughness: 0.7 }));
    deck.scale.copy(hull.scale);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.3, 3.0), white);
    cabin.position.set(0, 1.45, 0.6);
    const win = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.35, 2.4), new THREE.MeshStandardMaterial({ color: '#203040', roughness: 0.2 }));
    win.position.set(0, 1.75, 0.6);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 4.5, 8), new THREE.MeshStandardMaterial({ color: '#555' }));
    mast.position.set(0, 3.9, 0.2);
    const rcFlag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), new THREE.MeshStandardMaterial({ color: '#ff6a10', side: THREE.DoubleSide }));
    rcFlag.position.set(0.45, 5.7, 0.2);
    rc.add(hull, deck, cabin, win, mast, rcFlag);
    rc.position.set(c.boat[0], 0, -c.boat[1]);
    rc.rotation.y = -twd * D2R;
    g.add(rc);
    this.courseObj = g;
    this.scene.add(g);
  }

  _boat(b) {
    let m = this.boats.get(b.id);
    if (m) return m;
    m = makeBoat(this.hull, b);
    this.boats.set(b.id, m);
    this.scene.add(m.root);
    return m;
  }

  resize(w, h) {
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = 2 * Math.atan(Math.tan(FOV / 2 * D2R) / this.camera.aspect) / D2R;
    this.camera.updateProjectionMatrix();
  }

  render(S, dtReal) {
    if (!this.ok) return;
    const el = this.renderer.domElement;
    const rect = el.parentElement.getBoundingClientRect();
    this.resize(Math.max(10, rect.width), Math.max(10, rect.height));
    // Everything moves on SIM time, so the water and the boats stay consistent at
    // 1x-8x and freeze together when paused.
    const simDt = this.lastSim === undefined ? 0 : Math.max(0, Math.min(1, S.t - this.lastSim));
    this.lastSim = S.t;
    this.time = S.t;
    const u = S.user;
    if (S.course) this._course(S.course, u.twd ?? S.course.axis);
    const seen = new Set();
    for (const b of S.boats) {
      const m = this._boat(b);
      seen.add(b.id);
      m.root.visible = !b.hidden;
      if (b.hidden) continue;
      poseBoat(m, b, this.time, simDt, b === u || b.isUser);
    }
    for (const [id, m] of this.boats) if (!seen.has(id)) { this.scene.remove(m.root); this.boats.delete(id); }

    // Camera: the helm on the windward side, aft, eye ~1.1 m up; it rolls a
    // little with the boat (your head stays mostly level).
    const me = this.boats.get(u.id);
    const side = (u.rel ?? 1) >= 0 ? -1 : 1;                 // windward: port side (-X) on port tack
    const eye = new THREE.Vector3(side * 0.78, 1.42, 1.15);
    me.heel.updateMatrixWorld(true);
    me.heel.localToWorld(eye);
    this.camera.position.copy(eye);
    const yaw = -((u.hdg + (S.look || 0)) * D2R);
    this.camera.rotation.set(-3 * D2R, yaw, me.heelNow * 0.35);
    // Sea and sky follow the camera.
    this.water.position.set(eye.x, 0, eye.z);
    this.sky.position.copy(eye);
    this.waterU.uTime.value = this.time;
    // boats for bow waves and wakes (nearest first, up to 24)
    let nb = 0;
    const list = S.boats.filter(b => !b.hidden).map(b => ({ b, d: Math.hypot(b.x - u.x, b.y - u.y) })).sort((a, c) => a.d - c.d);
    for (const { b } of list) {
      if (nb >= 24) break;
      const [hx, hy] = unit(b.hdg);
      this.waterU.uBoats.value[nb].set(b.x, -b.y, hx, -hy);
      this.waterU.uBoatV.value[nb] = b.v || 0;
      nb++;
    }
    this.waterU.uNB.value = nb;
    const [wx, wy] = unit((u.twd ?? 0) + 180);                 // direction the wind blows to
    this.waterU.uWind.value.set(wx, -wy);
    this._updatePressure(S, eye.x, eye.z);
    this.renderer.render(this.scene, this.camera);
  }
}

// ---------------------------------------------------------------- boats

// A Melges-15-like dinghy hull, 4.6 m x 1.8 m, bow toward -Z.
function buildHull() {
  const N = 28, L = 4.6;
  const cols = 5;                                          // deck R, chine R, keel, chine L, deck L
  const pos = [];
  const hb = (u) => u < 0.62 ? 0.9 * Math.pow(Math.sin(u / 0.62 * Math.PI / 2), 0.62) : 0.9 - 0.13 * (u - 0.62) / 0.38;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const z = -L / 2 + u * L;
    const b = hb(u);
    const deckY = 0.42 + 0.1 * (1 - u) * (1 - u);
    const keelY = -0.2 * Math.sin(Math.PI * Math.min(1, u * 1.12 + 0.02)) - 0.05 * u;
    const chineY = keelY * 0.3 + 0.02;
    pos.push(b, deckY, z, b * 0.93, chineY, z, 0, keelY, z, -b * 0.93, chineY, z, -b, deckY, z);
  }
  const idx = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < cols - 1; j++) {
    const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // transom
  const t0 = N * cols;
  idx.push(t0, t0 + 1, t0 + 2, t0, t0 + 2, t0 + 4, t0 + 2, t0 + 3, t0 + 4);
  const sides = new THREE.BufferGeometry();
  sides.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  sides.setIndex(idx);
  sides.computeVertexNormals();
  // deck
  const dp = [], di = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, z = -L / 2 + u * L, b = hb(u), y = 0.42 + 0.1 * (1 - u) * (1 - u);
    dp.push(b, y, z, -b, y, z);
  }
  for (let i = 0; i < N; i++) { const a = i * 2; di.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const deck = new THREE.BufferGeometry();
  deck.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
  deck.setIndex(di);
  deck.computeVertexNormals();
  return { sides, deck };
}

// Sail surface: luff from (0,0,0) up to `head`, foot along to `clew`, grid
// with camber toward +X (mirrored with scale.x for the other tack).
function sailGeometry(head, clew, depth, roach = 0) {
  const NV = 12, NU = 7;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= NV; i++) {
    const v = i / NV;
    const lx = 0, ly = head[1] * v, lz = head[2] * v;                       // luff point
    const tx = 0, ty = clew[1] + (head[1] - clew[1]) * v, tz = clew[2] + (head[2] - clew[2]) * v;   // leech point
    const r = roach * Math.sin(Math.PI * v);
    for (let j = 0; j <= NU; j++) {
      const u = j / NU;
      const chord = Math.hypot(ty - ly, tz - lz) + r;
      const cam = depth * chord * Math.sin(Math.PI * u) * (1 - 0.35 * u) * (1 - 0.4 * v);
      pos.push(lx + (tx - lx) * u + cam, ly + (ty - ly) * u, lz + (tz - lz) * u + r * u);
      uv.push(u, v);
    }
  }
  for (let i = 0; i < NV; i++) for (let j = 0; j < NU; j++) {
    const a = i * (NU + 1) + j, b = a + 1, c = a + NU + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

let MAIN_GEO = null, JIB_GEO = null;

function sailTexture(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#f7f8f6'; g.fillRect(0, 0, 256, 512);
  // panel seams
  g.strokeStyle = 'rgba(0,0,0,0.06)'; g.lineWidth = 2;
  for (let y = 60; y < 512; y += 70) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y + 20); g.stroke(); }
  if (text) {
    g.fillStyle = '#16263a';
    g.font = `900 ${text.length > 3 ? 64 : 76}px Arial, sans-serif`;
    const w = g.measureText(text).width;
    g.fillText(text, 95 - w / 2, 200);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makeBoat(hull, b) {
  MAIN_GEO ??= sailGeometry([0, 5.13, 0], [0, 0, 2.75], 0.1, 0.25);
  JIB_GEO ??= sailGeometry([0, 3.85, 1.45], [0, 0.05, 1.8], 0.09, 0);
  const ghost = !!b.isGhost;
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const heel = new THREE.Group();
  root.add(heel);
  const hullMat = new THREE.MeshStandardMaterial({ color: b.isUser ? '#f4f6f8' : (b.color || '#cccccc'), roughness: 0.32, metalness: 0.05, transparent: ghost, opacity: ghost ? 0.5 : 1 });
  const deckMat = new THREE.MeshStandardMaterial({ color: '#e9edf0', roughness: 0.65, transparent: ghost, opacity: ghost ? 0.5 : 1 });
  heel.add(new THREE.Mesh(hull.sides, hullMat), new THREE.Mesh(hull.deck, deckMat));
  const spar = new THREE.MeshStandardMaterial({ color: '#2d3136', roughness: 0.4, metalness: 0.6 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.045, 6.4, 10), spar);
  mast.position.set(0, 0.4 + 3.2, MAST_Z);
  heel.add(mast);
  // Your own sails are a little see-through so they don't hide the boats behind them.
  const sailMat = new THREE.MeshStandardMaterial({ map: sailTexture(b.isUser ? '' : (b.sail || '').replace(' (real)', '')), side: THREE.DoubleSide,
    roughness: 0.85, transparent: true, opacity: ghost ? 0.45 : (b.isUser ? 0.62 : 0.97), depthWrite: !b.isUser,
    emissive: '#8a9098', emissiveIntensity: 0.55 });
  const jibMat = new THREE.MeshStandardMaterial({ color: '#f5f6f4', side: THREE.DoubleSide, roughness: 0.85, transparent: true, opacity: ghost ? 0.45 : (b.isUser ? 0.45 : 0.96), depthWrite: !b.isUser,
    emissive: '#8a9098', emissiveIntensity: 0.55 });
  const boom = new THREE.Group();
  boom.position.set(0, 1.12, MAST_Z);
  const boomBar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.8, 8), spar);
  boomBar.rotation.x = Math.PI / 2; boomBar.position.z = 1.4;
  const main = new THREE.Mesh(MAIN_GEO, sailMat);
  boom.add(boomBar, main);
  heel.add(boom);
  const jib = new THREE.Group();
  jib.position.set(0, 0.55, -2.15);
  const jibMesh = new THREE.Mesh(JIB_GEO, jibMat);
  jib.add(jibMesh);
  heel.add(jib);
  // two crew hiking on the windward rail (not drawn for your own boat: that's you)
  const crew = new THREE.Group();
  if (!b.isUser) {
    const jacket = new THREE.MeshStandardMaterial({ color: ['#1c2a44', '#b3262a', '#1f5a3a', '#2a2a2a'][b.id % 4], roughness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: '#d2a07c', roughness: 0.8 });
    const hat = new THREE.MeshStandardMaterial({ color: '#f0f0f0', roughness: 0.8 });
    const legMat = new THREE.MeshStandardMaterial({ color: '#2b2f36', roughness: 0.8 });
    for (const z of [0.55, 1.3]) {
      const p = new THREE.Group();
      const body = new THREE.Group();
      const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.36, 4, 10), jacket);
      torso.position.y = 0.3;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), skin);
      head.position.y = 0.66;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.105, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), hat);
      cap.position.y = 0.68;
      body.add(torso, head, cap);
      const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.5, 4, 8), legMat);
      legs.rotation.z = Math.PI / 2;
      legs.position.set(-0.32, 0.04, 0);                    // toward the centreline (local -X; mirrored per side)
      p.add(body, legs);
      p.position.set(0, 0, z);
      p.userData.body = body;
      crew.add(p);
    }
  }
  crew.position.y = 0.44;                                  // they sit on the rail; bodies lean out to hike
  heel.add(crew);
  // cockpit floor (a little lower and darker than the deck)
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.04, 1.9), new THREE.MeshStandardMaterial({ color: '#9aa4ad', roughness: 0.8 }));
  cockpit.position.set(0, 0.33, 1.1);
  heel.add(cockpit);
  return { root, heel, boom, main, jib, jibMesh, crew, heelNow: 0, sailNow: 0, crewX: 0 };
}

function poseBoat(m, b, time, dt, isMe) {
  m.root.position.set(b.x, 0, -b.y);
  m.root.rotation.y = -b.hdg * D2R;
  const rel = b.rel ?? 0, twa = Math.abs(rel);
  const port = rel >= 0;
  const tws = b.tws || 7;
  const tacking = b.ctl?.mode === 'tack' || b.ctl?.mode === 'gybe' || b.ctl?.mode === 'penalty' || b.ctl?.mode === 'bearaway';
  // heel to leeward: hiked flat-ish upwind, more in breeze, little downwind
  let mag = twa < 70 ? 9 + 0.7 * (tws - 6) : twa < 115 ? 7 : 3;
  mag = Math.max(3, Math.min(16, mag)) * Math.min(1, (b.v || 0) / 1.2);
  const target = (tacking ? 0 : (port ? -1 : 1)) * mag * D2R;
  const k = 1 - Math.exp(-dt / 0.7);
  m.heelNow += (target - m.heelNow) * k;
  // a little wave motion
  const ph = (b.id || 0) * 1.7;
  m.heel.rotation.set(Math.sin(time * 1.3 + ph) * 0.02, 0, m.heelNow + Math.sin(time * 0.9 + ph) * 0.015);
  m.heel.position.y = Math.sin(time * 1.1 + ph) * 0.05;
  // sails: boom out to leeward by about half the wind angle; flog when luffing
  const luff = b.ctl?.stop || b.ctl?.eased || twa < 22 || (b.ctl?.trim ?? 1) < 0.4;
  let ang = Math.max(6, Math.min(80, twa * 0.5));
  if (luff) ang = Math.min(85, twa * 0.55 + 25);
  const sAng = (port ? 1 : -1) * ang * D2R;
  m.sailNow += (sAng - m.sailNow) * (1 - Math.exp(-dt / (tacking ? 0.35 : 0.6)));
  m.boom.rotation.y = m.sailNow;
  m.jib.rotation.y = m.sailNow * 0.8;
  const camber = luff ? Math.sin(time * 14 + ph) * 0.8 : (m.sailNow >= 0 ? 1 : -1);
  m.main.scale.x = camber;
  m.jibMesh.scale.x = luff ? Math.sin(time * 17 + ph) * 0.8 : camber;
  // crew on the windward rail (port tack: -X), inboard downwind; they cross the boat in a tack
  const hiking = twa < 110 && (b.v || 0) > 1.4 && !luff;
  const cx = hiking ? (port ? -0.98 : 0.98) : (port ? -0.6 : 0.6);
  m.crewX += (cx - m.crewX) * (1 - Math.exp(-dt / 0.5));
  m.crew.position.x = m.crewX;
  const s = Math.sign(m.crewX) || 1;
  const lean = hiking ? 0.95 * Math.min(1, (b.v || 0) / 2.2) : 0.15;
  m.hikeNow = (m.hikeNow ?? 0) + (lean - (m.hikeNow ?? 0)) * (1 - Math.exp(-dt / 0.6));
  for (const p of m.crew.children) {
    p.scale.x = s;                                          // legs point inboard on either side
    if (p.userData.body) p.userData.body.rotation.z = -m.hikeNow;  // lean to local +X = outboard on either side (scale.x = s)
  }
  m.crew.visible = !isMe;
}
