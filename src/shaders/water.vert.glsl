// Ocean vertex shader: GERSTNER WAVES.
//
// A plain sine wave only moves vertices up and down. A Gerstner (trochoidal)
// wave also moves them horizontally toward the crest, which gives the
// realistic sharp crests and wide flat troughs of ocean swell.
//
// For each wave with direction D, wavelength L and steepness Q:
//   k = 2*pi / L                (wave number)
//   c = sqrt(g / k)             (phase speed from deep-water dispersion)
//   f = k * (D . p - c * t)     (phase at point p, time t)
//   a = Q / k                   (amplitude)
//   offset = ( D.x*a*cos f,  a*sin f,  D.y*a*cos f )
// The analytic partial derivatives (tangent / binormal) give the exact
// surface normal, which the fragment shader needs for lighting.
//
// Eight waves with different directions and wavelengths (long swell down to
// short chop) are summed, so the pattern never visibly repeats.
//
// FOAM from the JACOBIAN: the determinant of the horizontal part of the
// tangent frame tells how much the surface is squeezed together. Where it
// gets small, the crest is about to fold over (break): that's where real
// whitecaps appear.
//
// The waves are evaluated at the WORLD position of each vertex, so the mesh
// can follow the camera while the waves stay fixed in the world.

#define NUM_WAVES 8

uniform float uTime;
uniform vec4 uWaves[NUM_WAVES]; // xy = direction, z = steepness, w = wavelength

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCrest; // wave height, used for colour and scattering
varying float vFoam;  // 0..1 whitecap amount

#include <fog_pars_vertex>

vec3 gerstner(vec4 wave, vec2 p, inout vec3 tangent, inout vec3 binormal) {
  float steep = wave.z;
  float k = 6.2831853 / wave.w;
  float c = sqrt(9.8 / k);
  vec2 d = normalize(wave.xy);
  float f = k * (dot(d, p) - c * uTime);
  float a = steep / k;
  float s = sin(f);
  float co = cos(f);
  tangent += vec3(-d.x * d.x * steep * s, d.x * steep * co, -d.x * d.y * steep * s);
  binormal += vec3(-d.x * d.y * steep * s, d.y * steep * co, -d.y * d.y * steep * s);
  return vec3(d.x * a * co, a * s, d.y * a * co);
}

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  float dist = distance(worldPos.xz, cameraPosition.xz);

  // Level of detail: each wave fades out once the grid is too coarse to show
  // it (short waves first), otherwise far triangles would only shimmer.
  float farFade = 1.0 - smoothstep(600.0, 2000.0, dist);

  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  vec3 offset = vec3(0.0);
  for (int i = 0; i < NUM_WAVES; i++) {
    vec4 w = uWaves[i];
    w.z *= farFade * (1.0 - smoothstep(w.w * 7.0, w.w * 28.0, dist));
    offset += gerstner(w, worldPos.xz, tangent, binormal);
  }
  worldPos.xyz += offset;

  vNormal = normalize(cross(binormal, tangent));
  vWorldPos = worldPos.xyz;
  vCrest = offset.y;
  float jacobian = tangent.x * binormal.z - tangent.z * binormal.x;
  vFoam = smoothstep(0.62, 0.22, jacobian);

  vec4 mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
