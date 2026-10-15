import * as THREE from 'three';
import vertexShader from '../shaders/aurora.vert.glsl?raw';
import fragmentShader from '../shaders/aurora.frag.glsl?raw';
import { CONFIG } from '../config.js';

/**
 * Aurora borealis drawn on a sky dome with a raymarching fragment shader
 * (see aurora.frag.glsl for the technique).
 *
 *  - The dome follows the camera like the sky, so the aurora appears
 *    infinitely far away (real aurora is ~100 km up).
 *  - ADDITIVE blending: the aurora only adds light, so stars shine through.
 *  - The number of raymarch steps is a quality setting (fewer on 'low').
 *  - uIntensity "breathes" slowly and surges during the route's moment.
 */
export class Aurora {
  constructor({ radius = 3900 } = {}) {
    this.uniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uOffset: { value: new THREE.Vector2() },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      defines: { STEPS: CONFIG.quality === 'low' ? 20 : 32 },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), this.material);
    this.mesh.name = 'Aurora';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0; // after the stars (-0.5): additive on top of them

    this.baseIntensity = 1.0;
    this.surge = 0; // extra brightness during the route's "moment"
  }

  /** Brighten the aurora for the route's big moment. */
  triggerSurge() {
    this.surge = 1;
  }

  update(dt, camera) {
    const u = this.uniforms;
    u.uTime.value += dt;
    const t = u.uTime.value;
    this.surge = Math.max(0, this.surge - dt / 25); // decays over 25 s
    u.uIntensity.value = this.baseIntensity * (0.8 + 0.2 * Math.sin(t * 0.25)) + this.surge * 0.9;
    // Slow drift + a tiny parallax from the camera position
    u.uOffset.value.set(t * 0.004 + camera.position.z * 0.00004, camera.position.x * 0.00004);
    this.mesh.position.copy(camera.position);
  }

  /** Overall brightness (~0.6..2), used to tint the scene's ambient light. */
  get glow() {
    return this.uniforms.uIntensity.value;
  }
}
