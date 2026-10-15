import * as THREE from 'three';
import { mulberry32 } from '../utils/math.js';
import { CONFIG } from '../config.js';
import {
  GeoBuilder, region, createFoliageMaterial, tickFoliage, LodInstances,
  makeConiferAtlas, makePalmAtlas, makeShrubAtlas,
} from './Foliage.js';

/**
 * Scenery props drawn with INSTANCING.
 *
 * An InstancedMesh draws N copies of one geometry in a SINGLE draw call.
 * Each copy has its own 4x4 transform matrix (translation * rotation * scale)
 * stored in a GPU buffer, plus an optional per-instance colour. 300 trees
 * cost about the same CPU time as one tree, whereas 300 separate Meshes would
 * be 300 draw calls.
 *
 * Every placement is { x, y, z, scale (number or Vector3), rotY }.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

/** Give every vertex of a geometry the same colour (for vertex-coloured merges). */
export function paint(geo, color) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Build an InstancedMesh from placements; composes T*R*S matrices per instance. */
export function makeInstanced(geometry, material, placements, { colorJitter = 0, seed = 1, tilt = 0 } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  const rand = mulberry32(seed);
  placements.forEach((pl, i) => {
    _p.set(pl.x, pl.y, pl.z);
    // Random lean (tilt) + rotation about Y, so copies don't look identical
    _e.set((rand() - 0.5) * tilt, pl.rotY ?? rand() * Math.PI * 2, (rand() - 0.5) * tilt);
    _q.setFromEuler(_e);
    if (typeof pl.scale === 'number') _s.setScalar(pl.scale);
    else _s.copy(pl.scale);
    _m.compose(_p, _q, _s); // matrix = Translation * Rotation * Scale
    mesh.setMatrixAt(i, _m);
    if (colorJitter) {
      const v = 1 - colorJitter / 2 + rand() * colorJitter;
      mesh.setColorAt(i, _c.setScalar(v));
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ rocks --

/** Low-poly boulder: an icosahedron (20 faces) with flat shading. */
export function createRocks(placements, color = 0x6f625a, seed = 3) {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true });
  return makeInstanced(geo, mat, placements, { colorJitter: 0.35, seed, tilt: 0.8 });
}

/**
 * Sea-stack / rock pillar: a cylinder whose vertices are pushed in and out
 * randomly, giving an irregular eroded column. Unit size: radius 1, height 1,
 * base at y = 0; instances are scaled to the right size.
 */
export function createPillars(placements, color = 0x5e4d45, seed = 5) {
  const geo = new THREE.CylinderGeometry(0.75, 1, 1, 9, 6).translate(0, 0.5, 0);
  const rand = mulberry32(seed);
  const jitter = Array.from({ length: 9 * 7 }, () => 0.8 + rand() * 0.35);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > 0.999) continue; // keep the top cap flat-ish
    // Look the jitter up by (angle step, height step) so duplicated seam
    // vertices get the same offset and no cracks open in the surface.
    const a = (Math.round(Math.atan2(pos.getZ(i), pos.getX(i)) / ((Math.PI * 2) / 9)) + 9) % 9;
    const k = jitter[Math.round(y * 6) * 9 + a];
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true });
  return makeInstanced(geo, mat, placements, { colorJitter: 0.25, seed });
}

// ------------------------------------------------------------------ trees --
//
// Trees and plants use the foliage system in Foliage.js: textured branch
// cards (alpha-tested), outward "volume" normals, baked ambient occlusion and
// two levels of detail. See that file's header for the techniques.

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Normal pointing away from the tree axis, bent upward by `upBias`. */
function volumeNormal(p, upBias, out = _n) {
  out.set(p.x, 0, p.z);
  const l = out.length();
  if (l > 1e-4) out.multiplyScalar(1 / l);
  return out.multiplyScalar(0.8).addScaledVector(UP, upBias).normalize();
}

