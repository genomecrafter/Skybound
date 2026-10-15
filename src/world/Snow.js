import * as THREE from 'three';
import { mulberry32 } from '../utils/math.js';

/**
 * Falling snow, animated entirely on the GPU.
 *
 * The flakes are POINT SPRITES with fixed random start positions. The vertex
 * shader moves them (fall + sideways drift + wind) using only uTime, then
 * WRAPS each position into a box centred on the camera with mod():
 *   p = mod(p - camera + box/2, box) - box/2 + camera
 * so a flake that falls out of the bottom reappears at the top. The box
 * travels with the camera, giving endless snowfall from a fixed number of
 * flakes with zero CPU work per frame.
 * As the plane flies at 50 m/s the flakes stream past, a strong speed cue.
 */
const vert = /* glsl */ `
  attribute float aSpeed;
  attribute float aPhase;
  uniform float uTime;
  uniform float uBox;
  uniform vec3 uCam;
  uniform vec3 uWind;
  uniform float uPixelRatio;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    p.y -= uTime * aSpeed;
    p.x += sin(uTime * 0.7 + aPhase * 6.3) * 1.5;
    p.z += cos(uTime * 0.5 + aPhase * 4.1) * 1.5;
    p += uWind * uTime;
    p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;

    vec4 mv = viewMatrix * vec4(p, 1.0);
    float dist = -mv.z;
    gl_PointSize = clamp(90.0 / dist, 1.0, 9.0) * uPixelRatio;
    // Fade near the box edge (avoids popping) and very close to the lens
    vAlpha = smoothstep(uBox * 0.5, uBox * 0.3, length(p - uCam)) * smoothstep(1.0, 4.0, dist);
    gl_Position = projectionMatrix * mv;
  }`;
const frag = /* glsl */ `
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.1, d) * vAlpha * 0.85;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(0.85, 0.9, 1.0), a);
  }`;

export class Snow {
  constructor({ count = 4000, box = 180, seed = 7 } = {}) {
    const rand = mulberry32(seed);
    const pos = new Float32Array(count * 3);
    const speed = new Float32Array(count);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos.set([(rand() - 0.5) * box, (rand() - 0.5) * box, (rand() - 0.5) * box], i * 3);
      speed[i] = 1.5 + rand() * 2.0;
      phase[i] = rand();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.uniforms = {
      uTime: { value: 0 },
      uBox: { value: box },
      uCam: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector3(1.2, 0, 0.6) },
      uPixelRatio: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'Snow';
    this.points.frustumCulled = false;
  }

  update(dt, camera, renderer) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uCam.value.copy(camera.position);
    this.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  }
}
