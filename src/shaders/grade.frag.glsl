// Final "camera lens" pass, applied to the finished (tone-mapped, sRGB) image.
//
//  * LENS FLARE: if the sun is on screen, add a glare around it and a chain
//    of coloured "ghosts" along the line from the sun through the screen
//    centre (in a real lens these are internal reflections between glass
//    elements). The sun's visibility is estimated by sampling the image
//    brightness at the sun's position: if an island or the plane covers the
//    sun, the pixels there are dark and the flare fades out. (Cheap occlusion
//    test - no depth buffer needed.)
//  * COLOUR GRADE: slight contrast + saturation boost.
//  * VIGNETTE: darken the corners, drawing the eye to the centre.
//  * FILM GRAIN: tiny animated noise that hides colour banding in the sky.

uniform sampler2D tDiffuse;
uniform vec2 uSunUv;        // sun position in screen UV (0..1)
uniform float uSunOnScreen; // 0 if behind the camera
uniform vec3 uFlareColor;
uniform float uFlareStrength;
uniform float uAspect;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
uniform float uTime;

varying vec2 vUv;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Fraction of "sun-bright" pixels in a small cross around the sun
float sunVisibility() {
  float v = 0.0;
  vec2 px = vec2(0.004 / uAspect, 0.004);
  for (int i = -2; i <= 2; i++) {
    v += step(0.92, luma(texture2D(tDiffuse, uSunUv + vec2(float(i), 0.0) * px).rgb));
    v += step(0.92, luma(texture2D(tDiffuse, uSunUv + vec2(0.0, float(i)) * px).rgb));
  }
  return v / 10.0;
}

float ghost(vec2 uv, vec2 pos, float size) {
  vec2 d = uv - pos;
  d.x *= uAspect;
  return smoothstep(size, size * 0.4, length(d));
}

void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;

  // ---- Lens flare ----
  if (uSunOnScreen > 0.5 && uFlareStrength > 0.0) {
    float vis = sunVisibility() * uFlareStrength;
    if (vis > 0.0) {
      vec2 d = vUv - uSunUv;
      d.x *= uAspect;
      float r = length(d);
      // Soft glare + horizontal anamorphic streak
      float glare = exp(-r * 14.0) * 0.22 + exp(-abs(d.y) * 160.0) * exp(-abs(d.x) * 3.5) * 0.12;
      vec3 flare = uFlareColor * glare;
      // Ghosts mirrored through the screen centre
      vec2 axis = vec2(0.5) - uSunUv;
      flare += vec3(1.0, 0.6, 0.3) * ghost(vUv, uSunUv + axis * 0.6, 0.035) * 0.12;
      flare += vec3(0.5, 0.8, 1.0) * ghost(vUv, uSunUv + axis * 1.25, 0.06) * 0.08;
      flare += vec3(0.9, 0.5, 1.0) * ghost(vUv, uSunUv + axis * 1.7, 0.10) * 0.06;
      flare += vec3(1.0, 0.9, 0.6) * ghost(vUv, uSunUv + axis * 2.1, 0.02) * 0.15;
      col += flare * vis;
    }
  }

  // ---- Colour grade ----
  col = (col - 0.5) * uContrast + 0.5;
  col = mix(vec3(luma(col)), col, uSaturation);

  // ---- Vignette ----
  vec2 v = vUv - 0.5;
  v.x *= uAspect * 0.8;
  col *= 1.0 - uVignette * smoothstep(0.35, 0.95, length(v));

  // ---- Film grain ----
  float n = fract(sin(dot(vUv * (uTime + 1.0), vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * 0.018;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
