import * as THREE from 'three';
import { Route } from './Route.js';
import { Terrain } from '../world/Terrain.js';
import { Runway } from '../world/Runway.js';
import { Birds } from '../world/Birds.js';
import { Clouds } from '../world/Clouds.js';
import { RingCourse } from '../world/Rings.js';
import { createRocks, createCacti, createShrubs } from '../world/Props.js';
import { createNoise } from '../utils/noise.js';
import { mulberry32, smoothstep, lerp } from '../utils/math.js';
import { CONFIG } from '../config.js';

/**
 * ROUTE 3 - CANYON LANDING
 * Dive off a desert plateau into a winding red-rock canyon, thread its
 * narrows, then exit onto the desert floor and LAND on the airstrip.
 *
 * Terrain: the canyon is carved by distance to a winding centre-line. The
 * walls are TERRACED (quantised height with soft risers), which produces the
 * layered benches and cliffs of real sandstone canyons; the rock colour also
 * varies in horizontal bands (sedimentary strata).
 *
 * Lighting design (harsh midday):
 *  - High, bright, slightly warm sun: short hard shadows, strong contrast.
 *  - Hemisphere light: blue sky above, RED-ORANGE ground colour = light
 *    bouncing off the red rock onto the aircraft's underside.
 *  - Runway PointLights, edge-light bulbs, PAPI and approach strobes.
 */

const EXIT_Z = -1000; // canyon mouth
const RWY = { length: 1000, width: 30, y: 14 };
const pathX = (z) => Math.sin(z / 520) * 260 + Math.sin(z / 190 + 1) * 60;
const RX = Math.round(pathX(EXIT_Z)); // runway centre-line x = canyon exit
// Canyon centre-line, straightened over the last 900 m so the final approach is lined up
const canyonX = (z) => lerp(RX, pathX(z), smoothstep(EXIT_Z, EXIT_Z + 900, z));
const THRESHOLD_Z = -1500; // approach end of the runway (landing toward -Z)
RWY.cz = THRESHOLD_Z - RWY.length / 2;

/** Quantise height into benches 26 m tall with steep soft risers (strata terraces). */
function terrace(h, step = 26) {
  const k = h / step;
  const f = Math.floor(k);
  return (f + smoothstep(0.6, 1.0, k - f)) * step;
}

export class CanyonRoute extends Route {
  id = 'canyon';
  name = 'Canyon Landing';
  subtitle = 'Thread the canyon, then land on the desert airstrip';

  atmosphere = {
    sunDir: new THREE.Vector3(0.35, 0.85, 0.2), // high midday sun, slightly behind-right
    sky: {
      top: 0x2a68c8, horizon: 0xd8c6a6, bottom: 0x9a7a5a,
      sunColor: 0xfff4e0, sunSize: 0.022, sunGlow: 0.7, gradientExp: 0.55,
      clouds: { cover: 0.25, scale: 0.8, stretch: [1, 2.5], lit: 0xfff8ee, litBoost: 1.1, shade: 0xc4c8d0, opacity: 0.75 },
    },
    sunLight: { color: 0xfff1dc, intensity: 2.7 },
    hemi: { sky: 0xbfd6f0, ground: 0x9a4a2a, intensity: 0.6 },
    fog: { color: 0xd8c6a6, near: 700, far: 4200 },
    exposure: 0.95,
    envIntensity: 0.7,
  };

  post = { bloom: 0.35, bloomThreshold: 1.4, flare: 0.6, flareColor: 0xfff0d8, saturation: 1.12, vignette: 0.35 };
  ambience = 'desert'; // AudioEngine background sound
  humidity = 0.3; // dry desert air: few vapour trails

  spawn = {
    position: new THREE.Vector3(canyonX(2950), 330, 2950),
    quaternion: new THREE.Quaternion(),
    speed: 44,
  };

  bounds = { x: RX * 0.5, z: -250, radius: 3300, ceiling: 900 };

