import * as THREE from 'three';
import { createGlowSprite } from './Glow.js';

/**
 * Airstrip with markings and a full lighting system.
 *
 * Everything is built in the runway's LOCAL frame (runway along -Z, from the
 * approach threshold at z = +L/2 to the far end at z = -L/2) inside one Group;
 * the Group is then rotated/translated into the world. This is hierarchical
 * modelling again: move the group and every light, sign and building follows.
 *
 * LIGHTS
 *  - Edge lights: an InstancedMesh of bulbs with per-instance colours
 *    (white edges, green threshold, red runway end). Colours > 1.0 are HDR,
 *    so the bloom pass makes them glow.
 *  - 4 PointLights that actually light the runway surface near the threshold.
 *  - Approach "rabbit": strobes on poles before the threshold flash in
 *    sequence toward the runway (animated).
 *  - PAPI (Precision Approach Path Indicator): 4 lights beside the touchdown
 *    point. Each shows WHITE if the aircraft is above its angle, RED if below
 *    (thresholds 2.5°, 2.83°, 3.17°, 3.5°). On the ideal 3° slope you see
 *    2 white + 2 red. Updated every frame from the aircraft's position.
 */

/** Runway surface texture: asphalt + painted markings, drawn on a canvas. */
function makeRunwayTexture(length, width, numbers) {
  const W = 256, H = 2048;
  const pxW = W / width; // pixels per metre across
  const pxL = H / length; // pixels per metre along
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  // Asphalt with grain
  g.fillStyle = '#3a3b3e';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) {
    const v = 40 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v},${v + 3},0.5)`;
    g.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
  }
  // Canvas y = 0 is the FAR end (top of texture), y = H the approach end.
  const yFromThreshold = (m) => H - m * pxL;

  // Tyre skid marks in the touchdown zone
  for (let i = 0; i < 40; i++) {
    const m = 220 + Math.random() * 260;
    g.fillStyle = 'rgba(15,15,15,0.35)';
    for (const side of [-1, 1]) g.fillRect(W / 2 + side * 3.2 * pxW - 3, yFromThreshold(m), 6, -(10 + Math.random() * 25) * pxL);
  }
  g.fillStyle = '#f2f2f2';
  // Edge lines
  g.fillRect(2, 0, 0.9 * pxW, H);
  g.fillRect(W - 2 - 0.9 * pxW, 0, 0.9 * pxW, H);
  // Centre-line dashes: 30 m paint, 20 m gap
  for (let m = 60; m < length - 60; m += 50) g.fillRect(W / 2 - 0.45 * pxW, yFromThreshold(m + 30), 0.9 * pxW, 30 * pxL);
  // Threshold "piano keys" at both ends
  const keys = (atStart) => {
    for (let k = 0; k < 8; k++) {
      const x = (k < 4 ? 2.5 + k * 3 : width - 2.5 - (7 - k) * 3 - 1.8) * pxW;
      const y = atStart ? yFromThreshold(32) : 2 * pxL;
      g.fillRect(x, y, 1.8 * pxW, 30 * pxL);
    }
  };
  keys(true);
  keys(false);
  // Aiming-point blocks (300 m) and touchdown-zone bars (150 m, 450 m)
  for (const side of [-1, 1]) {
    g.fillRect(W / 2 + side * 5 * pxW - (side < 0 ? 4 * pxW : 0), yFromThreshold(345), 4 * pxW, 45 * pxL);
    for (const m of [150, 450]) g.fillRect(W / 2 + side * 6 * pxW - (side < 0 ? 3 * pxW : 0), yFromThreshold(m + 22), 3 * pxW, 22 * pxL);
  }
  // Runway numbers, readable from each approach direction
  g.font = `bold ${Math.round(22 * pxL)}px Arial`;
  g.textAlign = 'center';
  g.save();
  g.translate(W / 2, yFromThreshold(45));
  g.scale(pxW / pxL / 2.2, 1); // letters are stretched along the runway (as painted)
  g.fillText(numbers[0], 0, 0);
  g.restore();
  g.save();
  g.translate(W / 2, 45 * pxL);
  g.rotate(Math.PI);
  g.scale(pxW / pxL / 2.2, 1);
  g.fillText(numbers[1], 0, 0);
  g.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeWindsockTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  for (let i = 0; i < 5; i++) {
    g.fillStyle = i % 2 ? '#f4f4f4' : '#ff6a1a';
    g.fillRect(0, (i * 128) / 5, 64, 128 / 5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Runway {
  /**
   * @param {object} o
   * @param {THREE.Vector3} o.center   centre of the runway (y = surface height)
   * @param {THREE.Vector3} o.dir      landing direction (unit, horizontal)
   * @param {number} o.length
   * @param {number} o.width
   */
  constructor({ center, dir, length = 1000, width = 30, numbers = ['36', '18'] }) {
    this.data = { center: center.clone(), dir: dir.clone().normalize(), length, width, numbers };
    this.wind = null; // { dir: Vector3 (world, downwind), speed m/s }, set by the simulator
    const L = length, Wd = width;

    this.group = new THREE.Group();
    this.group.name = 'Runway';
    this.group.position.copy(center);
    // Local -Z must point along `dir`: rotation.y = atan2(-dir.x, -dir.z)
    this.group.rotation.y = Math.atan2(-dir.x, -dir.z);

    // ---- Surface ----
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(Wd, L).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        map: makeRunwayTexture(L, Wd, numbers),
        roughness: 0.9,
        polygonOffset: true, // draw on top of the flattened terrain without z-fighting
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    surface.position.y = 0.05;
    surface.receiveShadow = true;
    this.group.add(surface);

    // ---- Edge, threshold and end lights (one InstancedMesh) ----
    const spots = [];
    for (let z = -L / 2; z <= L / 2; z += 60) for (const s of [-1, 1]) spots.push([s * (Wd / 2 + 1.5), z, 'edge']);
    for (let k = 0; k < 8; k++) {
      const x = -Wd / 2 + 2 + (k * (Wd - 4)) / 7;
      spots.push([x, L / 2 + 1.5, 'green']);
      spots.push([x, -L / 2 - 1.5, 'red']);
    }
    const bulbGeo = new THREE.SphereGeometry(0.28, 10, 8);
    const bulbs = new THREE.InstancedMesh(bulbGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), spots.length);
    const postGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.6, 6).translate(0, 0.3, 0);
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: 0xd8c040 }), spots.length);
    const m = new THREE.Matrix4();
    const colors = { edge: new THREE.Color(4, 3.6, 2.6), green: new THREE.Color(0.3, 4, 0.6), red: new THREE.Color(4, 0.3, 0.2) };
    spots.forEach(([x, z, kind], i) => {
      bulbs.setMatrixAt(i, m.makeTranslation(x, 0.75, z));
      bulbs.setColorAt(i, colors[kind]);
      posts.setMatrixAt(i, m.makeTranslation(x, 0, z));
    });
    this.group.add(bulbs, posts);

    // ---- Real point lights near the threshold (light the surface) ----
    for (const [x, z] of [[-Wd / 2, L / 2 - 20], [Wd / 2, L / 2 - 20], [-Wd / 2, L / 2 - 200], [Wd / 2, L / 2 - 200]]) {
      const pl = new THREE.PointLight(0xffe2b0, 60, 40, 2);
      pl.position.set(x, 2, z);
      this.group.add(pl);
    }

    // ---- Approach "rabbit" strobes on poles before the threshold ----
    this.rabbit = [];
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x777777 });
    for (let k = 0; k < 10; k++) {
      const z = L / 2 + 40 + k * 30;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 3, 6).translate(0, 1.5, 0), poleMat);
      pole.position.set(0, -0.5, z);
      const mat = new THREE.MeshBasicMaterial({ color: 0x333333 });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), mat);
      lamp.position.set(0, 2.7, z);
      this.group.add(pole, lamp);
      this.rabbit.push(mat);
    }

    // ---- PAPI: 4 units on the left of the runway at the aiming point (300 m) ----
    this.papi = [];
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
    const papiZ = L / 2 - 300;
    for (let k = 0; k < 4; k++) {
      const x = -Wd / 2 - 12 - k * 9;
      const housing = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1, 1), housingMat);
      housing.position.set(x, 0.5, papiZ);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.35, 16), mat);
      lens.position.set(x, 0.55, papiZ + 0.51);
      const glow = createGlowSprite(0xffffff, 4, 0.6);
      glow.position.set(x, 0.6, papiZ + 0.9);
      this.group.add(housing, lens, glow);
      // Innermost unit has the highest angle
      this.papi.push({ mat, glow, angle: 3.5 - k * 0.33, local: new THREE.Vector3(x, 0.55, papiZ) });
    }
    this.papiWorld = this.papi.map(() => new THREE.Vector3());

    // ---- Windsock ----
    const sockGroup = new THREE.Group();
    sockGroup.position.set(Wd / 2 + 25, 0, L / 2 - 120);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 8).translate(0, 3, 0), poleMat);
    this.sock = new THREE.Group(); // pivot at the top of the pole
    this.sock.position.y = 5.8;
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.55, 3.2, 14, 1, true).rotateZ(-Math.PI / 2).translate(1.6, 0, 0), // wide mouth at the pole
      new THREE.MeshStandardMaterial({ map: makeWindsockTexture(), side: THREE.DoubleSide }),
    );
    this.sock.add(cone);
    sockGroup.add(pole, this.sock);
    this.group.add(sockGroup);

    // ---- Hangar (half cylinder) + small control tower ----
    const metal = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.5, metalness: 0.6 });
    const hangar = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 30, 24, 1, false, -Math.PI / 2, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2), metal);
    hangar.position.set(-Wd / 2 - 70, 0, -L / 2 + 380);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(18, 9), new THREE.MeshStandardMaterial({ color: 0x2b2f36 }));
    door.position.set(-Wd / 2 - 70 + 15.05, 4.5, -L / 2 + 380);
    door.rotation.y = Math.PI / 2;
    const towerBase = new THREE.Mesh(new THREE.BoxGeometry(5, 14, 5), new THREE.MeshStandardMaterial({ color: 0xe6dccb }));
    towerBase.position.set(-Wd / 2 - 70, 7, -L / 2 + 330);
    const cab = new THREE.Mesh(
      new THREE.CylinderGeometry(4.2, 3.6, 3.5, 8),
      new THREE.MeshPhysicalMaterial({ color: 0x2d4a5e, roughness: 0.08, metalness: 0.2 }),
    );
    cab.position.set(-Wd / 2 - 70, 15.7, -L / 2 + 330);
    const cabRoof = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.6, 0.6, 8), metal);
    cabRoof.position.set(-Wd / 2 - 70, 17.8, -L / 2 + 330);
    this.group.add(hangar, door, towerBase, cab, cabRoof);
    for (const o of [hangar, towerBase, cab, cabRoof, pole]) o.castShadow = o.receiveShadow = true;

    // Solid obstacles in WORLD space (for collision): hangar and tower
    this.group.updateMatrixWorld(true);
    const toWorld = (x, z) => new THREE.Vector3(x, 0, z).applyMatrix4(this.group.matrixWorld);
    const h = toWorld(-Wd / 2 - 70, -L / 2 + 380);
    const t = toWorld(-Wd / 2 - 70, -L / 2 + 330);
    this.obstacles = [
      { x: h.x, z: h.z, r: 16, top: center.y + 12 },
      { x: t.x, z: t.z, r: 4.5, top: center.y + 18 },
    ];
    this.papi.forEach((p, i) => this.papiWorld[i].copy(p.local).applyMatrix4(this.group.matrixWorld));
    this.time = 0;
  }

  update(dt, planePos) {
    this.time += dt;
    const t = this.time;

    // Rabbit: one flash runs from the outermost pole to the threshold twice a second
    const active = 9 - (Math.floor(t * 20) % 10);
    this.rabbit.forEach((mat, k) => mat.color.setScalar(k === active ? 6 : 0.15));

    // PAPI: white above the unit's angle, red below
    this.papi.forEach((p, i) => {
      const w = this.papiWorld[i];
      const angle = (Math.atan2(planePos.y - w.y, Math.hypot(planePos.x - w.x, planePos.z - w.z)) * 180) / Math.PI;
      const white = angle > p.angle;
      p.mat.color.setRGB(white ? 5 : 5, white ? 5 : 0.25, white ? 5 : 0.2);
      p.glow.material.color.set(white ? 0xffffff : 0xff3020);
    });

    // Windsock: points downwind, swinging and drooping with gusts
    const gust = 0.5 + 0.5 * Math.sin(t * 0.7) * Math.sin(t * 1.9);
    if (this.wind) {
      // Real wind (simulator): turn the downwind vector into the runway's
      // local frame; the sock is fully extended at 15 knots (7.7 m/s)
      const ry = this.group.rotation.y;
      const lx = this.wind.dir.x * Math.cos(ry) - this.wind.dir.z * Math.sin(ry);
      const lz = this.wind.dir.x * Math.sin(ry) + this.wind.dir.z * Math.cos(ry);
      const strength = Math.min(this.wind.speed / 7.7, 1);
      this.sock.rotation.y = Math.atan2(-lz, lx) + Math.sin(t * 0.9) * 0.12 * strength;
      this.sock.rotation.z = -1.35 * (1 - strength) - 0.05 + gust * 0.15 * strength;
    } else {
      this.sock.rotation.y = 0.6 + Math.sin(t * 0.5) * 0.25;
      this.sock.rotation.z = -0.5 + gust * 0.45;
    }
  }
}
