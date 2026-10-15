// Checkpoint ring vertex shader.
varying vec2 vUv;
varying vec3 vViewNormal;
varying vec3 vViewDir;
varying float vDist;

void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewNormal = normalize(normalMatrix * normal);
  vViewDir = normalize(-mvPosition.xyz);
  vDist = -mvPosition.z; // distance in front of the camera
  gl_Position = projectionMatrix * mvPosition;
}
