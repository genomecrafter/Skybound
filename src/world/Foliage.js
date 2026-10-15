import * as THREE from 'three';
import { mulberry32 } from '../utils/math.js';

/**
 * Shared building blocks for realistic vegetation.
 *
 * FOLIAGE CARDS
 *  Real trees are far too detailed to model needle by needle. Games use
 *  "cards": small quads textured with a painted image of a whole branch spray
 *  (needles, leaflets) whose background is transparent. ALPHA TESTING throws
 *  away the transparent pixels, so each quad shows a detailed, ragged branch.
 *  With MSAA we also enable ALPHA-TO-COVERAGE, which turns the alpha edge into
 *  partial pixel coverage: soft, non-jagged needle edges.
 *
 * TEXTURE ATLAS
 *  Each plant uses one texture split into regions (branch spray, bark, dense
 *  opaque foliage) so a whole tree, trunk included, is ONE geometry with ONE
 *  material: one draw call per InstancedMesh. The texture is built from raw
 *  pixel data (DataTexture), so transparent pixels keep a green colour and
 *  mipmaps don't get dark fringes.
 *
 * LIGHTING TRICKS (in onBeforeCompile)
 *  - Foliage normals point OUTWARD from the tree's axis instead of along each
 *    card, so the crown is shaded like one soft volume (lit side / shade side)
 *    instead of a mess of flat planes. Double-sided cards must therefore NOT
 *    flip their normal on back faces.
 *  - Vertex colours hold ambient occlusion: darker toward the trunk and the
 *    bottom of the crown.
 *  - Translucency: leaves glow when the sun shines through them toward the camera.
 *  - Mip-level alpha boost: averaged alpha in small mipmaps would make
 *    distant trees go thin and see-through; we scale alpha up per mip level.
 *  - A gentle wind sway that grows with height (vertex shader).
 *  - A tint attribute mixes the colour toward a uniform colour: snow on spruce
 *    branches, brown on dead palm fronds.
 */

// ------------------------------------------------------------- textures --

/** Small 2D canvas-like painter over a raw RGBA buffer, with alpha blending. */
export class Painter {
  constructor(w, h, bleed = [60, 90, 50]) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) this.data.set([bleed[0], bleed[1], bleed[2], 0], i * 4);
  }

  /** Blend colour c (0..255 rgb) with alpha a into pixel (x, y). */
  px(x, y, c, a = 1) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4, d = this.data;
    const old = d[i + 3] / 255;
    const na = a + old * (1 - a);
    // Colour blends normally; fully transparent pixels just take the colour
    const k = old === 0 ? 1 : a;
    d[i] += (c[0] - d[i]) * k;
    d[i + 1] += (c[1] - d[i + 1]) * k;
    d[i + 2] += (c[2] - d[i + 2]) * k;
    d[i + 3] = na * 255;
  }

  /** Thick anti-aliased line (capsule) from (x0,y0) to (x1,y1). */
  line(x0, y0, x1, y1, w0, w1, c, a = 1) {
    const minX = Math.floor(Math.min(x0, x1) - Math.max(w0, w1) - 1);
    const maxX = Math.ceil(Math.max(x0, x1) + Math.max(w0, w1) + 1);
    const minY = Math.floor(Math.min(y0, y1) - Math.max(w0, w1) - 1);
    const maxY = Math.ceil(Math.max(y0, y1) + Math.max(w0, w1) + 1);
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
        const d = Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t));
        const r = (w0 + (w1 - w0) * t) * 0.5;
        const cov = Math.max(0, Math.min(1, r + 0.5 - d));
        if (cov > 0) this.px(x, y, c, cov * a);
      }
    }
  }

  fillRect(x0, y0, w, h, fn) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.px(x, y, fn(x - x0, y - y0), 1);
  }

  /** Build a mipmapped, sRGB DataTexture from the buffer. */
  texture() {
    const t = new THREE.DataTexture(this.data, this.w, this.h, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }
}

/** Random colour between two rgb triples. */
const mixC = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Atlas regions in U (fractions of the width). Every atlas in this file is
 * 768 x 256: spray 512 px wide (2:1, matches the branch cards), then bark,
 * then dense opaque foliage.
 */
export const ATLAS = { W: 768, H: 256, spray: [0.004, 0.663], bark: [0.672, 0.828], dense: [0.838, 0.996] };

