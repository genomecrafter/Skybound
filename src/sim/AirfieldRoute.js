import * as THREE from 'three';
import { Route } from '../routes/Route.js';
import { Terrain } from '../world/Terrain.js';
import { createNoise } from '../utils/noise.js';
import { smoothstep, mulberry32 } from '../utils/math.js';
import { Clouds } from '../world/Clouds.js';
import { Runway } from '../world/Runway.js';
import { createPines, createRocks } from '../world/Props.js';
import { CONFIG } from '../config.js';

/**
 * VALLEY AIRFIELD (flight simulator only): a variant of the Free Flight
 * Valley whose south end opens into a wide grassy BASIN with a small
 * airfield (runway 35 / 17) and a clear approach corridor. It is the home
 * airport of the flight simulator: the mountains are pushed back far enough
 * to fly a full traffic circuit. The scenic Free Flight Valley
 * (routes/TestRoute.js) is left unchanged.
 */

// Airfield: runway centre, landing direction (heading 346°, "runway 35") and size
const AF = { x: 120, z: 420, heading: 346, length: 1000, width: 30 };
AF.dir = new THREE.Vector3(Math.sin((AF.heading * Math.PI) / 180), 0, -Math.cos((AF.heading * Math.PI) / 180));
const BASIN = { x: 40, z: 600, r: 1650 }; // flat basin around the airfield
export class AirfieldRoute extends Route {
  id = 'airfield';
  name = 'Valley Airfield';
  subtitle = 'A sunny alpine valley to explore at your own pace';

  atmosphere = {
    sunDir: new THREE.Vector3(0.45, 0.55, -0.35),
    sky: { top: 0x2f6fc0, horizon: 0xc4dcf0, bottom: 0x7d8a8f, sunColor: 0xfff1d6, sunSize: 0.025, sunGlow: 0.9,
      clouds: { cover: 0.32, scale: 1.1, stretch: [1, 1.6], lit: 0xffffff, litBoost: 1.1, shade: 0xb4c2d4, opacity: 0.8 } },
    sunLight: { color: 0xfff3e0, intensity: 2.6 },
    hemi: { sky: 0xbfd8f2, ground: 0x4f5a3a, intensity: 0.7 },
    fog: { color: 0xc4dcf0, near: 500, far: 3200 },
    exposure: 1.0,
    envIntensity: 0.8,
  };

  post = { bloom: 0.35, flare: 0.8, flareColor: 0xfff0d0 };
  humidity = 0.6;

  spawn = {
    position: new THREE.Vector3(0, 180, 1300),
    quaternion: new THREE.Quaternion(), // identity = facing -Z
    speed: 42,
  };

  bounds = { x: 0, z: 0, radius: 2000, ceiling: 900 };
  simBounds = { x: 0, z: 800, radius: 2900, ceiling: 3000 };

