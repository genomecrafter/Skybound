import * as THREE from 'three';
import ringVert from '../shaders/ring.vert.glsl?raw';
import ringFrag from '../shaders/ring.frag.glsl?raw';
import { createGlowSprite } from './Glow.js';

/**
 * A course of checkpoint rings that must be flown through in order.
 *
 * SCALING animations (the explicit "scaling" transformation demo):
 *   - the NEXT ring pulses: scale = 1 + 0.08 * sin(2*pi*f*t)
 *   - a PASSED ring bursts: it scales up to 1.9x while fading out
 *   - rings further ahead are drawn smaller and dimmer (scale 0.85)
 *
 * PASS DETECTION (plane crossing): each ring defines a plane with normal n
 * (its facing direction). For the aircraft positions before (p0) and after
 * (p1) a physics step we compute the signed distances
 *   s0 = (p0 - c) . n     s1 = (p1 - c) . n
 * A sign change from - to + means the aircraft crossed the plane in the
 * forward direction. We then interpolate the crossing point and check that
 * it lies within the ring radius.
 */
const STATE = { AHEAD: 0, NEXT: 1, BURST: 2, DONE: 3 };
const _v = new THREE.Vector3();
const _hit = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

export class RingCourse {
  /**
   * @param {THREE.Vector3[]} points  ring centres in flight order
   * @param {object} [o]
   */
  constructor(points, { radius = 9, color = 0xffc34d, aheadColor = 0x5fd8ff, fadeFar = 2600 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'Rings';
    this.radius = radius;
    this.nextIndex = 0;
    this.collected = 0;
    this.time = 0;
    this.colors = { next: new THREE.Color(color), ahead: new THREE.Color(aheadColor) };

    // One shared geometry; every ring gets its own material (own colour/opacity)
    const geo = new THREE.TorusGeometry(radius, 0.8, 12, 72);

    this.rings = points.map((p, i) => {
      // Face each ring along the path: direction from previous to next point
      const prev = points[i - 1] ?? p;
      const next = points[i + 1] ?? p;
      const normal = new THREE.Vector3().subVectors(next, prev);
      if (i === 0) normal.subVectors(next, p);
      if (i === points.length - 1) normal.subVectors(p, prev);
      normal.y *= 0.3; // keep rings mostly upright
      normal.normalize();

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: this.colors.ahead.clone() },
          uTime: { value: 0 },
          uIntensity: { value: 1 },
          uOpacity: { value: 1 },
          uFadeFar: { value: fadeFar },
        },
        vertexShader: ringVert,
        fragmentShader: ringFrag,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(p);
      // Torus is built in the XY plane (axis = +Z): rotate +Z onto the normal
      mesh.quaternion.setFromUnitVectors(Z, normal);
      const glow = createGlowSprite(0xffd27a, radius * 3.2, 0);
      mesh.add(glow);
      this.group.add(mesh);
      return { mesh, mat, glow, center: p.clone(), normal, state: STATE.AHEAD, t: 0 };
    });
    this.setNext(0);
  }

  get total() {
    return this.rings.length;
  }

  get finished() {
    return this.nextIndex >= this.rings.length;
  }

  /** The ring the player should fly through next (or null when finished). */
  get nextRing() {
    return this.rings[this.nextIndex] ?? null;
  }

  setNext(i) {
    this.nextIndex = i;
    this.rings.forEach((r, k) => {
      if (k < i) return;
      r.state = k === i ? STATE.NEXT : STATE.AHEAD;
      r.mesh.visible = true;
      r.mat.uniforms.uColor.value.copy(k === i ? this.colors.next : this.colors.ahead);
    });
  }

  /** Reset the whole course (restart route). */
  reset() {
    this.collected = 0;
    this.rings.forEach((r) => (r.state = STATE.AHEAD));
    this.setNext(0);
  }

  /**
   * Check whether the aircraft moved through the next ring between p0 and p1.
   * @returns {number} index of the ring just passed, or -1
   */
  checkPass(p0, p1) {
    const r = this.nextRing;
    if (!r) return -1;
    const s0 = _v.subVectors(p0, r.center).dot(r.normal);
    const s1 = _v.subVectors(p1, r.center).dot(r.normal);
    if (!(s0 < 0 && s1 >= 0)) return -1;
    // Interpolate the exact crossing point and test the distance to the centre
    const t = s0 / (s0 - s1);
    _hit.lerpVectors(p0, p1, t);
    if (_hit.distanceTo(r.center) > this.radius + 1.5) return -1; // generous margin
    const idx = this.nextIndex;
    r.state = STATE.BURST;
    r.t = 0;
    this.collected++;
    this.setNext(idx + 1);
    return idx;
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    for (const r of this.rings) {
      const u = r.mat.uniforms;
      u.uTime.value = t;
      switch (r.state) {
        case STATE.NEXT: {
          // Pulsing SCALE + brighter glow on the active ring
          const pulse = 1 + 0.08 * Math.sin(t * Math.PI * 2 * 1.2);
          r.mesh.scale.setScalar(pulse);
          u.uIntensity.value = 1.6;
          u.uOpacity.value = 1;
          r.glow.material.opacity = 0.35 + 0.15 * Math.sin(t * 7.5);
          break;
        }
        case STATE.AHEAD:
          r.mesh.scale.setScalar(0.85);
          u.uIntensity.value = 0.7;
          u.uOpacity.value = 1;
          r.glow.material.opacity = 0;
          break;
        case STATE.BURST: {
          // BURST: grow quickly while fading out, then hide
          r.t += dt / 0.7;
          const k = Math.min(r.t, 1);
          r.mesh.scale.setScalar(1 + 0.9 * (1 - Math.pow(1 - k, 3))); // ease-out
          u.uOpacity.value = 1 - k;
          u.uIntensity.value = 2.5;
          r.glow.material.opacity = 0.8 * (1 - k);
          if (k >= 1) {
            r.state = STATE.DONE;
            r.mesh.visible = false;
          }
          break;
        }
        default:
          break;
      }
    }
  }
}
