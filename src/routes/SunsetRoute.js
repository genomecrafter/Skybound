import * as THREE from 'three';
import { Route } from './Route.js';
import { Terrain } from '../world/Terrain.js';
import { Water } from '../world/Water.js';
import { Lighthouse } from '../world/Lighthouse.js';
import { Birds } from '../world/Birds.js';
import { RingCourse } from '../world/Rings.js';
import { createRocks, createPillars, createPalms } from '../world/Props.js';
import { createNoise } from '../utils/noise.js';
import { mulberry32, smoothstep } from '../utils/math.js';

/**
 * ROUTE 2 - SUNSET OCEAN SKIM
 * Fly low over animated Gerstner-wave water toward a setting sun, weaving
 * between sea stacks and past a lighthouse whose beam sweeps the sea.
 *
 * Lighting design:
 *  - Sun (DirectionalLight) very low ahead of the player (~4° elevation),
 *    warm orange: long shadows, rim-lit islands.
 *  - Hemisphere fill: peach sky / deep violet ground, low intensity so the
 *    sides facing away from the sun stay cool and moody.
 *  - Lighthouse SpotLight + PointLight; aircraft nav PointLights.
 */

// Hand-placed islands: centre, radius, peak height
const ISLANDS = [
  { x: 420, z: -350, r: 170, h: 30, lighthouse: true },
  { x: -460, z: 300, r: 220, h: 48 },
  { x: -360, z: -920, r: 160, h: 26 },
  { x: 520, z: 720, r: 150, h: 20 },
  { x: 950, z: -1150, r: 260, h: 62 },
  { x: -950, z: -320, r: 250, h: 70 },
  { x: -720, z: 1350, r: 180, h: 32 },
  { x: 260, z: -1750, r: 200, h: 40 },
];

// Sea stacks (rock pillars) to weave between: x, z, radius, height
const STACKS = [
  [-88, 745, 9, 46], [8, 770, 8, 38], [-55, 610, 7, 30], [70, 880, 10, 52],
  [-150, 900, 8, 34], [-230, 560, 9, 42], [-10, 330, 7, 26], [-120, 300, 8, 36],
  [120, -980, 9, 40], [-5, -1020, 8, 30], [310, 120, 10, 50], [-300, -1250, 9, 44],
];

// Ring course (flight order), heading roughly toward the sun (-Z)
const RING_POINTS = [
  [0, 42, 1400], [55, 30, 1060], [-40, 22, 760], [-165, 18, 450], [-60, 20, 160],
  [150, 28, -140], [210, 40, -470], [60, 22, -800], [-110, 16, -1110], [10, 26, -1450],
];

const SEA_LEVEL = 0;

export class SunsetRoute extends Route {
  id = 'sunset';
  name = 'Sunset Ocean Skim';
  subtitle = 'Skim the waves toward a setting sun';

  atmosphere = {
    sunDir: new THREE.Vector3(0.18, 0.07, -1),
    sky: {
      top: 0x26305e, horizon: 0xf2925a, bottom: 0x40304a,
      sunColor: 0xffb26a, sunSize: 0.045, sunGlow: 1.6, gradientExp: 0.45,
      // Long streaks of altostratus catching the last light
      // Long streaks of altostratus catching the last light, and a broken
      // lower deck of altocumulus (see sky.frag.glsl)
      clouds: {
        cover: 0.5, scale: 0.85, stretch: [0.7, 3.2], wind: [0.012, 0.0],
        lit: 0xffa070, litBoost: 1.5, shade: 0x5b4468, opacity: 0.9,
        low: { cover: 0.42, scale: 2.4, stretch: 1.6, opacity: 0.95 },
      },
    },
    sunLight: { color: 0xffa060, intensity: 2.4 },
    hemi: { sky: 0xffb48a, ground: 0x3a3050, intensity: 0.7 },
    fog: { color: 0xe8956a, near: 350, far: 2800 },
    exposure: 0.95,
    envIntensity: 0.75,
  };

  // Post-processing look: strong bloom on the sun glitter, warm lens flare
  post = { bloom: 0.5, flare: 0.8, flareColor: 0xffc080, saturation: 1.1, vignette: 0.4 };
  ambience = 'ocean'; // AudioEngine background sound
  humidity = 1; // sea air: vapour trails form easily

  spawn = {
    position: new THREE.Vector3(0, 55, 1800),
    quaternion: new THREE.Quaternion(),
    speed: 42,
  };

  bounds = { x: 0, z: -100, radius: 2100, ceiling: 600 };
  waterLevel = SEA_LEVEL;
  navLightStrength = 0.6;

