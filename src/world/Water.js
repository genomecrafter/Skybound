import * as THREE from 'three';
import { createNoise4D } from 'simplex-noise';
import vertexShader from '../shaders/water.vert.glsl?raw';
import fragmentShader from '../shaders/water.frag.glsl?raw';
import { mulberry32 } from '../utils/math.js';

/**
 * Tileable ripple NORMAL MAP computed from noise (no image files).
 * Height = fractal 4D simplex noise sampled on a torus (seamless tiling, the
 * same trick as TerrainDetail.js), sharpened into narrow crests the way
 * wind ripples look. The normal at each pixel comes from the height
 * differences to its neighbours (central differences, wrapping at the edges).
 *   RGB = normal (x, y = slopes, z = up) packed into 0..1;  A = height (foam pattern)
 */
let rippleCache = null;
function makeRippleNormalMap(size = 256, seed = 7) {
  if (rippleCache) return rippleCache;
  const noise4D = createNoise4D(mulberry32(seed));
  const TAU = Math.PI * 2;
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const cu = Math.cos(TAU * u), su = Math.sin(TAU * u), cv = Math.cos(TAU * v), sv = Math.sin(TAU * v);
      let sum = 0, amp = 1, f = 1.1;
      for (let o = 0; o < 5; o++) {
        const n = noise4D(cu * f, su * f, cv * f, sv * f);
        sum += amp * (1 - Math.abs(n)) ** 2; // ridged: sharp crests, round troughs
        amp *= 0.5;
        f *= 2.03;
      }
      h[y * size + x] = sum;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  const strength = 2.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = (-dx / len * 0.5 + 0.5) * 255;
      data[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      data[i + 3] = Math.min(1, h[y * size + x] / 1.6) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace; // data, not colour
  tex.needsUpdate = true;
  rippleCache = tex;
  return tex;
}

/**
 * A spread of Gerstner waves around one wind direction: wavelengths from a
 * long swell down to short chop, steepness shared out so the crests never
 * loop over themselves (sum of steepness < 1).
 */
function defaultWaves(windAngle = -1.9) {
  const L = [72, 47, 33, 23, 16, 11.5, 8.2, 6.1];
  const Q = [0.11, 0.11, 0.1, 0.1, 0.09, 0.08, 0.08, 0.07];
  const spread = [0, 0.75, -0.6, 1.25, -1.05, 0.4, -1.5, 1.9];
  return L.map((l, i) => {
    const a = windAngle + spread[i];
    return [Math.cos(a), Math.sin(a), Q[i], l];
  });
}

/**
 * Animated ocean surface.
 *
 * GEOMETRY: a "polar grid" (concentric rings) instead of a uniform plane.
 * Ring radii grow with a power curve, so vertices are dense right under the
 * camera (where wave detail is visible) and sparse near the horizon.
 * ~64k vertices cover a 3.3 km radius (beyond that, fog hides everything):
 * a simple level-of-detail technique.
 *
 * The mesh is re-centred under the camera every frame, and the vertex shader
 * evaluates the waves at WORLD coordinates, so the waves stay fixed in the
 * world while the mesh travels with the player: the ocean looks endless.
 */
export class Water {
  /**
   * @param {object} o
   * @param {number} o.level  sea level (world y)
   * @param {object} o.colors { deep, shallow, skyTop, skyHorizon, sun, sss }
   * @param {THREE.Vector3} o.sunDir
   */
  constructor({ level = 0, colors, sunDir, waves, radius = 3300 }) {
    this.level = level;
    const list = (waves ?? defaultWaves()).slice(0, 8);
    while (list.length < 8) list.push([1, 0, 0, 10]); // unused slots: zero steepness
    // Sum of amplitudes (a = Q / k): normalises the crest height
    const waveHeight = list.reduce((s, w) => s + (w[2] * w[3]) / (Math.PI * 2), 0);

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog, // fogColor, fogNear, fogFar... filled in by the renderer
      {
        uTime: { value: 0 },
        uWaves: { value: list.map((w) => new THREE.Vector4(...w)) },
        uDeepColor: { value: new THREE.Color(colors.deep) },
        uShallowColor: { value: new THREE.Color(colors.shallow) },
        uSkyTop: { value: new THREE.Color(colors.skyTop) },
        uSkyHorizon: { value: new THREE.Color(colors.skyHorizon) },
        uSunColor: { value: new THREE.Color(colors.sun) },
        uSssColor: { value: new THREE.Color(colors.sss ?? 0x1f6f6a) },
        uSunDir: { value: sunDir.clone().normalize() },
        uWaveHeight: { value: waveHeight * 0.6 },
        uNormalMap: { value: null },
        uSkyCube: { value: null },
        uHasSkyCube: { value: 0 },
      },
    ]);
    // Textures must not be cloned by UniformsUtils.merge: set them afterwards
    uniforms.uNormalMap.value = makeRippleNormalMap();

    this.material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, fog: true });
    this.uniforms = this.material.uniforms;

    this.mesh = new THREE.Mesh(this.buildPolarGrid(radius, 260, 288, 2.0), this.material);
    this.mesh.name = 'Ocean';
    this.mesh.position.y = level;
    // The shader moves vertices, so the CPU bounding sphere is not reliable
    this.mesh.frustumCulled = false;
  }

  /** Concentric-ring grid: radius r_i = maxR * (i / rings)^power. */
  buildPolarGrid(maxR, rings, segments, power) {
    const positions = [0, 0, 0]; // centre vertex
    for (let i = 1; i <= rings; i++) {
      const r = maxR * Math.pow(i / rings, power);
      for (let j = 0; j < segments; j++) {
        const a = (j / segments) * Math.PI * 2;
        positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
      }
    }
    const idx = [];
    const ring = (i, j) => 1 + (i - 1) * segments + (j % segments);
    // Inner fan around the centre vertex
    for (let j = 0; j < segments; j++) idx.push(0, ring(1, j + 1), ring(1, j));
    // Quads between consecutive rings (two triangles each), wound to face +Y
    for (let i = 1; i < rings; i++) {
      for (let j = 0; j < segments; j++) {
        const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j), d = ring(i + 1, j + 1);
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(idx);
    return geo;
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {import('./Environment.js').Environment} [env] provides the sky cube map for reflections
   */
  update(dt, camera, env) {
    this.uniforms.uTime.value += dt;
    const cube = env?.skyCube?.texture ?? null;
    this.uniforms.uSkyCube.value = cube;
    this.uniforms.uHasSkyCube.value = cube ? 1 : 0;
    // Follow the camera horizontally (waves are computed in world space)
    this.mesh.position.x = camera.position.x;
    this.mesh.position.z = camera.position.z;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
