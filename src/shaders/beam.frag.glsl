// Fake volumetric light beam ("god ray" cone).
//
// Real volumetric light is expensive, so we draw a transparent cone with
// ADDITIVE blending (colours add onto what is behind, so it can only brighten).
//  * Brightness falls off along the cone (uv.y = 1 at the lamp, 0 at the end).
//  * Faces seen edge-on are faded (|N . V| small) so the cone has soft edges
//    instead of a hard silhouette.

uniform vec3 uColor;
uniform float uIntensity;

varying vec2 vUv;
varying vec3 vViewNormal;
varying vec3 vViewDir;

void main() {
  float along = pow(clamp(vUv.y, 0.0, 1.0), 2.2);
  float facing = abs(dot(normalize(vViewNormal), normalize(vViewDir)));
  float soft = smoothstep(0.0, 0.6, facing);
  gl_FragColor = vec4(uColor * along * soft * uIntensity, 1.0);
}
