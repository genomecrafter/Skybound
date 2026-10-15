import * as THREE from 'three';
import { clamp } from '../utils/math.js';

/**
 * Wing-tip vapour trails (condensation in the low-pressure wing-tip vortex,
 * seen on real aircraft pulling hard in humid air).
 *
 * Each trail is a RIBBON: a triangle strip through the last N wing-tip
 * positions. Every frame the history is shifted by one slot and the newest
 * position is written at the front, then the vertex buffer is updated
 * (dynamic geometry). Each point stores its own opacity, so the trail fades
 * with age and only appears while the plane pulls g or boosts.
 */
const N = 60;
const vert = /* glsl */ `
  attribute float aAlpha;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }`;
const frag = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() { gl_FragColor = vec4(uColor, vAlpha); }`;

const _p = new THREE.Vector3();
const _up = new THREE.Vector3();

class Ribbon {
  constructor(material) {
    this.points = Array.from({ length: N }, () => new THREE.Vector3());
    this.ups = Array.from({ length: N }, () => new THREE.Vector3(0, 1, 0));
    this.alphas = new Float32Array(N);
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.alpha = new THREE.BufferAttribute(new Float32Array(N * 2), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aAlpha', this.alpha);
    const idx = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false; // vertices are already in world space
    this.primed = false;
  }

  push(point, up, intensity) {
    if (!this.primed) {
      this.points.forEach((p) => p.copy(point));
      this.primed = true;
    }
    // Shift history back by one slot (oldest drops off the end)
    for (let i = N - 1; i > 0; i--) {
      this.points[i].copy(this.points[i - 1]);
      this.ups[i].copy(this.ups[i - 1]);
      this.alphas[i] = this.alphas[i - 1];
    }
    this.points[0].copy(point);
    this.ups[0].copy(up);
    this.alphas[0] = intensity;

    for (let i = 0; i < N; i++) {
      const age = i / (N - 1);
      const w = 0.08 + age * 0.5; // trail widens as the vortex spreads
      const p = this.points[i], u = this.ups[i];
      this.pos.setXYZ(i * 2, p.x + u.x * w, p.y + u.y * w, p.z + u.z * w);
      this.pos.setXYZ(i * 2 + 1, p.x - u.x * w, p.y - u.y * w, p.z - u.z * w);
      const a = this.alphas[i] * (1 - age) * (1 - age) * 0.55;
      this.alpha.setX(i * 2, a);
      this.alpha.setX(i * 2 + 1, a);
    }
    this.pos.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  reset() {
    this.primed = false;
    this.alphas.fill(0);
  }
}

export class Trails {
  constructor(aircraft) {
    this.aircraft = aircraft;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffffff) } },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.left = new Ribbon(this.material);
    this.right = new Ribbon(this.material);
    this.group = new THREE.Group();
    this.group.add(this.left.mesh, this.right.mesh);
    this.intensity = 0;
    this.humidity = 1; // routes scale this (dry canyon = less vapour)
  }

  reset() {
    this.left.reset();
    this.right.reset();
  }

  update(dt, flight) {
    // Vapour appears when pulling g or boosting at speed
    const target =
      clamp(Math.max((flight.gLoad - 1.6) / 1.4, flight.boosting ? 0.6 : 0), 0, 1) *
      clamp((flight.speed - 25) / 30, 0, 1) *
      this.humidity;
    this.intensity += (target - this.intensity) * Math.min(1, dt * 6);
    _up.set(0, 1, 0).applyQuaternion(flight.quaternion);
    const m = this.aircraft.mounts;
    m.navLeft.getWorldPosition(_p);
    this.left.push(_p, _up, this.intensity);
    m.navRight.getWorldPosition(_p);
    this.right.push(_p, _up, this.intensity);
  }
}
