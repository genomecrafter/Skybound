import * as THREE from 'three';
import vertexShader from '../shaders/sky.vert.glsl?raw';
import fragmentShader from '../shaders/sky.frag.glsl?raw';

/**
 * Sky dome: a big inverted sphere rendered with a custom ShaderMaterial.
 *
 * - side: BackSide  -> we see the inside faces of the sphere.
 * - depthWrite: false + renderOrder -1 -> drawn first, behind everything.
 * - fog: false      -> the sky IS the fog colour; it must not be fogged itself.
 * - The dome follows the camera position every frame, so the horizon is
 *   infinitely far away (you can never fly "out" of the sky).
 */
export class Sky {
  constructor(radius = 4500) {
    this.uniforms = {
      topColor: { value: new THREE.Color(0x3a78c8) },
      horizonColor: { value: new THREE.Color(0xbcd6ee) },
      bottomColor: { value: new THREE.Color(0x6a7a88) },
      sunDirection: { value: new THREE.Vector3(0.3, 0.6, -0.5).normalize() },
      sunColor: { value: new THREE.Color(0xfff2d0) },
      sunSize: { value: 0.03 },
      sunGlow: { value: 1.0 },
      gradientExp: { value: 0.6 },
      // High cloud layer (see sky.frag.glsl)
      uTime: { value: 0 },
      cloudCover: { value: 0 },
      cloudScale: { value: 1 },
      cloudStretch: { value: new THREE.Vector2(1, 1) },
      cloudWind: { value: new THREE.Vector2(0.01, 0.004) },
      cloudLit: { value: new THREE.Color(0xffffff) },
      cloudShade: { value: new THREE.Color(0x9aa8b8) },
      cloudOpacity: { value: 0.9 },
      cloud2: { value: new THREE.Vector4(0, 2, 1, 0.9) }, // lower layer: cover, scale, stretch, opacity
      uCamPos: { value: new THREE.Vector3() },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      // three.js mixes fog in AFTER tone mapping, so fully-fogged terrain shows
      // the raw fog colour. The sky must therefore skip tone mapping too,
      // otherwise its horizon would not match the fog exactly.
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
    this.mesh.name = 'SkyDome';
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  /**
   * Apply a route's sky settings.
   * @param {object} p { top, horizon, bottom, sunDir: Vector3, sunColor, sunSize, sunGlow, gradientExp,
   *   clouds: { cover, scale, stretch: [x, y], wind: [x, y], lit, shade, opacity,
   *             low: { cover, scale, stretch, opacity } } }
   */
  apply(p) {
    const u = this.uniforms;
    u.topColor.value.set(p.top);
    u.horizonColor.value.set(p.horizon);
    u.bottomColor.value.set(p.bottom ?? p.horizon);
    u.sunDirection.value.copy(p.sunDir).normalize();
    u.sunColor.value.set(p.sunColor);
    u.sunSize.value = p.sunSize ?? 0.03;
    u.sunGlow.value = p.sunGlow ?? 1.0;
    u.gradientExp.value = p.gradientExp ?? 0.6;
    const c = p.clouds ?? {};
    u.cloudCover.value = c.cover ?? 0;
    u.cloudScale.value = c.scale ?? 1;
    u.cloudStretch.value.fromArray(c.stretch ?? [1, 1]);
    u.cloudWind.value.fromArray(c.wind ?? [0.01, 0.004]);
    u.cloudLit.value.set(c.lit ?? 0xffffff);
    if (c.litBoost) u.cloudLit.value.multiplyScalar(c.litBoost); // HDR: brighter than 1 can bloom
    u.cloudShade.value.set(c.shade ?? 0x9aa8b8);
    u.cloudOpacity.value = c.opacity ?? 0.9;
    const l = c.low ?? {};
    u.cloud2.value.set(l.cover ?? 0, l.scale ?? 2, l.stretch ?? 1, l.opacity ?? 0.9);
  }

  update(camera) {
    this.mesh.position.copy(camera.position);
    this.uniforms.uCamPos.value.copy(camera.position);
    this.uniforms.uTime.value = performance.now() / 1000;
  }
}
