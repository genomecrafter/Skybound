// Cloud puff vertex shader: INSTANCED BILLBOARDS.
//
// Every puff is one instance of a 1x1 quad. Instead of using the instance's
// rotation, we build the quad from the camera's right and up vectors, so it
// always faces the camera (billboarding), at the instance's centre and size.
// Camera right/up are the first two rows of the view matrix's rotation part.
// The same right/up/back vectors turn the per-pixel normal stored in the
// texture (which is in "billboard space") into a world-space normal.

attribute vec3 aCenter;    // centre of the cloud this puff belongs to
attribute vec3 aRadii;     // the cloud's ellipsoid radii (m)
attribute float aVariant;  // which of the 4 puff shapes in the texture atlas
attribute float aSpin;     // rotation of the quad in screen space (variety)
attribute float aOpacity;

varying vec2 vUv;
varying vec3 vCenter;
varying vec3 vRadii;
varying vec3 vWorldPos;
varying float vSize;
varying float vOpacity;
varying float vNearFade;
varying vec3 vViewDir;
varying vec3 vRight;
varying vec3 vUp;
varying vec2 vSpin;

#include <fog_pars_vertex>

void main() {
  vec3 centre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float size = length(instanceMatrix[0].xyz);

  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  float c = cos(aSpin), s = sin(aSpin);
  vec2 p = mat2(c, s, -s, c) * position.xy;
  vec3 worldPos = centre + (camRight * p.x + camUp * p.y) * size;

  // Atlas: 2x2 grid of puff shapes
  vec2 cell = vec2(mod(aVariant, 2.0), floor(aVariant / 2.0));
  vUv = (uv + cell) * 0.5;
  vCenter = aCenter;
  vRadii = aRadii;
  vWorldPos = worldPos;
  vSize = size;
  vOpacity = aOpacity;
  vRight = camRight;
  vUp = camUp;
  vSpin = vec2(c, s);

  // Fade puffs that get very close to the camera (flying through a cloud)
  vViewDir = normalize(worldPos - cameraPosition);
  float d = distance(centre, cameraPosition);
  vNearFade = smoothstep(size * 0.25, size * 1.1, d);

  vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
