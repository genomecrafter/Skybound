import * as THREE from 'three';
import { Route } from './Route.js';
import { Terrain } from '../world/Terrain.js';
import { Aurora } from '../world/Aurora.js';
import { Stars } from '../world/Stars.js';
import { Snow } from '../world/Snow.js';
import { RingCourse } from '../world/Rings.js';
import { createPines, createRocks } from '../world/Props.js';
import { createGlowSprite } from '../world/Glow.js';
import { createNoise } from '../utils/noise.js';
import { mulberry32, smoothstep } from '../utils/math.js';
import { CONFIG } from '../config.js';

/**
 * ROUTE 1 - AURORA FLYOVER
 * A night flight down a snowy arctic valley, over a frozen lake with a small
 * cabin village, under animated aurora curtains and a sky full of stars.
 *
 * Lighting design (night):
 *  - Moon = DirectionalLight, cold blue-white, casting soft shadows.
 *  - HemisphereLight: deep blue sky / near-black ground. Its sky colour is
 *    tinted green in real time by the aurora's brightness, so the snow
 *    picks up a faint green glow when the aurora flares.
 *  - Warm PointLight in the cabin village + emissive windows (colour contrast).
 *  - Aircraft nav lights at full strength: very visible at night.
 */

// Winding valley centre-line: x as a function of z
const valleyX = (z) => Math.sin(z / 700) * 350 + Math.sin(z / 260) * 70;
const LAKE = { z: -300, r: 230, level: 30 };
LAKE.x = valleyX(LAKE.z);

export class AuroraRoute extends Route {
  id = 'aurora';
  name = 'Aurora Flyover';
  subtitle = 'A moonlit valley beneath the northern lights';

  atmosphere = {
    sunDir: new THREE.Vector3(-0.35, 0.32, -0.7), // the moon, low ahead-left
    sky: {
      top: 0x01030b, horizon: 0x0f2342, bottom: 0x05070f,
      sunColor: 0x8f9bb3, sunSize: 0.03, sunGlow: 0.5, gradientExp: 0.5,
    },
    sunLight: { color: 0xa9c1ff, intensity: 1.1 },
    hemi: { sky: 0x2a4a6a, ground: 0x0a0f1a, intensity: 0.8 },
    fog: { color: 0x0b1830, near: 400, far: 3400 },
    exposure: 1.15,
    envIntensity: 0.6,
  };

  post = { bloom: 0.9, flare: 0.25, flareColor: 0xcfdfff, saturation: 1.15, vignette: 0.45 };
  ambience = 'arctic'; // AudioEngine background sound
  humidity = 0.8;
  navLightStrength = 1.6;

  spawn = {
    position: new THREE.Vector3(valleyX(2550), 170, 2550),
    quaternion: new THREE.Quaternion(),
    speed: 42,
  };

  bounds = { x: 0, z: 0, radius: 2700, ceiling: 1000 };

  build() {
    const { fbm, ridged } = createNoise(77);
    const rand = mulberry32(31);

    // ---------------- Terrain: mountains with a winding glacial valley ----------------
    const heightFn = (x, z) => {
      const r = ridged(x / 1400, z / 1400, 5);
      const mountains = r * r * 620 + fbm(x / 500, z / 500, 4) * 40;
      const d = Math.abs(x - valleyX(z)) + fbm(x / 300, z / 300, 3) * 80;
      const mask = smoothstep(140, 700, d);
      const floor = 40 + fbm(x / 400, z / 400, 3) * 12;
      let h = floor + Math.max(mountains, 0) * mask;
      // Lake basin: flatten to just below the ice
      const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
      h += (LAKE.level - 3 - h) * smoothstep(LAKE.r + 90, LAKE.r - 20, dl);
      return h;
    };

    const snow = new THREE.Color(0xe9eff8);
    const blueSnow = new THREE.Color(0xc4d4ea);
    const rock = new THREE.Color(0x3b404b);
    const colorFn = (h, slope, x, z, out) => {
      out.copy(blueSnow).lerp(snow, smoothstep(40, 300, h)); // shaded valley -> bright peaks
      out.lerp(rock, smoothstep(0.75, 1.25, slope)); // bare rock on cliffs
    };
    this.terrain = new Terrain({ size: 6400, segments: 320, heightFn, colorFn, roughness: 0.85, bumpScale: 0.8 });
    this.group.add(this.terrain.mesh);

    // ---------------- Frozen lake: glossy ice reflecting the moon ----------------
    const ice = new THREE.Mesh(
      new THREE.CircleGeometry(LAKE.r + 30, 64).rotateX(-Math.PI / 2),
      new THREE.MeshPhysicalMaterial({ color: 0x8fb2cc, roughness: 0.12, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.05 }),
    );
    ice.position.set(LAKE.x, LAKE.level, LAKE.z);
    ice.receiveShadow = true;
    this.group.add(ice);

    // ---------------- Snowy forest + rocks ----------------
    const pines = [];
    const rocks = [];
    const T = this.terrain;
    const want = CONFIG.quality === 'low' ? 2500 : 5500;
    for (let i = 0; i < want * 3 && pines.length < want; i++) {
      const x = (rand() - 0.5) * 5600, z = (rand() - 0.5) * 5600;
      const y = T.heightAt(x, z);
      if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 25) continue;
      const slope = (Math.abs(T.heightAt(x + 4, z) - y) + Math.abs(T.heightAt(x, z + 4) - y)) / 4;
      const forest = Math.sin(x / 190) * Math.cos(z / 230) + Math.sin((x - z) / 410);
      if (y < 260 && slope < 0.5 && forest > -0.3) pines.push({ x, y: y - 0.4, z, scale: 0.8 + rand() * 1.1 });
      else if (slope > 0.7 && rand() < 0.12) rocks.push({ x, y, z, scale: new THREE.Vector3(3 + rand() * 6, 2 + rand() * 4, 3 + rand() * 6) });
    }
    this.forest = createPines(pines, { snowy: true });
    this.group.add(this.forest, createRocks(rocks, 0x454a55));