/** Bark strip: vertical fibres + darker cracks. */
function paintBark(p, x0, w, base, seed, rings = 0) {
  const rand = mulberry32(seed);
  const cols = Array.from({ length: w }, () => 0.8 + rand() * 0.35);
  p.fillRect(x0, 0, w, p.h, (x, y) => {
    let k = cols[x] * (0.9 + 0.1 * Math.sin(y * 0.21 + x));
    if (rings) {
      // Palm leaf-scar rings: dark bands around the trunk
      const r = (y / p.h) * rings;
      k *= 0.72 + 0.28 * Math.min(1, Math.abs(Math.sin(r * Math.PI)) * 1.6);
    } else if ((y + Math.floor(cols[(x * 7) % w] * 40)) % 23 < 2) k *= 0.6; // cracks
    return [base[0] * k, base[1] * k, base[2] * k];
  });
}

/** Dense, opaque foliage block (inner crown / far-LOD trees). */
function paintDense(p, x0, w, dark, light, seed, stroke = 9) {
  const rand = mulberry32(seed);
  p.fillRect(x0, 0, w, p.h, () => dark);
  for (let i = 0; i < w * p.h * 0.05; i++) {
    const x = x0 + rand() * w, y = rand() * p.h, a = rand() * Math.PI;
    const l = stroke * (0.5 + rand() * 0.6);
    p.line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 1.6, 0.9, mixC(dark, light, rand()), 0.9);
  }
}

/** Spruce / fir branch spray: a twig with side twigs, all covered in needles. */
export function makeConiferAtlas(seed = 3) {
  const { W, H } = ATLAS;
  const p = new Painter(W, H, [38, 62, 36]);
  const rand = mulberry32(seed);
  const SW = Math.floor(ATLAS.spray[1] * W); // spray width in px
  const cy = H / 2;
  const dark = [48, 82, 44], mid = [80, 120, 62], light = [132, 164, 86];
  const twig = [80, 58, 40];

  const needles = (x0, y0, x1, y1, len, density = 0.45, tipLight = 0) => {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L;
    for (let s = 0; s < L; s += density * 2.2) {
      const t = s / L;
      const bx = x0 + ux * s, by = y0 + uy * s;
      const nl = len * (0.75 + rand() * 0.5) * (1 - t * 0.45);
      for (const side of [-1, 1]) {
        const ang = Math.atan2(uy, ux) + side * (0.7 + rand() * 0.5);
        const c = mixC(mixC(dark, mid, rand()), light, Math.max(0, t - 0.6) * tipLight + rand() * 0.15);
        p.line(bx, by, bx + Math.cos(ang) * nl, by + Math.sin(ang) * nl, 2.0, 0.8, c);
      }
    }
  };

  // Main twig across the spray, slightly wavy
  const main = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    main.push([8 + t * (SW - 24), cy + Math.sin(t * 5 + 1) * 4]);
  }
  // Side twigs alternate left/right; spray outline is widest ~35% along
  for (let i = 2; i < 23; i += 1) {
    const [bx, by] = main[i];
    const t = i / 24;
    const side = i % 2 ? 1 : -1;
    const reach = (H * 0.46) * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15)), 0.6);
    const ang = side * (0.65 + rand() * 0.25);
    const l = reach / Math.sin(Math.abs(ang)) * (0.85 + rand() * 0.2);
    const ex = bx + Math.cos(ang) * l, ey = by + Math.sin(ang) * l;
    p.line(bx, by, ex, ey, 2.6, 1.0, twig);
    needles(bx, by, ex, ey, 16, 0.4, 1.2);
    // Second-order twigs
    for (let k = 0.35; k < 0.8; k += 0.4) {
      const sx = bx + (ex - bx) * k, sy = by + (ey - by) * k;
      const a2 = ang + side * -0.9 * (rand() > 0.5 ? 1 : -1);
      const l2 = l * 0.35;
      const tx = sx + Math.cos(a2) * l2, ty = sy + Math.sin(a2) * l2;
      if (Math.abs(ty - cy) < H * 0.47) needles(sx, sy, tx, ty, 10, 0.5, 1);
    }
  }
  for (let i = 0; i < 24; i++) {
    const [x0, y0] = main[i], [x1, y1] = main[i + 1];
    p.line(x0, y0, x1, y1, 4.5 - (i / 24) * 3, 4.5 - ((i + 1) / 24) * 3, twig);
    needles(x0, y0, x1, y1, 18, 0.35, 1.5);
  }

  const bx = Math.floor(ATLAS.bark[0] * W) - 4, bw = Math.ceil((ATLAS.bark[1] - ATLAS.bark[0]) * W) + 8;
  paintBark(p, bx, bw, [92, 66, 50], seed + 1);
  const dx = Math.floor(ATLAS.dense[0] * W) - 4;
  paintDense(p, dx, W - dx, [36, 64, 36], [88, 124, 64], seed + 2);
  return p.texture();
}