  build() {
    const { fbm, ridged } = createNoise(42);
    const rand = mulberry32(99);

    // ---------------- Islands (one high-resolution terrain patch each) ----------------
    const sand = new THREE.Color(0xd9b98c);
    const grass = new THREE.Color(0x6b7f3a);
    const rock = new THREE.Color(0x7a5e52);
    const wet = new THREE.Color(0x4a3a36);
    const colorFn = (h, slope, x, z, out) => {
      out.copy(sand).lerp(grass, smoothstep(3, 9, h));
      out.lerp(rock, smoothstep(0.55, 0.95, slope));
      out.lerp(wet, 1 - smoothstep(-2, 1, h)); // dark wet rock at/below the waterline
    };

    this.islands = ISLANDS.map((isl, i) => {
      const heightFn = (x, z) => {
        const dx = (x - isl.x) / isl.r;
        const dz = (z - isl.z) / isl.r;
        // Warp the distance with noise so the coastline is irregular
        const d = Math.hypot(dx, dz) * (1 + 0.28 * fbm(x / 160 + i * 7, z / 160, 3));
        const mask = smoothstep(1.0, 0.45, d); // 1 in the middle, 0 at the coast
        const bumps = 0.65 + 0.55 * ridged(x / 140 + i * 3, z / 140, 4);
        return -14 + (isl.h * bumps + 14) * mask;
      };
      const terrain = new Terrain({
        size: isl.r * 2.6, segments: 110, cx: isl.x, cz: isl.z, heightFn, colorFn,
      });
      this.group.add(terrain.mesh);
      return { ...isl, terrain };
    });

    // ---------------- Water ----------------
    const a = this.atmosphere;
    this.water = new Water({
      level: SEA_LEVEL,
      sunDir: a.sunDir,
      colors: {
        deep: 0x1a2a48, shallow: 0x3b5a78,
        skyTop: 0x4a4a80, skyHorizon: a.sky.horizon, sun: 0xffb070, sss: 0x7a8048,
      },
    });
    this.group.add(this.water.mesh);

    // ---------------- Props: palms + shore rocks (InstancedMesh) ----------------
    const palms = [];
    const rocks = [];
    for (const isl of this.islands) {
      const tries = Math.round(isl.r * 0.9);
      for (let k = 0; k < tries; k++) {
        const ang = rand() * Math.PI * 2;
        const dist = Math.sqrt(rand()) * isl.r;
        const x = isl.x + Math.cos(ang) * dist;
        const z = isl.z + Math.sin(ang) * dist;
        const y = isl.terrain.heightAt(x, z);
        const slope = Math.abs(isl.terrain.heightAt(x + 3, z) - y) + Math.abs(isl.terrain.heightAt(x, z + 3) - y);
        if (y > 2.5 && y < isl.h * 0.8 && slope < 2.2 && rand() < 0.35) {
          if (isl.lighthouse && dist < 40) continue; // keep the lighthouse area clear
          palms.push({ x, y: y - 0.3, z, scale: 0.8 + rand() * 0.6 });
        } else if (y > -3 && y < 3 && rand() < 0.5) {
          rocks.push({ x, y, z, scale: new THREE.Vector3(2 + rand() * 4, 1.5 + rand() * 3, 2 + rand() * 4) });
        }
      }
    }
    this.group.add(createPalms(palms), createRocks(rocks));

    // ---------------- Sea stacks (also solid obstacles) ----------------
    const pillars = STACKS.map(([x, z, r, h]) => ({
      x, y: -12, z, scale: new THREE.Vector3(r, h + 12, r), rotY: rand() * 6,
    }));
    this.group.add(createPillars(pillars));
    this.obstacles = STACKS.map(([x, z, r, h]) => ({ x, z, r: r * 0.95, top: h }));

    // ---------------- Lighthouse on the lighthouse island's peak ----------------
    const li = this.islands.find((i) => i.lighthouse);
    const lx = li.x, lz = li.z;
    const base = li.terrain.heightAt(lx, lz);
    this.lighthouse = new Lighthouse({ position: new THREE.Vector3(lx, base - 0.5, lz) });
    this.group.add(this.lighthouse.group);
    this.obstacles.push({ x: lx, z: lz, r: 4, top: base + 32 });

    // ---------------- Seabirds ----------------
    this.flocks = [
      new Birds({ count: 12, center: new THREE.Vector3(lx, base, lz), radius: [45, 110], height: [20, 50], seed: 3 }),
      new Birds({ count: 8, center: new THREE.Vector3(-40, 0, 700), radius: [60, 140], height: [25, 55], seed: 8 }),
      new Birds({ count: 8, center: new THREE.Vector3(-100, 0, -1150), radius: [50, 120], height: [18, 40], seed: 15 }),
    ];
    for (const f of this.flocks) this.group.add(f.group);

    // ---------------- Clouds ----------------
    // At sunset the sky is dominated by layered clouds lit from below by the
    // low sun; they are drawn by the sky dome shader (atmosphere.sky.clouds)
    // and reflected by the ocean, instead of billboard cumulus.


    // ---------------- Rings ----------------
    this.rings = new RingCourse(RING_POINTS.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
    this.group.add(this.rings.group);
    this.placeSpawnBeforeFirstRing();

    // The route's "moment": triggered when passing this ring
    this.moments = {
      6: { title: 'Golden Hour', text: 'Drop low and race your shadow across the waves' },
    };
  }

  groundAt(x, z) {
    // Highest island surface under (x, z); the seabed elsewhere
    let h = -30;
    for (const isl of this.islands) {
      const dx = x - isl.x, dz = z - isl.z;
      if (dx * dx + dz * dz < isl.r * isl.r * 1.7) h = Math.max(h, isl.terrain.heightAt(x, z));
    }
    return h;
  }

  update(dt, time, game) {
    this.water.update(dt, game.camera, game.env);
    this.lighthouse.update(dt, time);
    for (const f of this.flocks) f.update(dt);
    this.rings.update(dt);
  }
}