    // ---------------- Cabin village on the lake shore ----------------
    this.buildVillage(rand);

    // ---------------- Sky: stars, aurora, falling snow ----------------
    this.stars = new Stars({ count: CONFIG.quality === 'low' ? 2500 : 5000 });
    this.group.add(this.stars.points);

    this.aurora = new Aurora();
    this.group.add(this.aurora.mesh);
    // Include the aurora in the environment-map capture, so the frozen lake
    // and the aircraft reflect it
    this.envExtras = [this.aurora.material];

    this.snow = new Snow({ count: CONFIG.quality === 'low' ? 2000 : 4500 });
    this.group.add(this.snow.points);

    // ---------------- Rings down the valley ----------------
    const pts = [];
    let i = 0;
    for (let z = 2150; z >= -2050; z -= 380, i++) {
      const x = valleyX(z) + Math.sin(i * 1.7) * 35;
      const nearLake = Math.abs(z - LAKE.z) < 200;
      const ground = Math.max(T.heightAt(x, z), LAKE.level);
      const y = ground + (nearLake ? 16 : 45 + Math.sin(i * 2.3) * 15);
      pts.push(new THREE.Vector3(x, y, z));
    }
    this.rings = new RingCourse(pts, { color: 0xffd86b, aheadColor: 0x6ff0ff });
    this.group.add(this.rings.group);
    this.placeSpawnBeforeFirstRing();

    // The "moment": skimming across the frozen lake under the strongest aurora
    const lakeRing = pts.findIndex((p) => Math.abs(p.z - LAKE.z) < 200);
    this.moments = {
      [lakeRing]: { title: 'Northern Lights', text: 'The sky comes alive above the frozen lake' },
    };
    this.momentRing = lakeRing;
  }

  buildVillage(rand) {
    const wood = new THREE.MeshStandardMaterial({ color: 0x5a3b28, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xe8eef6, roughness: 0.8 });
    const windowMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffb050, emissiveIntensity: 3 });
    const village = new THREE.Group();
    village.name = 'Village';

    // Cabins along the north-east shore of the lake
    for (let k = 0; k < 6; k++) {
      const a = -0.6 + k * 0.32;
      const x = LAKE.x + Math.cos(a) * (LAKE.r + 45 + rand() * 25);
      const z = LAKE.z + Math.sin(a) * (LAKE.r + 45 + rand() * 25);
      const y = this.terrain.heightAt(x, z);
      const cabin = new THREE.Group();
      const w = 7 + rand() * 3, d = 9 + rand() * 3, h = 4;
      const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wood);
      walls.position.y = h / 2;
      // Triangular-prism roof: a 3-sided cylinder laid along the cabin's length
      // (rotateX(-90°) puts one corner on top), then flattened by scaling Y
      const r = w * 0.62;
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d + 0.8, 3, 1).rotateX(-Math.PI / 2), roofMat);
      roof.scale.y = 0.55;
      roof.position.y = h + 0.275 * r;
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2), windowMat);
      win.position.set(0, h * 0.55, d / 2 + 0.02);
      const win2 = win.clone();
      win2.position.z = -d / 2 - 0.02;
      win2.rotation.y = Math.PI;
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.5, 0.9), new THREE.MeshStandardMaterial({ color: 0x55585e }));
      chimney.position.set(w * 0.25, h + 1.8, d * 0.2);
      cabin.add(walls, roof, win, win2, chimney);
      cabin.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
      cabin.position.set(x, y - 0.3, z);
      cabin.rotation.y = -a + Math.PI / 2 + (rand() - 0.5) * 0.4; // face the lake
      // Warm glow sprite in front of the window
      const glow = createGlowSprite(0xffa040, 9, 0.7);
      glow.position.set(0, h * 0.55, d / 2 + 1);
      cabin.add(glow);
      village.add(cabin);
    }
    // One real light source for the whole village (lights the snow around it)
    const a = -0.6 + 2.5 * 0.32;
    const lamp = new THREE.PointLight(0xffa860, 1500, 220, 2);
    lamp.position.set(LAKE.x + Math.cos(a) * (LAKE.r + 40), this.terrain.heightAt(LAKE.x + Math.cos(a) * (LAKE.r + 40), LAKE.z + Math.sin(a) * (LAKE.r + 40)) + 12, LAKE.z + Math.sin(a) * (LAKE.r + 40));
    village.add(lamp);
    this.group.add(village);
  }

  groundAt(x, z) {
    // The ice is solid too (you can't fly through the lake)
    const h = this.terrain.heightAt(x, z);
    return Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 30 ? Math.max(h, LAKE.level) : h;
  }

  update(dt, time, game) {
    const camera = game.camera;
    this.forest.update(camera);
    this.stars.update(dt, camera, game.renderer);
    this.snow.update(dt, camera, game.renderer);
    this.aurora.update(dt, camera);
    this.rings.update(dt);

    // Aurora light spills onto the snow: tint the sky-fill light green as it brightens
    const hemi = this.ctx.env.hemi;
    const k = Math.min(1, Math.max(0, (this.aurora.glow - 0.8) * 0.6));
    hemi.color.setHex(0x2a4a6a).lerp(_auroraGreen, k);
  }

  onRingPassed(i) {
    if (i === this.momentRing) this.aurora.triggerSurge();
  }
}

const _auroraGreen = new THREE.Color(0x2f8a68);
