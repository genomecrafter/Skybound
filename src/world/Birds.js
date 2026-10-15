import * as THREE from 'three';
import { mulberry32 } from '../utils/math.js';

/**
 * Flock of birds flying on circular paths with flapping wings.
 *
 * Each bird is a small scene graph:
 *   bird (Group)                 <- TRANSLATION along a circle + ROTATION (heading, bank)
 *   ├── body, head (scaled spheres)
 *   ├── wingL pivot (Group)      <- ROTATION about Z = flapping
 *   └── wingR pivot (Group)
 *
 * The wing is a custom BufferGeometry (two triangles forming a swept wing
 * shape) defined vertex by vertex. Geometry and materials are shared by all
 * birds; only the transforms differ.
 *
 * Circular motion: angle(t) = angle0 + (speed / radius) * t
 *   position = centre + (r cos(angle), h, r sin(angle))
 * The heading is the tangent of the circle; birds also bank into the turn.
 */
function makeWingGeometry() {
  // Points in the wing's local XZ plane (x = outward span, -z = forward)
  const rootFront = [0, 0, -0.22];
  const elbow = [0.75, 0, -0.16];
  const tip = [1.55, 0, 0.3];
  const rootBack = [0, 0, 0.25];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([...rootFront, ...rootBack, ...elbow, ...elbow, ...rootBack, ...tip], 3),
  );
  geo.computeVertexNormals();
  return geo;
}

export class Birds {
  /**
   * @param {object} o
   * @param {number} o.count
   * @param {THREE.Vector3} o.center  centre of the circling area
   * @param {[number, number]} o.radius  min/max path radius
   * @param {[number, number]} o.height  min/max height
   * @param {number} [o.scale]  visual scale (birds are enlarged a little so they read at distance)
   */
  constructor({ count, center, radius, height, scale = 1.6, color = 0xf4f2ee, wingColor = 0xb9bec6, seed = 21 }) {
    this.group = new THREE.Group();
    this.group.name = 'Birds';
    const rand = mulberry32(seed);

    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
    const wingMat = new THREE.MeshStandardMaterial({ color: wingColor, roughness: 0.8, side: THREE.DoubleSide });
    const bodyGeo = new THREE.SphereGeometry(0.25, 8, 6);
    const headGeo = new THREE.SphereGeometry(0.14, 8, 6);
    const beakGeo = new THREE.ConeGeometry(0.05, 0.2, 5).rotateX(-Math.PI / 2);
    const beakMat = new THREE.MeshStandardMaterial({ color: 0xe0a030 });
    const wingGeo = makeWingGeometry();

    this.birds = [];
    for (let i = 0; i < count; i++) {
      const bird = new THREE.Group();
      bird.rotation.order = 'YXZ'; // heading first, then pitch, then bank

      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.scale.set(0.7, 0.6, 1.8); // non-uniform scale: sphere -> elongated body
      const head = new THREE.Mesh(headGeo, bodyMat);
      head.position.set(0, 0.08, -0.48);
      const beak = new THREE.Mesh(beakGeo, beakMat);
      beak.position.set(0, 0.06, -0.66);

      const wingR = new THREE.Group();
      wingR.add(new THREE.Mesh(wingGeo, wingMat));
      const wingL = new THREE.Group();
      const wl = new THREE.Mesh(wingGeo, wingMat);
      wl.scale.x = -1; // mirror the right wing to make the left one
      wingL.add(wl);
      wingR.position.set(0.1, 0.05, 0);
      wingL.position.set(-0.1, 0.05, 0);

      bird.add(body, head, beak, wingL, wingR);
      bird.scale.setScalar(scale);
      this.group.add(bird);

      const dir = rand() < 0.5 ? 1 : -1;
      this.birds.push({
        obj: bird,
        wingL,
        wingR,
        r: radius[0] + rand() * (radius[1] - radius[0]),
        h: height[0] + rand() * (height[1] - height[0]),
        angle: rand() * Math.PI * 2,
        speed: (10 + rand() * 6) * dir, // m/s along the circle (sign = direction)
        flapRate: 9 + rand() * 4,
        phase: rand() * 10,
      });
    }
    this.center = center.clone();
    this.time = 0;
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    const c = this.center;
    for (const b of this.birds) {
      b.angle += (b.speed / b.r) * dt;
      const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
      const bob = Math.sin(t * 0.7 + b.phase) * 2;
      b.obj.position.set(c.x + ca * b.r, c.y + b.h + bob, c.z + sa * b.r);

      // Velocity direction = tangent of the circle
      const s = Math.sign(b.speed);
      const vx = -sa * s, vz = ca * s;
      // Model faces -Z, so heading = atan2(-vx, -vz)
      b.obj.rotation.y = Math.atan2(-vx, -vz);
      // Bank into the turn: counter-clockwise (s>0 in this frame) turns right
      b.obj.rotation.z = -0.35 * s;

      // Flap in bursts, then glide (gulls glide a lot)
      const flapping = Math.sin(t * 0.5 + b.phase) > -0.2;
      const amp = flapping ? 0.65 : 0.08;
      const flap = Math.sin(t * b.flapRate + b.phase) * amp + (flapping ? 0.1 : 0.05);
      b.wingR.rotation.z = flap;
      b.wingL.rotation.z = -flap;
    }
  }
}
