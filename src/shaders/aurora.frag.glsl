// Aurora borealis: RAYMARCHED VOLUMETRIC LAYERS on a sky dome.
//
// Real aurora is a thin, glowing curtain of excited gas ~100 km up. To give it
// depth, for every sky pixel we march along the view ray through a stack of
// horizontal layers (STEPS of them, each a little higher than the last):
//
//   for each layer i:
//     t   = distance along the ray to the layer's height
//     p   = where the ray hits the layer (2D position on that layer)
//     d   = streaks(p)        -> density of glowing gas there
//     col = green at the bottom layers ... violet / red at the top layers
//     accumulate col * d, fading with layer index
//
// Because neighbouring layers see slightly shifted patterns, the result has
// the soft vertical "ray" structure and the colour gradient of real aurora.
//
// streaks(): a "triangle-wave noise". The 2D domain is repeatedly warped by
// triangle waves and rotated, a few octaves deep. Its output peaks along thin,
// wavy filaments that slowly drift with time - the folded curtains.
//
// Technique credit: the layered-raymarch + triangle-noise approach follows
// the well-known "Auroras" shader by nimitz (Shadertoy, CC BY-NC-SA 3.0),
// re-implemented and adapted here for three.js.

uniform float uTime;
uniform float uIntensity;
uniform vec2 uOffset; // slow drift of the pattern (and a hint of parallax)

varying vec3 vDir;

#ifndef STEPS
#define STEPS 32
#endif

float tri(float x) { return clamp(abs(fract(x) - 0.5), 0.01, 0.49); }
vec2 tri2(vec2 p) { return vec2(tri(p.x) + tri(p.y), tri(p.y + tri(p.x))); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

float streaks(vec2 p, float t) {
  float amp = 1.8;
  float warpAmp = 2.5;
  float acc = 0.0;
  p *= rot(p.x * 0.06);
  vec2 bp = p;
  for (int i = 0; i < 5; i++) {
    vec2 dg = tri2(bp * 1.85) * 0.75; // domain warp from triangle waves
    dg *= rot(t * 0.06);              // animate the warp slowly
    p -= dg / warpAmp;
    bp *= 1.3;
    warpAmp *= 0.45;
    amp *= 0.42;
    p *= 1.21 + (acc - 1.0) * 0.02;
    acc += tri(p.x + tri(p.y)) * amp;
    p *= -mat2(0.95534, 0.29552, -0.29552, 0.95534); // rotate each octave
  }
  // Thin bright filaments where acc is small
  return clamp(1.0 / pow(acc * 29.0, 1.3), 0.0, 0.55);
}

float hash21(vec2 n) { return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 43758.5453); }

void main() {
  vec3 rd = normalize(vDir);
  if (rd.y < 0.0) discard;

  vec3 acc = vec3(0.0);
  vec3 avg = vec3(0.0);
  float jitter = hash21(gl_FragCoord.xy); // dithering hides the layer steps
  float stepScale = 50.0 / float(STEPS);

  for (int i = 0; i < STEPS; i++) {
    float fi = float(i) * stepScale;
    float h = 0.8 + pow(fi, 1.4) * 0.002;           // layer height
    float t = h / (rd.y * 2.0 + 0.4);               // distance to it (+0.4 tames the horizon)
    t -= 0.006 * jitter * smoothstep(0.0, 15.0, fi);
    vec2 p = rd.zx * t + uOffset;
    float d = streaks(p, uTime);
    // Colour by altitude: green low -> blue/violet -> faint red high
    vec3 layer = (sin(1.0 - vec3(2.15, -0.5, 1.2) + fi * 0.043) * 0.5 + 0.5) * d;
    avg = mix(avg, layer, 0.5);
    acc += avg * exp2(-fi * 0.065 - 2.5) * smoothstep(0.0, 5.0, fi) * stepScale;
  }

  // Fade into the horizon haze, and let parts of the sky stay clear
  acc *= clamp(rd.y * 15.0 + 0.4, 0.0, 1.0);
  float region = 0.35 + 0.65 * smoothstep(-0.4, 0.5, sin(rd.x * 2.3 + 0.8) * cos(rd.z * 1.7 - 0.4));
  gl_FragColor = vec4(acc * 1.8 * uIntensity * region, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