  build() {
    const { fbm, ridged } = createNoise(7);

    // Runway coordinates of a point: along the centre-line from the
    // threshold (+ toward the far end) and across it
    const side = new THREE.Vector3(-AF.dir.z, 0, AF.dir.x);
    const thrX = AF.x - AF.dir.x * (AF.length / 2), thrZ = AF.z - AF.dir.z * (AF.length / 2);
    const rwyLocal = (x, z) => ({
      along: (x - thrX) * AF.dir.x + (z - thrZ) * AF.dir.z,
      across: (x - AF.x) * side.x + (z - AF.z) * side.z,
    });
    const basinFloor = (x, z) => 36 + fbm(x / 700, z / 700, 3) * 9;
    const rwyY = basinFloor(AF.x, AF.z) + 0.3;

    // Height = rolling hills + ridged mountains that are suppressed inside a
    // winding valley (so there is a clear corridor to fly along) and inside
    // the airfield basin, which is flattened toward a gentle grassy floor.
    const heightFn = (x, z) => {
      const hills = fbm(x / 1500, z / 1500, 5) * 90 + 30;
      const ridges = Math.pow(ridged(x / 1100, z / 1100, 4), 2) * 320;
      const valleyCentre = Math.sin(z / 600) * 220;
      const valleyMask = smoothstep(180, 750, Math.abs(x - valleyCentre));
      const basin = smoothstep(BASIN.r, BASIN.r - 750, Math.hypot(x - BASIN.x, z - BASIN.z));
      // Approach / departure corridor: no mountains along the extended centre-line
      const { along, across } = rwyLocal(x, z);
      const corridor = smoothstep(650, 300, Math.abs(across)) * smoothstep(-4600, -3800, along) * smoothstep(AF.length + 3200, AF.length + 2400, along);
      const open = Math.max(basin, corridor);
      let h = hills + ridges * valleyMask * (1 - open);
      h += (basinFloor(x, z) + Math.max(0, -along - 1500) * 0.03 - h) * open * 0.92;
      // Flatten a pad around the runway to exactly its height
      const pad = smoothstep(130, 60, Math.abs(across)) * smoothstep(-400, -200, along) * smoothstep(AF.length + 400, AF.length + 200, along);
      return h + (rwyY - 0.2 - h) * pad;
    };

    const grass = new THREE.Color(0x5d8a3c);
    const dry = new THREE.Color(0x8a8a4a);
    const rock = new THREE.Color(0x77706a);
    const snow = new THREE.Color(0xf4f6fa);
    const colorFn = (h, slope, x, z, out) => {
      out.copy(grass).lerp(dry, smoothstep(40, 140, h));
      out.lerp(rock, smoothstep(0.45, 0.8, slope));
      out.lerp(snow, smoothstep(230, 280, h) * (1 - smoothstep(0.9, 1.3, slope)));
    };

    // Extends further south than the arcade area: room for long final approaches to the airfield
    this.terrain = new Terrain({ size: 6400, segments: 400, cz: 800, heightFn, colorFn });
    this.group.add(this.terrain.mesh);

    // ---------------- Airfield ----------------
    this.runwayObj = new Runway({
      center: new THREE.Vector3(AF.x, rwyY, AF.z),
      dir: AF.dir,
      length: AF.length,
      width: AF.width,
      numbers: ['35', '17'],
    });
    this.runway = this.runwayObj.data;
    this.group.add(this.runwayObj.group);
    this.obstacles = [...this.runwayObj.obstacles];
    // Keep trees out of the runway area and the approach / departure paths
    const clearOfAirfield = (x, z) => {
      const { along, across } = rwyLocal(x, z);
      const inLine = along > -1300 && along < AF.length + 1300;
      return !(inLine && Math.abs(across) < (along > -200 && along < AF.length + 200 ? 150 : 90));
    };

    // Forest: pines on gentle, low slopes (InstancedMesh = 1 draw call)
    const rand = mulberry32(5);
    const pines = [];
    const rocks = [];
    const T = this.terrain;
    const treeCount = CONFIG.quality === 'low' ? 3200 : 7600;
    for (let i = 0; i < treeCount * 3 && pines.length < treeCount; i++) {
      const x = (rand() - 0.5) * 4400, z = -2200 + rand() * 6000; // includes the airfield's southern approach
      const y = T.heightAt(x, z);
      const slope = (Math.abs(T.heightAt(x + 4, z) - y) + Math.abs(T.heightAt(x, z + 4) - y)) / 4;
      // Clumps: only plant where low-frequency noise says "forest"
      const forest = Math.sin(x / 210) * Math.cos(z / 170) + Math.sin((x + z) / 330);
      if (!clearOfAirfield(x, z)) continue;
      if (y < 170 && slope < 0.45 && forest > -0.2) pines.push({ x, y: y - 0.3, z, scale: 0.9 + rand() * 1.0 });
      else if (slope > 0.6 && rand() < 0.15) rocks.push({ x, y, z, scale: new THREE.Vector3(3 + rand() * 6, 2 + rand() * 4, 3 + rand() * 6) });
    }
    this.forest = createPines(pines);
    this.group.add(this.forest, createRocks(rocks, 0x77706a));

    this.clouds = new Clouds({
      count: CONFIG.quality === 'low' ? 18 : 40,
      area: { x: 0, z: 0, radius: 2800 },
      altitude: [380, 620],
      size: [70, 160],
      sunDir: this.atmosphere.sunDir,
      litColor: 0xfffbf2,
      shadowColor: 0x8796ab,
      skyColor: 0xd6e2f2,
      seed: 9,
    });
    this.group.add(this.clouds.mesh);
  }

  update(dt, time, game) {
    this.forest.update(game.camera);
    this.clouds.update(dt, game.camera);
    this.runwayObj.update(dt, game.flight.position);
  }

  groundAt(x, z) {
    return this.terrain.heightAt(x, z);
  }
}
