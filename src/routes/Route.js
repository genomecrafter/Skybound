import * as THREE from 'three';

/**
 * Base class for a flight route. A route owns everything in its world
 * (terrain, props, lights) inside one Group, so switching routes is just
 * "remove group + dispose GPU resources".
 *
 * Subclasses provide:
 *   id, name
 *   atmosphere  preset passed to Environment.apply()
 *   spawn       { position, quaternion, speed }
 *   bounds      { x, z, radius, ceiling } soft play area
 *   build()     create objects and add them to this.group
 *   update(dt, time, game)
 *   groundAt(x, z)  height of solid ground (terrain) for collision
 */
export class Route {
  constructor(ctx) {
    this.ctx = ctx; // { scene, renderer, env }
    this.group = new THREE.Group();
    this.group.name = this.constructor.name;
    this.time = 0;

    this.waterLevel = null; // y of a soft water floor, or null
    this.obstacles = []; // vertical cylinders { x, z, r, top } (sea stacks, towers...)
    this.rings = null; // RingCourse
    this.moments = {}; // ring index -> { title, text } caption
    this.navLightStrength = 1;
    this.envExtras = []; // extra sky materials to include in the environment-map capture
  }

  /**
   * Start the player a short distance straight behind ring 1, facing it, so
   * the first ring is right in front of the camera when the route begins.
   * The direction comes from the ring's own facing (toward ring 2).
   */
  placeSpawnBeforeFirstRing(distance = 230) {
    const r = this.rings?.rings[0];
    if (!r) return;
    const dir = new THREE.Vector3(r.normal.x, 0, r.normal.z).normalize();
    const pos = r.center.clone().addScaledVector(dir, -distance);
    pos.y = r.center.y + 4;
    // Never start inside or right above the ground
    let ground = -Infinity;
    for (let k = 0; k <= 10; k++) {
      const q = r.center.clone().addScaledVector(dir, -distance * (k / 10));
      ground = Math.max(ground, this.groundAt(q.x, q.z), this.waterLevel ?? -Infinity);
    }
    pos.y = Math.max(pos.y, ground + 25);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    this.spawn = { position: pos, quaternion, speed: this.spawn?.speed ?? 42 };
  }

  build() {}

  update(_dt, _time, _game) {}

  groundAt(_x, _z) {
    return 0;
  }

  /** Is this world point inside solid ground or an obstacle? */
  isSolidAt(p) {
    if (p.y < this.groundAt(p.x, p.z)) return true;
    for (const o of this.obstacles) {
      const dx = p.x - o.x, dz = p.z - o.z;
      if (p.y < o.top && dx * dx + dz * dz < o.r * o.r) return true;
    }
    return false;
  }

  /** Free GPU memory: geometries, materials and textures are not garbage collected automatically. */
  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
        m.dispose();
      }
    });
    this.group.removeFromParent();
  }
}