/** Palm frond: a rachis (midrib) with long, drooping leaflets on both sides. */
export function makePalmAtlas(seed = 7) {
  const { W, H } = ATLAS;
  const p = new Painter(W, H, [70, 100, 45]);
  const rand = mulberry32(seed);
  const SW = Math.floor(ATLAS.spray[1] * W);
  const cy = H / 2;
  const green = [52, 98, 38], yellow = [118, 132, 56], dark = [34, 70, 30];
  for (let x = 0.1 * SW; x < SW - 10; x += 4.2) {
    const t = x / SW;
    const len = H * 0.48 * Math.pow(Math.sin(Math.PI * Math.min(1, (t - 0.08) / 0.95)), 0.5);
    for (const side of [-1, 1]) {
      if (rand() < 0.06) continue; // gaps: torn leaflets
      const ang = side * (1.0 + rand() * 0.15); // swept toward the tip
      const ex = x + Math.cos(ang) * len * 0.55, ey = cy + Math.sin(ang) * len;
      const c = mixC(mixC(dark, green, 0.5 + rand() * 0.5), yellow, rand() * 0.35 + t * 0.2);
      // A slightly curved leaflet: two segments
      const mx = (x + ex) / 2 + 3, my = (cy + ey) / 2;
      p.line(x, cy, mx, my, 4.5, 4, c);
      p.line(mx, my, ex, ey, 4, 0.8, c);
      p.line(x, cy, mx, my, 0.8, 0.6, mixC(c, [180, 190, 110], 0.4)); // leaflet midrib
    }
  }
  p.line(4, cy, SW - 6, cy, 6, 1.5, [128, 120, 64]); // rachis
  const bx = Math.floor(ATLAS.bark[0] * W) - 4, bw = Math.ceil((ATLAS.bark[1] - ATLAS.bark[0]) * W) + 8;
  paintBark(p, bx, bw, [118, 98, 78], seed + 1, 26);
  const dx = Math.floor(ATLAS.dense[0] * W) - 4;
  paintDense(p, dx, W - dx, [86, 66, 40], [130, 104, 66], seed + 2, 14); // fibrous husk
  return p.texture();
}

/** Desert scrub: a round tuft of thin twigs with small grey-olive leaves. */
export function makeShrubAtlas(seed = 9) {
  const { W, H } = ATLAS;
  const p = new Painter(W, H, [96, 98, 60]);
  const rand = mulberry32(seed);
  // Two square tufts side by side in the spray region (each 256 x 256)
  for (let k = 0; k < 2; k++) {
    const cx = 128 + k * 256, by = H - 8;
    for (let i = 0; i < 26; i++) {
      const ang = -Math.PI / 2 + (rand() - 0.5) * 2.4;
      const l = 70 + rand() * 60;
      const ex = cx + Math.cos(ang) * l * 1.3, ey = by + Math.sin(ang) * l * 1.5;
      p.line(cx + (rand() - 0.5) * 20, by, ex, ey, 2.5, 0.8, [90, 72, 52]);
      for (let s = 0.25; s < 1; s += 0.05) {
        const x = cx + (ex - cx) * s + (rand() - 0.5) * 16, y = by + (ey - by) * s + (rand() - 0.5) * 16;
        const c = mixC([82, 92, 52], [150, 150, 96], rand());
        const a = rand() * Math.PI;
        p.line(x, y, x + Math.cos(a) * 6, y + Math.sin(a) * 6, 4, 2, c);
      }
    }
  }
  const bx = Math.floor(ATLAS.bark[0] * W) - 4, bw = Math.ceil((ATLAS.bark[1] - ATLAS.bark[0]) * W) + 8;
  paintBark(p, bx, bw, [96, 76, 56], seed + 1);
  const dx = Math.floor(ATLAS.dense[0] * W) - 4;
  paintDense(p, dx, W - dx, [70, 74, 44], [128, 128, 84], seed + 2, 7);
  return p.texture();
}

