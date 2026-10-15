// Light-beam vertex shader (shared by the lighthouse beam and glow effects).
varying vec2 vUv;
varying vec3 vViewNormal;
varying vec3 vViewDir;

void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewNormal = normalize(normalMatrix * normal);
  vViewDir = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
}