/** Tapered tube around the Y axis (trunks), uv in the atlas bark region. */
function addTrunk(b, y0, y1, r0, r1, sides, rows, ao0, ao1) {
  const start = b.count;
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const y = y0 + (y1 - y0) * t, rad = r0 + (r1 - r0) * t;
    for (let c = 0; c <= sides; c++) {
      const a = (c / sides) * Math.PI * 2;
      _a.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
      _n.set(Math.cos(a), 0.15, Math.sin(a)).normalize();
      b.vert(_a, _n, region('bark', c / sides), t, ao0 + (ao1 - ao0) * t);
    }
  }
  b.grid(start, rows, sides + 1);
}

// Crown outline of a spruce: radius as a function of relative height t (0..1)
const SPRUCE_H = 9, SPRUCE_Y0 = 1.1;
const spruceRadius = (t) => 3.0 * Math.pow(Math.max(0, 1 - t), 0.95) + 0.1;

/**
 * Detailed spruce (near LOD, ~1000 triangles). Whorls of drooping branches;
 * each branch is one card folded along its twig into a shallow "^" so it has
 * volume from the side and from above.
 */
function buildSpruceNear(seed) {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  const H = SPRUCE_H, y0 = SPRUCE_Y0;
  addTrunk(b, -0.5, H * 0.94, 0.3, 0.035, 7, 5, 0.8, 0.45);

  // Dense inner core: stops you seeing straight through the crown
  const coreStart = b.count, sides = 9, rows = 6;
  const jit = Array.from({ length: rows * sides }, () => 0.8 + rand() * 0.4);
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const y = y0 + 0.3 + t * (H - y0 - 0.3);
    for (let c = 0; c <= sides; c++) {
      const a = (c / sides) * Math.PI * 2;
      const rad = 0.3 * spruceRadius(t) * (r === rows - 1 ? 0 : jit[r * sides + (c % sides)]);
      _a.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
      _n.set(Math.cos(a), 0.6, Math.sin(a)).normalize();
      b.vert(_a, _n, region('dense', c / sides), t, 0.5 + 0.25 * t, 0.35 + 0.4 * t);
    }
  }
  b.grid(coreStart, rows, sides + 1);

  // Branch whorls
  const whorls = 16, segs = 3, fold = 0.45;
  for (let w = 0; w < whorls; w++) {
    const t = Math.pow(w / (whorls - 1), 0.92);
    const y = y0 + t * (H - 0.35 - y0) + (rand() - 0.5) * 0.15;
    const R = spruceRadius(t);
    const nb = Math.max(4, Math.round(8 - 3 * t));
    const off = w * 2.4;
    for (let k = 0; k < nb; k++) {
      const az = off + (k / nb) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const L = R * (0.85 + rand() * 0.3);
      if (L < 0.3) continue;
      const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);
      const droop = 0.1 + 0.4 * (1 - t) + rand() * 0.08;
      const lift = 0.05 + 0.3 * t;
      const hw = L * 0.3; // the spray texture is 2:1 (slightly widened)
      const shade = 0.88 + rand() * 0.24;
      const start = b.count;
      for (let i = 0; i <= segs; i++) {
        const s = i / segs;
        _b.copy(dir).multiplyScalar(0.06 + L * s).addScaledVector(UP, y + L * (lift * s - droop * s * s));
        for (let j = -1; j <= 1; j++) {
          _a.copy(_b).addScaledVector(perp, j * hw * Math.cos(fold)).addScaledVector(UP, -Math.abs(j) * hw * Math.sin(fold));
          const radial = Math.min(1, Math.hypot(_a.x, _a.z) / Math.max(R, 0.5));
          volumeNormal(_a, 0.45 + 0.35 * t);
          const ao = (0.6 + 0.4 * radial) * (0.78 + 0.22 * t) * shade;
          const snow = (j === 0 ? 1 : 0.3) * Math.min(1, 0.25 + s * 1.5);
          b.vert(_a, _n, region('spray', s), (j + 1) / 2, ao, snow);
        }
      }
      b.grid(start, segs + 1, 3);
    }
  }
  return b.build();
}

