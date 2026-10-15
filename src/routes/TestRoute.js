import * as THREE from 'three';
import { Route } from './Route.js';
import { Terrain } from '../world/Terrain.js';
import { createNoise } from '../utils/noise.js';
import { smoothstep, mulberry32 } from '../utils/math.js';
import { Clouds } from '../world/Clouds.js';
import { createPines, createRocks } from '../world/Props.js';
import { CONFIG } from '../config.js';

/**
 * FREE FLIGHT VALLEY (sandbox): a daytime alpine valley with forests and
 * clouds, no rings - just fly. (Originally the Milestone 1 test scene.)
 */
export class TestRoute extends Route {
  id = 'test';
  name = 'Free Flight Valley';
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

  build() {
    const { fbm, ridged } = createNoise(7);

    // Height = rolling hills + ridged mountains that are suppressed inside a
    // winding valley (so there is a clear corridor to fly along).
    const heightFn = (x, z) => {
      const hills = fbm(x / 1500, z / 1500, 5) * 90 + 30;
      const ridges = Math.pow(ridged(x / 1100, z / 1100, 4), 2) * 320;
      const valleyCentre = Math.sin(z / 600) * 220;
      const valleyMask = smoothstep(180, 750, Math.abs(x - valleyCentre));
      return hills + ridges * valleyMask;
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

    this.terrain = new Terrain({ size: 5200, segments: 320, heightFn, colorFn });
    this.group.add(this.terrain.mesh);

    // Forest: pines on gentle, low slopes (InstancedMesh = 1 draw call)
    const rand = mulberry32(5);
    const pines = [];
    const rocks = [];
    const T = this.terrain;
    const treeCount = CONFIG.quality === 'low' ? 2500 : 6000;
    for (let i = 0; i < treeCount * 3 && pines.length < treeCount; i++) {
      const x = (rand() - 0.5) * 4400, z = (rand() - 0.5) * 4400;
      const y = T.heightAt(x, z);
      const slope = (Math.abs(T.heightAt(x + 4, z) - y) + Math.abs(T.heightAt(x, z + 4) - y)) / 4;
      // Clumps: only plant where low-frequency noise says "forest"
      const forest = Math.sin(x / 210) * Math.cos(z / 170) + Math.sin((x + z) / 330);
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
  }

  groundAt(x, z) {
    return this.terrain.heightAt(x, z);
  }
}
