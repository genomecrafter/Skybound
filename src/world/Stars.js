import * as THREE from 'three';
import { mulberry32 } from '../utils/math.js';

/**
 * Star field drawn as POINT SPRITES (THREE.Points): each star is a single
 * vertex that the GPU expands into a small square (gl_PointSize); the
 * fragment shader turns the square into a soft round dot.
 *
 *  - Stars lie on a big sphere around the camera (they follow it, like the
 *    sky dome, so they are infinitely far away).
 *  - Each star has its own size, colour temperature and twinkle phase.
 *  - Twinkle = brightness modulated by sin(time * speed + phase).
 *  - Stars fade out near the horizon where the atmosphere is thickest.
 */
const vert = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 dir = normalize(position);
    float twinkle = 0.65 + 0.35 * sin(uTime * (1.5 + aPhase) + aPhase * 10.0);
    vAlpha = twinkle * smoothstep(0.0, 0.18, dir.y);
    vColor = aColor;
    gl_PointSize = aSize * uPixelRatio;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const frag = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    // gl_PointCoord: 0..1 across the point sprite
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    gl_FragColor = vec4(vColor * a * 1.6, 1.0);
  }`;

export class Stars {
  constructor({ count = 4000, radius = 4200, seed = 3 } = {}) {
    const rand = mulberry32(seed);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const tints = [new THREE.Color(0xbfd4ff), new THREE.Color(0xffffff), new THREE.Color(0xfff1d0), new THREE.Color(0xffd2b0)];
    for (let i = 0; i < count; i++) {
      // Uniform random direction on the upper hemisphere
      const u = rand() * 2 * Math.PI;
      const y = rand() * 1.05 - 0.05;
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(u) * r * radius, y * radius, Math.sin(u) * r * radius], i * 3);
      // Many faint stars, few bright ones (power distribution)
      size[i] = 1.2 + Math.pow(rand(), 6) * 4.0;
      phase[i] = rand();
      const c = tints[Math.floor(rand() * tints.length)];
      color.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));

    this.uniforms = { uTime: { value: 0 }, uPixelRatio: { value: 1 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'Stars';
    this.points.frustumCulled = false;
    this.points.renderOrder = -0.5; // just after the sky dome
  }

  update(dt, camera, renderer) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    this.points.position.copy(camera.position);
  }
}
