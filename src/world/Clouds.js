import * as THREE from 'three';
import vertexShader from '../shaders/cloud.vert.glsl?raw';
import fragmentShader from '../shaders/cloud.frag.glsl?raw';
import { mulberry32, clamp } from '../utils/math.js';
import { createNoise } from '../utils/noise.js';

/**
 * Procedural cumulus clouds made of instanced billboard "puffs".
 *
 *  - Each cloud is a cluster of overlapping puffs shaped like real cumulus:
 *    a wide, flat base layer and a billowing dome on top (the puffs higher
 *    up are smaller and crowd toward the middle, the "cauliflower" look).
 *  - All puffs of all clouds are ONE InstancedMesh (one draw call).
 *  - Puff texture: a 2x2 atlas generated in JavaScript. Each cell is a
 *    density field built from many small round billows, eroded by noise
 *    (crisp cauliflower edges, not soft smoke balls). Besides the opacity
 *    the texture stores a NORMAL computed from the density gradient, so every
 *    pixel of a flat billboard can be lit as if it were a bumpy 3D surface.
 *    Two cells have flat bottoms (for the base of the cloud).
 *  - Shading treats each cloud as ONE ellipsoid volume (every puff knows its
 *    cloud's centre and radii), so overlapping puffs blend into a single
 *    shape instead of showing seams: per-pixel normal of the ellipsoid, light
 *    absorbed along the path toward the sun (Beer-Lambert), a darker base and
 *    forward scattering (bright "silver lining" when looking toward the sun).
 *  - Transparency needs back-to-front drawing, so the instances are re-sorted
 *    by distance to the camera a few times per second.
 */
