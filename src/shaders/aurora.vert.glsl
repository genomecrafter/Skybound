// Aurora dome vertex shader.
// Like the sky dome, the aurora is drawn on a large sphere centred on the
// camera; the fragment shader only needs the viewing direction.
varying vec3 vDir;

void main() {
  vDir = position; // sphere centred at the origin of its local space
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
