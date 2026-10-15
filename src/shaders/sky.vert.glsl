// Sky dome vertex shader.
// The dome is a large sphere centred on the camera. We only need the
// direction from the centre to each vertex: the fragment shader colours the
// sky by that direction (its height above the horizon, angle to the sun).

varying vec3 vDir;

void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
