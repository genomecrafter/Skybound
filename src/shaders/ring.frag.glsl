// Glowing checkpoint ring.
//
//  * Rim glow (fresnel-like): parts of the tube seen edge-on glow brighter,
//    giving a neon-tube look.
//  * Energy pulses travel around the ring: uv.x runs 0..1 around the torus,
//    so sin(uv.x * N - time) creates N moving bright bands.
//  * Additive blending + values above 1.0 make the ring "bloom" toward white
//    after tone mapping.
//  * Distance fade replaces fog (fog would ADD fog colour with additive blending).

uniform vec3 uColor;
uniform float uTime;
uniform float uIntensity;
uniform float uOpacity;
uniform float uFadeFar;

varying vec2 vUv;
varying vec3 vViewNormal;
varying vec3 vViewDir;
varying float vDist;

void main() {
  float facing = abs(dot(normalize(vViewNormal), normalize(vViewDir)));
  // max() matters: rounding can make facing slightly > 1, and pow() of a
  // negative number is undefined on the GPU (NaN -> black boxes after bloom)
  float rim = pow(max(1.0 - facing, 0.0), 2.0);
  float bands = 0.5 + 0.5 * sin(vUv.x * 6.2831853 * 10.0 - uTime * 6.0);
  float energy = 0.55 + 0.45 * bands;
  float fade = 1.0 - smoothstep(uFadeFar * 0.5, uFadeFar, vDist);

  vec3 col = uColor * (0.6 * energy + 1.6 * rim) * uIntensity;
  gl_FragColor = vec4(col * uOpacity * fade, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
