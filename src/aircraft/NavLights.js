import * as THREE from 'three';

/**
 * Aircraft navigation lights: red on the LEFT wing tip, green on the RIGHT,
 * and a white strobe on top of the tail fin.
 *
 * Each light = a small unlit bulb mesh (always visible, even from far away)
 * + a short-range PointLight that actually illuminates the wing and nearby
 * terrain (most visible on the night Aurora route).
 *
 * The PointLight sits ~0.5 m away from the surface: with physically based
 * inverse-square falloff (intensity / distance^2) a light only a few cm from
 * the wing would flood it with light and over-expose it.
 *
 * PERFORMANCE NOTE: three.js compiles the number of lights into every lit
 * shader, so adding/removing lights at runtime forces shader recompiles
 * (a visible stutter). We therefore keep the lights in the scene permanently
 * and only change their INTENSITY to blink them.
 */
export class NavLights {
  constructor(aircraft) {
    const bulbGeo = new THREE.SphereGeometry(0.09, 10, 8);

    const make = (mount, color, distance, offset) => {
      const mat = new THREE.MeshBasicMaterial({ color });
      const bulb = new THREE.Mesh(bulbGeo, mat);
      const light = new THREE.PointLight(color, 0, distance, 2);
      light.position.copy(offset);
      mount.add(bulb, light);
      return { mat, light, color: new THREE.Color(color) };
    };

    // Wing mounts live inside the (mirrored) wing groups, so +X is always outward
    this.left = make(aircraft.mounts.navLeft, 0xff2a1a, 10, new THREE.Vector3(0.6, 0, 0));
    this.right = make(aircraft.mounts.navRight, 0x22ff55, 10, new THREE.Vector3(0.6, 0, 0));
    this.strobe = make(aircraft.mounts.tailStrobe, 0xffffff, 16, new THREE.Vector3(0, 0.6, 0.3));
    this.time = 0;
    this.strength = 1; // routes scale this (bright at night, subtle by day)
  }

  update(dt) {
    this.time += dt;
    const t = this.time;

    // Wing lights: slow smooth pulse (period 1.6 s)
    const pulse = 0.55 + 0.45 * Math.sin(t * Math.PI * 1.25);
    // Tail strobe: classic double flash every 1.2 s
    const p = t % 1.2;
    const flash = p < 0.06 || (p > 0.16 && p < 0.22) ? 1 : 0;

    this.set(this.left, pulse, 2.0);
    this.set(this.right, pulse, 2.0);
    this.set(this.strobe, flash, 5.0);
  }

  set(nav, level, maxIntensity) {
    nav.light.intensity = level * maxIntensity * this.strength;
    // Bulb colour fades toward dark when "off"
    nav.mat.color.copy(nav.color).multiplyScalar(0.25 + 0.75 * level);
  }
}
