// Sky dome fragment shader: a procedural gradient sky with a sun/moon disc
// and a high, thin cloud layer (cirrus / altostratus).
//
//  * Vertical gradient: horizon colour -> zenith colour, shaped by a power
//    curve so most of the colour change happens near the horizon.
//  * Below the horizon we fade to a ground colour (rarely seen, hidden by terrain).
//  * Sun: a sharp disc (smoothstep on the angle to the sun) plus two glow
//    terms (pow of the cosine) giving a soft halo and a wide horizon bloom.
//
// CLOUD LAYERS (a high streaky one and an optional lower, broken one)
//  The view ray is intersected with a flat cloud plane high above the
//  camera: p = dir.xz / dir.y. Near the horizon p grows very large, so the
//  clouds shrink and crowd together with perspective, just like a real
//  cloud deck. Adding the camera position (divided by the layer height)
//  gives true motion parallax: the lower layer drifts past faster than the
//  high one as you fly. The pattern is DOMAIN-WARPED fBm (noise whose input is
//  displaced by more noise), which gives wispy, flowing shapes; stretching
//  one axis turns it into the long streaks seen at sunset.
//  Lighting is approximated from the density gradient: sampling the noise
//  again a little toward the sun tells us whether this point is on the
//  sun-facing edge (lit) or the far side (shaded). Thin cloud near the sun
//  glows from forward scattering (the "silver lining").
//
// The horizon colour is the same as the scene fog colour, so distant terrain
// fades seamlessly into the sky.

uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 bottomColor;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform float sunSize;      // angular radius (radians)
uniform float sunGlow;      // halo strength
uniform float gradientExp;  // shape of the vertical gradient

uniform float uTime;
uniform float cloudCover;   // 0 = clear sky .. 1 = overcast
uniform float cloudScale;   // pattern frequency
uniform vec2 cloudStretch;  // anisotropic scale (streaks)
uniform vec2 cloudWind;     // drift speed
uniform vec3 cloudLit;      // colour of the sun-facing side
uniform vec3 cloudShade;    // colour of the shaded side
uniform float cloudOpacity;
uniform vec4 cloud2;        // lower broken layer: cover, scale, stretch, opacity
uniform vec3 uCamPos;

varying vec3 vDir;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// fBm with a rotation between octaves (hides the value-noise grid)
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = m * p;
    a *= 0.5;
  }
  return s;
}

// One cloud layer. Returns (density, light): light 1 = sun-facing edge.
vec2 cloudLayer(vec3 dir, vec3 sun, float scale, vec2 stretch, float cover, float sharp, float height, float warp, vec2 seed) {
  float h = dir.y;
  vec2 p = (dir.xz / (h + 0.08) + uCamPos.xz / height) * scale;
  p *= stretch;
  p += cloudWind * uTime + seed;
  vec2 q = vec2(fbm(p * 0.6), fbm(p * 0.6 + vec2(5.2, 1.3)));
  vec2 w = p + q * warp;
  float n = fbm(w);
  float dens = smoothstep(1.0 - cover, 1.0 - cover + sharp, n);
  // Density a step toward the sun: lower there -> this is a lit edge
  vec2 toSun = normalize(sun.xz * stretch + 1e-4) * 0.12;
  float n2 = fbm(w + toSun);
  float light = clamp(0.55 + (n - n2) * 5.0, 0.0, 1.0);
  return vec2(dens, light);
}

vec3 shadeCloud(vec2 c, float cosA, float h, float darkBase) {
  float fwd = pow(max(cosA, 0.0), 6.0);     // forward scattering near the sun
  vec3 cc = mix(cloudShade * (1.0 - darkBase * c.x), cloudLit, c.y);
  cc += cloudLit * fwd * (1.0 - c.x) * 1.6; // bright thin edges toward the sun
  cc += sunColor * pow(max(cosA, 0.0), 40.0) * 0.6 * (1.0 - c.x * 0.5);
  // Atmospheric perspective: far (low) clouds dissolve into the horizon haze
  float haze = smoothstep(0.0, 0.25, h);
  return mix(horizonColor, cc, 0.35 + 0.65 * haze);
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  vec3 sun = normalize(sunDirection);

  // Sky gradient above the horizon, ground colour below
  vec3 sky = mix(horizonColor, topColor, pow(max(h, 0.0), gradientExp));
  sky = mix(sky, bottomColor, smoothstep(0.0, -0.15, h));

  // Sun / moon
  float cosA = dot(dir, sun);
  float disc = smoothstep(cos(sunSize), cos(sunSize * 0.85), cosA);
  float halo = pow(max(cosA, 0.0), 180.0) * 0.8 + pow(max(cosA, 0.0), 12.0) * 0.35;
  sky += sunColor * (disc * 3.0 + halo * sunGlow);

  float above = smoothstep(0.0, 0.06, h);
  // ---- High cloud layer (streaks) ----
  if (cloudCover > 0.0 && h > 0.0) {
    vec2 c = cloudLayer(dir, sun, cloudScale, cloudStretch, cloudCover, 0.3, 9000.0, 1.8, vec2(0.0));
    sky = mix(sky, shadeCloud(c, cosA, h, 0.0), c.x * cloudOpacity * above);
  }
  // ---- Lower broken layer (altocumulus): puffier, darker bases ----
  if (cloud2.x > 0.0 && h > 0.0) {
    vec2 c = cloudLayer(dir, sun, cloud2.y, vec2(1.0, cloud2.z), cloud2.x, 0.16, 2500.0, 0.8, vec2(31.7, -12.3));
    sky = mix(sky, shadeCloud(c, cosA, h, 0.35), c.x * cloud2.w * above);
  }

  gl_FragColor = vec4(sky, 1.0);

  // Convert linear -> sRGB output, exactly like three.js does for the fog
  // colour (the material has toneMapped: false, see Sky.js).
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