function makeCloudAtlas(seed = 5) {
  const S = 192; // pixels per puff cell
  const W = S * 2;
  const data = new Uint8Array(W * W * 4);
  const rand = mulberry32(seed);
  const { fbm } = createNoise(seed);
  const dens = new Float32Array(S * S);

  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * S, oy = Math.floor(cell / 2) * S;
    const flatBottom = cell < 2;
    // Billows: a few big ones in the middle, many small ones around the rim
    const blobs = [];
    for (let i = 0; i < 30; i++) {
      const big = i < 5;
      const a = rand() * Math.PI * 2;
      const r = big ? Math.sqrt(rand()) * 0.1 : 0.1 + Math.sqrt(rand()) * 0.17;
      let by = 0.5 + Math.sin(a) * r * 0.85;
      if (flatBottom) by = Math.max(by, 0.38 + rand() * 0.04) + 0.04; // keep billows above the base line
      const br = big ? 0.15 + rand() * 0.07 : 0.06 + rand() * 0.06;
      blobs.push([0.5 + Math.cos(a) * r, by, br]);
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u0 = (x + 0.5) / S, v0 = (y + 0.5) / S; // v = 0 is the bottom (texture row 0)
        // Domain warp: irregular, wind-torn billows instead of perfect circles
        const u = u0 + fbm(u0 * 3 + cell * 5, v0 * 3, 3) * 0.07;
        const v = v0 + fbm(u0 * 3 + 7.7, v0 * 3 + cell * 5, 3) * 0.07;
        // Smooth union of round billows (sum of Gaussians, compressed)
        let d = 0;
        for (const [bx, by, br] of blobs) {
          const dx = u - bx, dy = v - by;
          d += Math.exp(-((dx * dx + dy * dy) / (br * br)) * 1.1);
        }
        d = 1 - Math.exp(-d * 1.4);
        // Noise erosion: fine wispy detail on the edges
        d += fbm(u * 9 + cell * 13, v * 9, 5) * 0.4 * (1.1 - d); // erodes the edges most
        if (flatBottom) d *= clamp((v0 - 0.3) / 0.1, 0, 1);
        const edge = clamp((1 - Math.hypot(u0 - 0.5, v0 - 0.5) * 2) * 3, 0, 1); // fade to the cell border
        dens[y * S + x] = clamp(d, 0, 1.4) * edge;
      }
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = dens[y * S + x];
        const at = (xx, yy) => dens[clamp(yy, 0, S - 1) * S + clamp(xx, 0, S - 1)];
        // Normal from the density gradient (density acts as a height field)
        const gx = (at(x + 3, y) - at(x - 3, y)) * 1.6;
        const gy = (at(x, y + 3) - at(x, y - 3)) * 1.6;
        const nl = Math.hypot(gx, gy, 1);
        const i = ((oy + y) * W + ox + x) * 4;
        data[i] = (-gx / nl * 0.5 + 0.5) * 255;
        data[i + 1] = (-gy / nl * 0.5 + 0.5) * 255;
        data[i + 2] = clamp((d - 0.5) * 2, 0, 1) * 255; // thickness (core of the puff)
        data[i + 3] = Math.pow(clamp((d - 0.36) / 0.36, 0, 1), 1.3) * 255; // soft edge
      }
    }
  }
  const tex = new THREE.DataTexture(data, W, W, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace; // data, not colour
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const _m = new THREE.Matrix4();

export class Clouds {
  /**
   * @param {object} o
   * @param {number} o.count       number of clouds
   * @param {object} o.area        { x, z, radius }
   * @param {[number, number]} o.altitude  base altitude range
   * @param {[number, number]} o.size      cloud radius range (m)
   * @param {THREE.Vector3} o.sunDir
   * @param {number|string} o.litColor     colour of the sun-lit side
   * @param {number|string} o.shadowColor  colour of the shaded side / base
   * @param {number|string} [o.skyColor]   ambient light from the sky above (top of the cloud)
   */
  constructor({ count, area, altitude, size, sunDir, litColor, shadowColor, skyColor, opacity = 0.95, seed = 1 }) {
    const rand = mulberry32(seed);
    const sun = sunDir.clone().normalize();
    const puffs = [];

    for (let c = 0; c < count; c++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * area.radius;
      const cx = area.x + Math.cos(a) * r;
      const cz = area.z + Math.sin(a) * r;
      const cy = altitude[0] + rand() * (altitude[1] - altitude[0]);
      const R = size[0] + rand() * (size[1] - size[0]);
      const tall = 0.5 + rand() * 0.6; // some clouds are towering, others flat
      const stretch = 1 + rand() * 0.6;
      const yaw = rand() * Math.PI;
      const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);

      // The whole cloud is lit as one ellipsoid volume (see cloud.frag.glsl)
      const center = new THREE.Vector3(cx, cy + R * (0.12 + tall * 0.42), cz);
      const radii = new THREE.Vector3(R * (0.95 + stretch * 0.25), R * (0.3 + tall * 0.55), R * (0.95 + stretch * 0.25));
      const add = (lx, ly, lz, size, variant, spin) => {
        const x = lx * cyaw - lz * syaw, z = lx * syaw + lz * cyaw;
        puffs.push({
          pos: new THREE.Vector3(cx + x, cy + ly, cz + z),
          size,
          center,
          radii,
          variant,
          spin,
          opacity: opacity * (0.85 + rand() * 0.15),
          dist: 0,
        });
      };

      // Flat base: wide puffs with flat-bottom textures, no spin
      const nb = 5 + Math.floor(rand() * 4);
      for (let i = 0; i < nb; i++) {
        const t = (i / (nb - 1) - 0.5) * 2;
        add(t * R * 0.85 * stretch, R * 0.12, (rand() - 0.5) * R * 0.7, R * (0.75 + rand() * 0.3), Math.floor(rand() * 2), 0);
      }
      // Billowing dome: smaller puffs toward the top and centre
      const nd = 10 + Math.floor(rand() * 12);
      for (let i = 0; i < nd; i++) {
        const ang = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand());
        const lx = Math.cos(ang) * rr * R * 0.8 * stretch;
        const lz = Math.sin(ang) * rr * R * 0.6;
        const hmax = R * tall * (1 - rr * rr * 0.8);
        const ly = R * 0.25 + rand() * hmax;
        const k = ly / (R * (0.25 + tall));
        add(lx, ly, lz, R * (0.75 - k * 0.35) * (0.8 + rand() * 0.4), 2 + Math.floor(rand() * 2), (rand() - 0.5) * 0.8);
      }
    }
    this.puffs = puffs;

    const geo = new THREE.PlaneGeometry(1, 1);
    const n = puffs.length;
    this.attr = {
      aCenter: new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3),
      aRadii: new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3),
      aVariant: new THREE.InstancedBufferAttribute(new Float32Array(n), 1),
      aSpin: new THREE.InstancedBufferAttribute(new Float32Array(n), 1),
      aOpacity: new THREE.InstancedBufferAttribute(new Float32Array(n), 1),
    };
    for (const [k, a] of Object.entries(this.attr)) {
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(k, a);
    }

    const shadow = new THREE.Color(shadowColor);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uMap: { value: null },
          uLitColor: { value: new THREE.Color(litColor) },
          uShadowColor: { value: shadow },
          uSkyColor: { value: new THREE.Color(skyColor ?? shadow.clone().lerp(new THREE.Color(litColor), 0.35)) },
          uSunDir: { value: sun.clone() },
        },
      ]),
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.material.uniforms.uMap.value = makeCloudAtlas(seed + 7);

    this.mesh = new THREE.InstancedMesh(geo, this.material, n);
    this.mesh.name = 'Clouds';
    this.mesh.frustumCulled = false; // billboards are expanded in the shader
    this.mesh.renderOrder = 1; // after opaque geometry
    this.sortTimer = 0;
    this.writeInstances();
  }

  /** Copy puffs (in current order) into the GPU instance buffers. */
  writeInstances() {
    const { aCenter, aRadii, aVariant, aSpin, aOpacity } = this.attr;
    this.puffs.forEach((p, i) => {
      _m.makeScale(p.size, p.size, p.size).setPosition(p.pos);
      this.mesh.setMatrixAt(i, _m);
      p.center.toArray(aCenter.array, i * 3);
      p.radii.toArray(aRadii.array, i * 3);
      aVariant.array[i] = p.variant;
      aSpin.array[i] = p.spin;
      aOpacity.array[i] = p.opacity;
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    for (const a of Object.values(this.attr)) a.needsUpdate = true;
  }

  update(dt, camera) {
    // Painter's algorithm: draw far puffs first. Sorting ~800 items 4x per
    // second is negligible on the CPU.
    this.sortTimer -= dt;
    if (this.sortTimer > 0) return;
    this.sortTimer = 0.25;
    for (const p of this.puffs) p.dist = p.pos.distanceToSquared(camera.position);
    this.puffs.sort((a, b) => b.dist - a.dist);
    this.writeInstances();
  }
}