/** Cheap spruce (far LOD, ~170 triangles): stacked star-shaped skirts. */
function buildSpruceFar() {
  const b = new GeoBuilder();
  const H = SPRUCE_H, y0 = SPRUCE_Y0;
  addTrunk(b, -0.5, y0 + 0.5, 0.3, 0.22, 4, 2, 0.7, 0.5);
  const layers = 5, pts = 16;
  for (let l = 0; l < layers; l++) {
    const tb = l / layers;
    const yb = y0 - 0.2 + tb * (H - y0);
    const yt = Math.min(H, yb + ((H - y0) / layers) * 1.8);
    const Rb = spruceRadius(tb);
    const start = b.count;
    for (let row = 0; row < 2; row++) {
      for (let c = 0; c <= pts; c++) {
        const a = (c / pts) * Math.PI * 2 + l * 0.7;
        const tip = c % 2 === 0;
        const rad = row === 0 ? Rb * (tip ? 1 : 0.72) : l === layers - 1 ? 0 : Rb * 0.18;
        const y = row === 0 ? yb - (tip ? 0.25 * Rb : 0.1 * Rb) : yt;
        _a.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
        _n.set(Math.cos(a), 0.55 + 0.3 * tb, Math.sin(a)).normalize();
        b.vert(_a, _n, region('dense', c / pts), row, row === 0 ? (tip ? 0.95 : 0.75) : 0.55, row === 0 ? 0.4 : 0.85);
      }
    }
    b.grid(start, 2, pts + 1);
  }
  return b.build();
}

const spruceGeoCache = {};
function spruceGeometries() {
  if (!spruceGeoCache.near) {
    spruceGeoCache.near = buildSpruceNear(21);
    spruceGeoCache.far = buildSpruceFar();
  }
  // Clones, so a route disposing its meshes does not break the cache
  return { near: spruceGeoCache.near.clone(), far: spruceGeoCache.far.clone() };
}

/**
 * Conifer forest (spruce). The snowy variant mixes snow onto the top of every
 * branch. Returns a LodInstances group: call `.update(camera)` every frame.
 */
export function createPines(placements, { snowy = false, seed = 13 } = {}) {
  const rand = mulberry32(seed + 1);
  // Vary the proportions a little (some slimmer, some wider trees)
  const pls = placements.map((p) => {
    const s = typeof p.scale === 'number' ? p.scale : 1;
    const w = 0.8 + rand() * 0.35;
    return { ...p, scale: new THREE.Vector3(s * w, s, s * w) };
  });
  const { near, far } = spruceGeometries();
  const mat = createFoliageMaterial(makeConiferAtlas(seed), {
    tintColor: 0xeef3fa,
    tintAmount: snowy ? 0.95 : 0,
    translucency: 0.12,
    wind: 0.6,
    roughness: 0.9,
  });
  const forest = new LodInstances(pls, near, far, mat, {
    nearDist: 260,
    maxNear: CONFIG.quality === 'low' ? 350 : 800,
    tilt: 0.06,
    seed,
    colorFn: (r, c) => {
      // Per-tree colour: blue-green to yellow-green, darker or lighter
      const v = 0.78 + r() * 0.35;
      const warm = r();
      c.setRGB(v * (0.88 + warm * 0.2), v * (0.97 + warm * 0.05), v * (1.02 - warm * 0.2));
    },
  });
  forest.name = snowy ? 'SnowySpruces' : 'Spruces';
  return forest;
}

/**
 * Palm tree (~8.5 m): curved ringed trunk, fibrous crown, 13 arching fronds,
 * 3 dead hanging fronds and a few coconuts, all one geometry.
 */