  build() {
    const { fbm } = createNoise(123);
    const rand = mulberry32(55);

    // ---------------- Runway (built first: the terrain is flattened under it) ----------------
    this.runwayObj = new Runway({
      center: new THREE.Vector3(RX, RWY.y, RWY.cz),
      dir: new THREE.Vector3(0, 0, -1),
      length: RWY.length,
      width: RWY.width,
    });
    this.runway = this.runwayObj.data; // used by the LandingController
    this.group.add(this.runwayObj.group);

    // ---------------- Terrain ----------------
    const heightFn = (x, z) => {
      const plateau = 240 + fbm(x / 900, z / 900, 4) * 35;
      const xc = canyonX(z);
      const d = Math.abs(x - xc) + fbm(x / 180, z / 180, 3) * 22;
      // The canyon mouth widens as it opens onto the plain
      const widen = smoothstep(EXIT_Z + 600, EXIT_Z - 200, z) * 260;
      const wall = smoothstep(65 + widen, 210 + widen * 1.5, d);
      const floor = 22 + fbm(x / 350, z / 350, 3) * 4;
      let h = floor + terrace(wall * (plateau - floor));

      // Desert plain beyond the canyon, with a few distant mesas
      const plainMask = smoothstep(EXIT_Z + 100, EXIT_Z - 500, z);
      if (plainMask > 0) {
        let plain = RWY.y - 2 + fbm(x / 600, z / 600, 3) * 6;
        const mesa = smoothstep(0.22, 0.3, fbm(x / 520 + 40, z / 520 - 20, 3)) * smoothstep(380, 700, Math.abs(x - RX));
        plain += terrace(mesa * 160, 22);
        h = lerp(h, plain, plainMask);
      }

      // Flatten a pad around the runway to exactly its height
      const across = Math.abs(x - RX);
      const along = THRESHOLD_Z - z; // 0 at threshold, + toward the far end
      const pad = smoothstep(130, 60, across) * smoothstep(-450, -250, along) * smoothstep(RWY.length + 250, RWY.length + 80, along);
      return lerp(h, RWY.y - 0.2, pad);
    };

    // Sandstone strata: colour bands by height, wobbled by noise
    const bands = [0xb5532e, 0xc9774a, 0x8f3f24, 0xd9a066, 0xa8492a].map((c) => new THREE.Color(c));
    const sand = new THREE.Color(0xd8b07a);
    const scrub = new THREE.Color(0xa89464);
    const tmp = new THREE.Color();
    const colorFn = (h, slope, x, z, out) => {
      const b = (h + fbm(x / 200, z / 200, 2) * 8) / 13;
      const i = ((Math.floor(b) % bands.length) + bands.length) % bands.length;
      out.copy(bands[i]).lerp(bands[(i + 1) % bands.length], b - Math.floor(b));
      // Flat ground: sand on the floor/plain, sparse scrub on plateau tops
      const flat = 1 - smoothstep(0.25, 0.6, slope);
      tmp.copy(h < 60 ? sand : scrub);
      out.lerp(tmp, flat * 0.85);
    };
    this.terrain = new Terrain({
      size: 6800, segments: CONFIG.quality === 'low' ? 340 : 430, cz: -250, cx: RX * 0.5,
      heightFn, colorFn, roughness: 0.95, bumpScale: 1.6,
    });
    this.group.add(this.terrain.mesh);

    // ---------------- Props ----------------
    const T = this.terrain;
    const rocks = [], cacti = [], shrubs = [];
    for (let i = 0; i < 16000; i++) {
      const x = RX * 0.5 + (rand() - 0.5) * 6000, z = -200 + (rand() - 0.5) * 6000;
      if (Math.abs(x - RX) < 90 && z < THRESHOLD_Z + 450 && z > THRESHOLD_Z - RWY.length - 300) continue; // keep runway clear
      const y = T.heightAt(x, z);
      const slope = (Math.abs(T.heightAt(x + 4, z) - y) + Math.abs(T.heightAt(x, z + 4) - y)) / 4;
      const r = rand();
      if (slope > 0.5 && r < 0.05) rocks.push({ x, y: y - 1, z, scale: new THREE.Vector3(3 + rand() * 7, 2 + rand() * 5, 3 + rand() * 7) });
      else if (slope < 0.2 && r < 0.06) cacti.push({ x, y: y - 0.3, z, scale: 0.7 + rand() * 0.6 });
      else if (slope < 0.35 && r < 0.3) shrubs.push({ x, y: y - 0.2, z, scale: 0.8 + rand() * 1.6 });
    }
    // Boulders scattered on the canyon floor
    for (let z = 2600; z > EXIT_Z; z -= 25) {
      if (rand() < 0.5) continue;
      const x = canyonX(z) + (rand() - 0.5) * 110;
      rocks.push({ x, y: T.heightAt(x, z) - 0.5, z, scale: new THREE.Vector3(2 + rand() * 4, 1.5 + rand() * 3, 2 + rand() * 4) });
    }
    this.cacti = createCacti(cacti);
    this.group.add(createRocks(rocks, 0x9a5a3a), this.cacti, createShrubs(shrubs));

    // ---------------- Hawks circling over the canyon ----------------
    this.flocks = [
      new Birds({ count: 5, center: new THREE.Vector3(canyonX(1200), 150, 1200), radius: [60, 140], height: [20, 70], color: 0x5a4030, wingColor: 0x4a3426, scale: 2.2, seed: 2 }),
      new Birds({ count: 4, center: new THREE.Vector3(canyonX(-200), 140, -200), radius: [50, 120], height: [10, 60], color: 0x5a4030, wingColor: 0x4a3426, scale: 2.2, seed: 6 }),
    ];
    for (const f of this.flocks) this.group.add(f.group);

    // ---------------- A few high fair-weather clouds ----------------
    this.clouds = new Clouds({
      count: CONFIG.quality === 'low' ? 10 : 22,
      area: { x: RX, z: 0, radius: 3200 },
      altitude: [850, 1100],
      size: [80, 170],
      sunDir: this.atmosphere.sunDir,
      litColor: 0xfffaf0,
      shadowColor: 0x9aa4b6,
      skyColor: 0xdde6f2,
      seed: 12,
    });
    this.group.add(this.clouds.mesh);

    // ---------------- Rings: down into the canyon, then the approach gate ----------------
    const pts = [];
    let i = 0;
    for (let z = 2550; z >= EXIT_Z + 150; z -= 330, i++) {
      const x = canyonX(z) + Math.sin(i * 1.9) * 15;
      const floor = T.heightAt(x, z);
      const y = i === 0 ? 205 : i === 1 ? 120 : floor + 32 + Math.sin(i * 2.1) * 10;
      pts.push(new THREE.Vector3(x, y, z));
    }
    // Approach gate on the 3° glide slope, 450 m before the aiming point
    const aimZ = THRESHOLD_Z - 300;
    const gateZ = THRESHOLD_Z + 150;
    pts.push(new THREE.Vector3(RX, RWY.y + 1.7 + Math.tan((3 * Math.PI) / 180) * (gateZ - aimZ), gateZ));
    this.rings = new RingCourse(pts, { color: 0xffc34d, aheadColor: 0x5fd8ff, fadeFar: 3200 });
    this.group.add(this.rings.group);
    this.placeSpawnBeforeFirstRing();

    this.obstacles = [...this.runwayObj.obstacles];

    const narrows = Math.min(4, pts.length - 2);
    this.moments = {
      [narrows]: { title: 'The Narrows', text: 'Thread the needle between the canyon walls' },
      [pts.length - 2]: { title: 'Runway in Sight', text: 'Gear down (G), throttle back, follow the PAPI lights' },
    };
  }

  groundAt(x, z) {
    return this.terrain.heightAt(x, z);
  }

  update(dt, time, game) {
    this.cacti.update(game.camera);
    for (const f of this.flocks) f.update(dt);
    this.clouds.update(dt, game.camera);
    this.rings.update(dt);
    this.runwayObj.update(dt, game.flight.position);
  }
}
