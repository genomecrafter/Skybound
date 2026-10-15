import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Sky } from './Sky.js';

/**
 * Global atmosphere shared by every route: sky dome, fog, sun and fill light.
 * Each route supplies an "atmosphere preset" and calls apply(preset).
 *
 * LIGHTING MODEL
 *  - DirectionalLight ("sun" or "moon"): parallel rays, like a light source
 *    infinitely far away. It is the only light that casts shadows here.
 *  - HemisphereLight: cheap ambient fill that blends a sky colour (from above)
 *    and a ground colour (from below) based on each surface normal, so faces
 *    pointing down are tinted by bounced ground light.
 *
 *  - ENVIRONMENT MAP (image-based lighting): the sky dome is rendered into a
 *    cube map and pre-filtered with PMREM (Prefiltered Mipmapped Radiance
 *    Environment Map). Physically based materials sample it for reflections
 *    (blurrier mip levels for rougher surfaces) and soft ambient light, so the
 *    aircraft's glossy paint and canopy glass reflect each route's sky.
 *
 * SHADOWS
 *  A directional light renders a depth map from the light's point of view
 *  using an ORTHOGRAPHIC shadow camera. Covering the whole 5 km world would
 *  spread the shadow-map pixels too thin, so instead the shadow camera only
 *  covers a small box around the aircraft and follows it every frame
 *  (a simple form of "cascaded"/focused shadows).
 */
export class Environment {
  constructor(scene) {
    this.scene = scene;

    this.sky = new Sky();
    scene.add(this.sky.mesh);

    // THREE.Fog = linear fog between near and far distance.
    scene.fog = new THREE.Fog(0xbcd6ee, 400, 3000);
    scene.background = new THREE.Color(0xbcd6ee);

    this.hemi = new THREE.HemisphereLight(0xbcd6ee, 0x55604a, 1.0);
    scene.add(this.hemi);

    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 2.5));
    sun.castShadow = true;
    sun.shadow.mapSize.set(CONFIG.shadowMapSize, CONFIG.shadowMapSize);
    const S = 45; // half-size of the shadow box around the aircraft (m)
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 600 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target); // the target must be in the scene to update its matrix

    this.sunDir = new THREE.Vector3(0.3, 0.6, -0.5).normalize();

    // A tiny scene containing only a small copy of the sky dome, used to
    // capture the environment map (the shader only uses the view direction,
    // so the radius doesn't matter).
    this.envScene = new THREE.Scene();
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), this.sky.mesh.material));
    this.envTarget = null;
  }

  /**
   * @param {object} p atmosphere preset:
   *   sky:  { top, horizon, bottom, sunColor, sunSize, sunGlow, gradientExp }
   *   sunDir: Vector3 (direction TOWARD the sun/moon)
   *   sunLight: { color, intensity }   hemi: { sky, ground, intensity }
   *   fog: { color, near, far }        exposure
   */
  apply(p, renderer, extras = []) {
    this.envExtras = extras;
    this.sunDir.copy(p.sunDir).normalize();
    this.sky.apply({ ...p.sky, sunDir: this.sunDir });

    this.scene.fog.color.set(p.fog.color);
    this.scene.fog.near = p.fog.near;
    this.scene.fog.far = p.fog.far;
    this.scene.background.set(p.fog.color);

    this.sun.color.set(p.sunLight.color);
    this.sun.intensity = p.sunLight.intensity;
    this.hemi.color.set(p.hemi.sky);
    this.hemi.groundColor.set(p.hemi.ground);
    this.hemi.intensity = p.hemi.intensity;

    if (renderer) {
      renderer.toneMappingExposure = p.exposure ?? 1.0;
      this.updateEnvMap(renderer);
    }
    this.scene.environmentIntensity = p.envIntensity ?? 0.6;
  }

  /** Capture the current sky into a pre-filtered environment map. */
  updateEnvMap(renderer) {
    // Leave the sharp sun disc (and most of its halo) OUT of the capture: the
    // DirectionalLight already produces the sun's specular highlight, and
    // counting it twice makes glossy paint glare unrealistically.
    const u = this.sky.uniforms;
    const size = u.sunSize.value, glow = u.sunGlow.value;
    u.sunSize.value = 0;
    u.sunGlow.value = glow * 0.3;
    // Route-specific sky layers (e.g. the aurora) are captured too
    const extraMeshes = (this.envExtras ?? []).map((m) => new THREE.Mesh(new THREE.SphereGeometry(45, 32, 16), m));
    if (extraMeshes.length) this.envScene.add(...extraMeshes);
    // Sharp cube map of the sky (with its cloud layer) for the ocean's reflections
    if (!this.skyCube) {
      this.skyCube = new THREE.WebGLCubeRenderTarget(256, {
        type: THREE.HalfFloatType,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
      });
      this.cubeCamera = new THREE.CubeCamera(0.1, 200, this.skyCube);
    }
    this.cubeCamera.update(renderer, this.envScene);
    const pmrem = new THREE.PMREMGenerator(renderer);
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = pmrem.fromScene(this.envScene, 0, 0.1, 200);
    pmrem.dispose();
    for (const m of extraMeshes) {
      this.envScene.remove(m);
      m.geometry.dispose();
    }
    u.sunSize.value = size;
    u.sunGlow.value = glow;
    this.scene.environment = this.envTarget.texture;
  }

  /** Keep the sky centred on the camera and the shadow box on the aircraft. */
  update(camera, focus) {
    this.sky.update(camera);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 300);
  }
}