function buildPalm(seed) {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(0, -0.5, 0),
    new THREE.Vector3(0.1, 4.5, 0),
    new THREE.Vector3(1.5, 8.2, 0),
  );
  const Z = new THREE.Vector3(0, 0, 1);
  const T = new THREE.Vector3(), X = new THREE.Vector3(), P = new THREE.Vector3();
  const rows = 14, sides = 8;
  let start = b.count;
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    curve.getPoint(t, P);
    curve.getTangent(t, T);
    X.crossVectors(T, Z).normalize();
    const rad = 0.2 + 0.06 * (1 - t) + 0.22 * Math.pow(1 - t, 8);
    for (let c = 0; c <= sides; c++) {
      const a = (c / sides) * Math.PI * 2;
      _n.copy(X).multiplyScalar(Math.cos(a)).addScaledVector(Z, Math.sin(a));
      _a.copy(P).addScaledVector(_n, rad);
      b.vert(_a, _n, region('bark', c / sides), t, 0.9 - 0.2 * t);
    }
  }
  b.grid(start, rows, sides + 1);

  const top = curve.getPoint(1);
  // Fibrous husk around the top of the trunk
  start = b.count;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c <= sides; c++) {
      const a = (c / sides) * Math.PI * 2;
      const rad = [0.24, 0.42, 0.12][r];
      _n.set(Math.cos(a), 0.3, Math.sin(a)).normalize();
      _a.set(top.x + Math.cos(a) * rad, top.y - 0.6 + r * 0.45, top.z + Math.sin(a) * rad);
      b.vert(_a, _n, region('dense', c / sides), r / 2, 0.7);
    }
  }
  b.grid(start, 3, sides + 1);

  // Fronds: integrate a curve that arches up and then droops
  const frond = (az, e0, len, bend, tint, ao) => {
    const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    const segs = 7, hw = len * 0.25;
    const p = top.clone().addScaledVector(UP, 0.15);
    const s0 = b.count;
    for (let i = 0; i <= segs; i++) {
      const s = i / segs;
      if (i > 0) {
        const th = e0 - bend * s;
        p.addScaledVector(dir, (Math.cos(th) * len) / segs).addScaledVector(UP, (Math.sin(th) * len) / segs);
      }
      const f = 0.35 + 0.55 * s; // leaflets hang more toward the tip
      for (let j = -1; j <= 1; j++) {
        _a.copy(p).addScaledVector(perp, j * hw * Math.cos(f)).addScaledVector(UP, -Math.abs(j) * hw * Math.sin(f));
        _n.copy(dir).multiplyScalar(0.45).addScaledVector(UP, 0.9).addScaledVector(perp, j * 0.25).normalize();
        b.vert(_a, _n, region('spray', s), (j + 1) / 2, ao * (0.8 + 0.2 * s), tint);
      }
    }
    b.grid(s0, segs + 1, 3);
  };
  const N = 13;
  for (let k = 0; k < N; k++) {
    const az = (k / N) * Math.PI * 2 + (rand() - 0.5) * 0.35;
    frond(az, 0.2 + rand() * 0.9, 3.8 + rand() * 1.4, 1.5 + rand() * 0.6, rand() < 0.15 ? 0.35 : 0, 0.85 + rand() * 0.2);
  }
  for (let k = 0; k < 3; k++) frond(rand() * Math.PI * 2, -1.0 - rand() * 0.3, 2.4 + rand() * 0.6, 0.3, 1, 0.6);

  // Coconuts
  const nut = new THREE.IcosahedronGeometry(0.17, 1);
  const np = nut.attributes.position, nn = nut.attributes.normal;
  for (let k = 0; k < 4; k++) {
    const a = k * 1.7 + rand();
    const cx = top.x + Math.cos(a) * 0.3, cy = top.y - 0.25 - rand() * 0.15, cz = top.z + Math.sin(a) * 0.3;
    const s0 = b.count;
    for (let i = 0; i < np.count; i++) {
      _a.set(cx + np.getX(i), cy + np.getY(i), cz + np.getZ(i));
      _n.set(nn.getX(i), nn.getY(i), nn.getZ(i));
      b.vert(_a, _n, region('dense', 0.5), 0.5, 0.65, 0);
      b.idx.push(s0 + i);
    }
  }
  nut.dispose();
  return b.build();
}

