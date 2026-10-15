import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import gradeFrag from '../shaders/grade.frag.glsl?raw';
import { CONFIG } from '../config.js';

/**
 * Post-processing pipeline (image effects applied after the 3D render).
 *
 *   RenderPass   scene -> HDR float buffer (linear colour, values can exceed 1.0)
 *   SanitizePass replaces invalid pixels (NaN / Infinity) with black and caps
 *                extreme values. Without it, a single bad pixel would be
 *                spread by the bloom blur into a huge black rectangle.
 *   BloomPass    bright pixels (sun, rings, glitter, lamps) are blurred at
 *                several resolutions and added back -> realistic glow/"bleed"
 *   OutputPass   tone mapping (ACES) + linear -> sRGB conversion
 *   GradePass    lens flare, colour grade, vignette, film grain (custom shader)
 *
 * Rendering to a float buffer first is what makes bloom look right: the sun
 * can be 10x brighter than white and still glow proportionally.
 * The render target uses 4x MSAA so edges stay anti-aliased.
 */
const _sun = new THREE.Vector3();

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.enabled = CONFIG.quality !== 'low';
    if (!this.enabled) return;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(
      new ShaderPass({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          varying vec2 vUv;
          void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
            gl_FragColor = vec4(min(c.rgb, vec3(64.0)), c.a);
          }`,
      }),
    );

    const B = CONFIG.bloom;
    // (UnrealBloomPass internally blurs at half resolution and below: cheap)
    this.bloom = new UnrealBloomPass(size.clone(), B.strength, B.radius, B.threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.grade = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uSunUv: { value: new THREE.Vector2() },
        uSunOnScreen: { value: 0 },
        uFlareColor: { value: new THREE.Color(0xffd8a0) },
        uFlareStrength: { value: 1 },
        uAspect: { value: size.x / size.y },
        uVignette: { value: 0.35 },
        uSaturation: { value: 1.08 },
        uContrast: { value: 1.05 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: gradeFrag,
    });
    this.composer.addPass(this.grade);
    // Re-apply the CSS size so every pass is sized as (CSS size x pixel ratio)
    this.setSize(window.innerWidth, window.innerHeight);
  }

  /** Per-route look: bloom strength, flare colour/strength etc. */
  apply(preset = {}) {
    if (!this.enabled) return;
    const B = CONFIG.bloom;
    this.bloom.strength = preset.bloom ?? B.strength;
    this.bloom.threshold = preset.bloomThreshold ?? B.threshold;
    const u = this.grade.uniforms;
    u.uFlareStrength.value = preset.flare ?? 1;
    if (preset.flareColor !== undefined) u.uFlareColor.value.set(preset.flareColor);
    u.uSaturation.value = preset.saturation ?? 1.08;
    u.uVignette.value = preset.vignette ?? 0.35;
  }

  /** Project the sun direction to screen space for the lens flare. */
  updateSun(camera, sunDir, time) {
    if (!this.enabled) return;
    const u = this.grade.uniforms;
    u.uTime.value = time % 100;
    _sun.copy(sunDir).multiplyScalar(1000).add(camera.position).project(camera);
    const onScreen = _sun.z < 1 && Math.abs(_sun.x) < 1.2 && Math.abs(_sun.y) < 1.2;
    u.uSunOnScreen.value = onScreen ? 1 : 0;
    u.uSunUv.value.set(_sun.x * 0.5 + 0.5, _sun.y * 0.5 + 0.5);
  }

  render(scene, camera) {
    if (this.enabled) this.composer.render();
    else this.renderer.render(scene, camera);
  }

  /** Change the internal render resolution (used by the adaptive resolution governor). */
  setPixelRatio(pr) {
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (!this.enabled) return;
    this.composer.setPixelRatio(pr);
    this.setSize(window.innerWidth, window.innerHeight);
  }

  setSize(w, h) {
    if (!this.enabled) return;
    this.composer.setSize(w, h);
    this.grade.uniforms.uAspect.value = w / h;
  }
}