// ------------------------------------------------------------- geometry --

/** Accumulates vertices (position, normal, uv, colour, tint) and triangles. */
export class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.tint = [];
    this.idx = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  vert(p, n, u, v, ao = 1, tint = 0) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(ao, ao, ao);
    this.tint.push(tint);
    return this.count - 1;
  }

  /** Grid of rows x cols vertices (already added, starting at `start`) into triangles. */
  grid(start, rows, cols, wrap = false) {
    const cw = wrap ? cols : cols - 1;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cw; c++) {
        const a = start + r * cols + c, b = start + r * cols + ((c + 1) % cols);
        const d = a + cols, e = b + cols;
        this.idx.push(a, b, d, b, e, d);
      }
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Map a 0..1 coordinate into an atlas region. */
export const region = (r, t) => ATLAS[r][0] + (ATLAS[r][1] - ATLAS[r][0]) * t;

// ------------------------------------------------------------- material --

// One time uniform shared by every foliage material (wind animation)
const sharedTime = { value: 0 };

/**
 * Foliage material: MeshStandardMaterial + the shader tweaks described above.
 * @param {THREE.Texture} map atlas
 * @param {object} o { tintColor, tintAmount, translucency, wind }
 */
export function createFoliageMaterial(map, { tintColor = 0xffffff, tintAmount = 0, translucency = 0.35, wind = 1, roughness = 0.85 } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map,
    vertexColors: true,
    roughness,
    metalness: 0,
    alphaTest: 0.5,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
  });
  const uniforms = {
    uTime: sharedTime,
    uWind: { value: wind },
    uTintColor: { value: new THREE.Color(tintColor) },
    uTintAmount: { value: tintAmount },
    uTranslucency: { value: translucency },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uWind;
        attribute float aTint;
        varying float vTint;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTint = aTint;
        #ifdef USE_INSTANCING
          // Wind sway: bend grows with height^2; phase varies per instance
          float hgt = max(position.y - 0.5, 0.0);
          vec2 ip = instanceMatrix[3].xz;
          float ph = uTime * 1.25 + dot(ip, vec2(0.031, 0.047));
          float gust = 0.6 + 0.4 * sin(uTime * 0.37 + ip.x * 0.004);
          transformed.x += sin(ph) * hgt * hgt * 0.0022 * uWind * gust;
          transformed.z += sin(ph * 0.83 + 1.7) * hgt * hgt * 0.0016 * uWind * gust;
          // Leaf flutter on the outer parts
          transformed.y += sin(uTime * 4.0 + position.x * 3.0 + position.z * 2.0 + ip.x) * 0.02 * uWind * hgt * 0.1;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uTintColor;
        uniform float uTintAmount;
        uniform float uTranslucency;
        varying float vTint;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        #ifdef USE_MAP
          // Mip-level alpha boost (keeps distant foliage dense)
          vec2 tc = vMapUv * vec2(${ATLAS.W}.0, ${ATLAS.H}.0);
          vec2 tdx = dFdx(tc), tdy = dFdy(tc);
          float lod = max(0.0, 0.5 * log2(max(dot(tdx, tdx), dot(tdy, tdy))));
          diffuseColor.a *= 1.0 + lod * 0.3;
        #endif
        // Tint (snow / dry leaves), patchy using the texture brightness
        float tintK = clamp(vTint, 0.0, 1.0) * uTintAmount;
        tintK *= smoothstep(0.02, 0.2, dot(diffuseColor.rgb, vec3(0.3, 0.6, 0.1)) + vTint * 0.15);
        diffuseColor.rgb = mix(diffuseColor.rgb, uTintColor, tintK);`,
      )
      // Keep the outward-pointing foliage normal on back faces
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
          // Translucency: light passing through thin leaves toward the camera
          float back = pow(max(dot(normalize(-vViewPosition), directionalLights[0].direction), 0.0), 4.0);
          reflectedLight.indirectDiffuse += diffuseColor.rgb * directionalLights[0].color * back * uTranslucency;
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => 'foliage-v1';
  return mat;
}

/** Call once per frame (any foliage mesh can do it via onBeforeRender). */
export function tickFoliage() {
  sharedTime.value = performance.now() / 1000;
}

// ------------------------------------------------------- LOD instancing --

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

/**
 * Many instances of one plant with TWO LEVELS OF DETAIL.
 *
 *  near: detailed geometry (hundreds of branch cards) for plants close to the camera
 *  far:  a cheap low-poly version for everything else
 *
 * Every few frames the instances are re-sorted into the two InstancedMeshes
 * by their distance to the camera. Copying ~6000 matrices is cheap, and the
 * GPU only draws the expensive version for the few hundred nearest plants.
 * Only the near version casts shadows (the shadow box is small anyway).
 */
export class LodInstances extends THREE.Group {
  constructor(placements, nearGeo, farGeo, material, { nearDist = 300, maxNear = 900, colorFn = null, tilt = 0, seed = 1 } = {}) {
    super();
    const n = placements.length;
    this.n = n;
    this.nearDist = nearDist;
    this.maxNear = Math.min(maxNear, n);
    this.matrices = new Float32Array(n * 16);
    this.colors = new Float32Array(n * 3);
    this.xz = new Float32Array(n * 2);
    const rand = mulberry32(seed);
    const box = new THREE.Box3();
    placements.forEach((pl, i) => {
      _p.set(pl.x, pl.y, pl.z);
      _e.set((rand() - 0.5) * tilt, pl.rotY ?? rand() * Math.PI * 2, (rand() - 0.5) * tilt);
      _q.setFromEuler(_e);
      if (typeof pl.scale === 'number') _s.setScalar(pl.scale);
      else _s.copy(pl.scale);
      _m.compose(_p, _q, _s);
      _m.toArray(this.matrices, i * 16);
      if (colorFn) colorFn(rand, _c);
      else _c.setScalar(0.85 + rand() * 0.3);
      _c.toArray(this.colors, i * 3);
      this.xz[i * 2] = pl.x;
      this.xz[i * 2 + 1] = pl.z;
      box.expandByPoint(_p);
    });
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    sphere.radius += 30;

    const mk = (geo, count, shadow) => {
      const m = new THREE.InstancedMesh(geo, material, Math.max(1, count));
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.boundingSphere = sphere.clone();
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.count = 0;
      m.onBeforeRender = tickFoliage;
      this.add(m);
      return m;
    };
    this.near = mk(nearGeo, this.maxNear, true);
    this.far = mk(farGeo, n, false);
    this.lastX = Infinity;
    this.lastZ = Infinity;
    this.d2 = new Float32Array(n);
    // Before the first update, show everything with the cheap version
    this.assign(null);
  }

  /** Re-bucket instances when the camera has moved a few metres. */
  update(camera) {
    const cx = camera.position.x, cz = camera.position.z;
    if (Math.hypot(cx - this.lastX, cz - this.lastZ) < 8) return;
    this.lastX = cx;
    this.lastZ = cz;
    this.assign(camera.position);
  }

  assign(cam) {
    const { n, xz, d2, matrices, colors } = this;
    let r2 = this.nearDist * this.nearDist;
    let nearCount = 0;
    if (cam) {
      for (let i = 0; i < n; i++) {
        const dx = xz[i * 2] - cam.x, dz = xz[i * 2 + 1] - cam.z;
        d2[i] = dx * dx + dz * dz;
        if (d2[i] < r2) nearCount++;
      }
      // Too many near plants: shrink the radius until they fit
      while (nearCount > this.maxNear) {
        r2 *= 0.8;
        nearCount = 0;
        for (let i = 0; i < n; i++) if (d2[i] < r2) nearCount++;
      }
    }
    const nm = this.near.instanceMatrix.array, nc = this.near.instanceColor.array;
    const fm = this.far.instanceMatrix.array, fc = this.far.instanceColor.array;
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      if (cam && d2[i] < r2) {
        nm.set(matrices.subarray(i * 16, i * 16 + 16), a * 16);
        nc.set(colors.subarray(i * 3, i * 3 + 3), a * 3);
        a++;
      } else {
        fm.set(matrices.subarray(i * 16, i * 16 + 16), b * 16);
        fc.set(colors.subarray(i * 3, i * 3 + 3), b * 3);
        b++;
      }
    }
    this.near.count = a;
    this.far.count = b;
    this.near.visible = a > 0;
    this.far.visible = b > 0;
    for (const m of [this.near, this.far]) {
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, m.count * 16);
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.clearUpdateRanges();
      m.instanceColor.addUpdateRange(0, m.count * 3);
      m.instanceColor.needsUpdate = true;
    }
  }
}