export function createPalms(placements, seed = 11) {
  const geo = buildPalm(seed);
  const mat = createFoliageMaterial(makePalmAtlas(seed), {
    tintColor: 0x8a6c42, tintAmount: 1, translucency: 0.45, wind: 1.6, roughness: 0.75,
  });
  const mesh = makeInstanced(geo, mat, placements, { seed, tilt: 0.12 });
  // Per-tree colour variety (greener / more yellow)
  const rand = mulberry32(seed + 3);
  for (let i = 0; i < placements.length; i++) {
    const v = 0.85 + rand() * 0.25, y = rand();
    mesh.setColorAt(i, _c.setRGB(v * (0.92 + y * 0.15), v, v * (1 - y * 0.15)));
  }
  mesh.onBeforeRender = tickFoliage;
  mesh.name = 'Palms';
  return mesh;
}

// ----------------------------------------------------------------- desert --

/**
 * Ribbed tube along a planar (XY) curve: the cross-section radius is pushed
 * in at `ribs` grooves, like the pleats of a saguaro. Smooth vertex normals.
 */
function addRibbed(b, curve, radiusAt, along, around, ribs) {
  const Z = new THREE.Vector3(0, 0, 1);
  const T = new THREE.Vector3(), X = new THREE.Vector3(), P = new THREE.Vector3();
  const start = b.count;
  for (let r = 0; r <= along; r++) {
    const t = r / along;
    curve.getPoint(t, P);
    curve.getTangent(t, T);
    X.crossVectors(T, Z).normalize();
    const R = radiusAt(t);
    for (let c = 0; c < around; c++) {
      const a = (c / around) * Math.PI * 2;
      const rib = ribs ? 0.9 + 0.1 * Math.pow(Math.abs(Math.cos((ribs * a) / 2)), 0.6) : 1;
      _n.copy(X).multiplyScalar(Math.cos(a)).addScaledVector(Z, Math.sin(a));
      _a.copy(P).addScaledVector(_n, R * rib);
      // Ridges lighter, grooves darker; paler new growth near the tips
      const k = ribs ? 0.7 + 0.3 * (rib - 0.9) * 10 : 0.9;
      b.vert(_a, _n, 0, 0, k * (0.85 + 0.15 * t), t > 0.9 ? (t - 0.9) * 6 : 0);
    }
  }
  b.grid(start, along + 1, around, true);
}

/** Saguaro: ribbed trunk + two curved arms (near or far detail). */
function buildCactus(detail) {
  const hi = detail === 'near';
  const b = new GeoBuilder();
  const ribs = hi ? 12 : 0, around = hi ? 36 : 7;
  const dome = (r0, tc) => (t) => (t < tc ? r0 * (1 - 0.1 * t) : r0 * 0.9 * Math.sqrt(Math.max(0, 1 - ((t - tc) / (1 - tc)) ** 2)) + 0.001);
  const trunk = new THREE.LineCurve3(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(0, 7.45, 0));
  addRibbed(b, trunk, dome(0.5, 0.92), hi ? 14 : 4, around, ribs);
  for (const [side, h, len, rot] of [[1, 3.2, 2.4, 0.3], [-1, 4.2, 1.8, -0.4]]) {
    const arm = new THREE.CubicBezierCurve3(
      new THREE.Vector3(side * 0.2, h, 0),
      new THREE.Vector3(side * 1.3, h - 0.15, 0),
      new THREE.Vector3(side * 1.5, h + 0.2, 0),
      new THREE.Vector3(side * 1.5, h + len + 0.3, 0),
    );
    const s0 = b.count;
    addRibbed(b, arm, dome(0.32, 0.88), hi ? 12 : 4, around, ribs);
    // Rotate the arm about the trunk axis
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let i = s0; i < b.count; i++) {
      const x = b.pos[i * 3], z = b.pos[i * 3 + 2];
      b.pos[i * 3] = x * cr - z * sr;
      b.pos[i * 3 + 2] = x * sr + z * cr;
    }
  }
  const geo = b.build();
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  return geo;
}

/** Saguaro cacti with two levels of detail. Call `.update(camera)` every frame. */
export function createCacti(placements, seed = 17) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, color: 0x86a06a });
  // aTint (= pale tips) is not used by the standard material; bake it into the colour
  const near = buildCactus('near'), far = buildCactus('far');
  for (const g of [near, far]) {
    const col = g.attributes.color, tint = g.attributes.aTint;
    for (let i = 0; i < col.count; i++) {
      const t = Math.min(1, tint.getX(i));
      col.setXYZ(i, col.getX(i) * (1 + 0.25 * t), col.getY(i) * (1 + 0.15 * t), col.getZ(i) * (1 - 0.1 * t));
    }
  }
  const group = new LodInstances(placements, near, far, mat, {
    nearDist: 220,
    maxNear: 300,
    tilt: 0.1,
    seed,
    colorFn: (r, c) => {
      const v = 0.8 + r() * 0.3, y = r();
      c.setRGB(v * (0.95 + y * 0.15), v, v * (1 - y * 0.2));
    },
  });
  group.name = 'Cacti';
  return group;
}

/** Desert scrub: a dome of crossed, leafy twig cards around a dense core. */
function buildShrub(seed) {
  const rand = mulberry32(seed);
  const b = new GeoBuilder();
  const C = new THREE.Vector3(0, 0.15, 0);
  const core = new THREE.IcosahedronGeometry(0.55, 1).scale(1, 0.6, 1).translate(0, 0.22, 0);
  const cp = core.attributes.position;
  const s0 = b.count;
  for (let i = 0; i < cp.count; i++) {
    _a.set(cp.getX(i), cp.getY(i), cp.getZ(i));
    _n.subVectors(_a, C).normalize();
    b.vert(_a, _n, region('dense', 0.5 + _a.x * 0.4), 0.5 + _a.z * 0.4, 0.5 + 0.3 * Math.max(0, _a.y), 0);
    b.idx.push(s0 + i);
  }
  core.dispose();
  for (let k = 0; k < 9; k++) {
    const az = (k / 9) * Math.PI + rand() * 0.4;
    const off = new THREE.Vector3((rand() - 0.5) * 0.6, 0, (rand() - 0.5) * 0.6);
    const ax = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const w = 0.75 + rand() * 0.25, h = 0.9 + rand() * 0.3, lean = (rand() - 0.5) * 0.5;
    const half = rand() < 0.5 ? 0 : 0.5;
    const st = b.count;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const u = col * 2 - 1;
        _a.copy(off).addScaledVector(ax, u * w).addScaledVector(UP, row * h - 0.05);
        if (row) _a.addScaledVector(new THREE.Vector3(-ax.z, 0, ax.x), lean);
        _n.subVectors(_a, C).normalize().addScaledVector(UP, 0.4).normalize();
        b.vert(_a, _n, region('spray', half + col * 0.5), 1 - row, row ? 1.0 : 0.55, 0);
      }
    }
    b.idx.push(st, st + 1, st + 2, st + 1, st + 3, st + 2);
  }
  return b.build();
}

export function createShrubs(placements, color = 0x6b6a3a, seed = 19) {
  const mat = createFoliageMaterial(makeShrubAtlas(seed), { translucency: 0.25, wind: 0.8, roughness: 0.95 });
  mat.color.set(color).lerp(new THREE.Color(0xffffff), 0.55); // overall tint
  const mesh = makeInstanced(buildShrub(seed), mat, placements, { colorJitter: 0.35, seed, tilt: 0.2 });
  mesh.onBeforeRender = tickFoliage;
  mesh.name = 'Shrubs';
  return mesh;
}
