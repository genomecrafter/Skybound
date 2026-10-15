// Ocean fragment shader.
//
//  * RIPPLES: a tileable NORMAL MAP made from fractal noise (see Water.js) is
//    sampled three times at different scales, scrolling in different
//    directions, and the slopes are added on top of the Gerstner normal.
//    Because the three layers never line up, the small-scale surface looks
//    random and alive instead of a regular sine pattern.
//  * ROUGHNESS FROM DISTANCE (Toksvig): far away, the mipmapped normal map
//    averages many tiny ripples into one shorter vector. The shorter it is,
//    the rougher the surface looks from here, so the sun highlight widens
//    into the long glittering path seen on real seas.
//  * FRESNEL (Schlick's approximation): water reflects more at grazing
//    angles. Looking straight down you see the deep water colour; toward the
//    horizon you mostly see the reflected sky.
//  * REFLECTION: the sky dome (gradient + high clouds) is captured into a
//    cube map once per route; we look it up in the reflected direction R.
//  * SUN GLITTER: normalised Blinn-Phong specular; bright enough to bloom.
//  * SUBSURFACE SCATTERING (fake): when looking toward the sun, light passes
//    through the thin top of each wave and the crests glow.
//  * FOAM: whitecaps where the Gerstner surface is compressed (Jacobian,
//    computed in the vertex shader), broken up by the noise texture.
//  * Fog and tone mapping use three.js shader chunks, so the ocean fades into
//    the horizon exactly like the terrain does.

uniform float uTime;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSssColor;
uniform float uWaveHeight; // largest wave amplitude, normalises vCrest
uniform sampler2D uNormalMap;
uniform samplerCube uSkyCube;
uniform float uHasSkyCube;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCrest;
varying float vFoam;

#include <common>
#include <fog_pars_fragment>

// Normal map texel -> slope (dh/dx, dh/dz) and the averaged normal length
vec3 rippleSlope(vec2 uv) {
  vec3 n = texture2D(uNormalMap, uv).xyz * 2.0 - 1.0;
  return vec3(n.xy / max(n.z, 0.2), length(n));
}

void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDir);
  float dist = distance(vWorldPos, cameraPosition);
  vec2 p = vWorldPos.xz;

  // ---- Ripples: three scrolling layers of the noise normal map ----
  vec3 r1 = rippleSlope(p / 41.0 + vec2(0.012, 0.007) * uTime);
  vec3 r2 = rippleSlope(p / 13.0 + vec2(-0.021, 0.016) * uTime);
  vec3 r3 = rippleSlope(p / 4.7 + vec2(0.035, -0.045) * uTime);
  float w3 = 1.0 - smoothstep(30.0, 180.0, dist);
  float w2 = 1.0 - smoothstep(120.0, 650.0, dist);
  vec2 slope = r1.xy * 0.3 + r2.xy * 0.24 * w2 + r3.xy * 0.2 * w3;
  vec3 N = normalize(normalize(vNormal) + vec3(-slope.x, 0.0, -slope.y));

  // Toksvig: shorter averaged normals -> rougher surface
  float tok = clamp(r1.z * 0.5 + r2.z * 0.5, 0.0, 1.0);
  float shininess = mix(60.0, 1400.0, pow(tok, 6.0)) / (1.0 + dist / 400.0);
  float roughness = clamp(sqrt(2.0 / (shininess + 2.0)) * 2.0, 0.0, 1.0);

  vec3 R = reflect(-V, N);
  R.y = abs(R.y); // rays pointing into the water would see the sky's ground colour

  // Fresnel (Schlick), F0 = 0.02 for water
  float cosTheta = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);

  // Reflected sky (cube map of the real sky dome, blurrier when rough)
  vec3 sky;
  if (uHasSkyCube > 0.5) sky = textureLod(uSkyCube, R, roughness * 6.0).rgb;
  else sky = mix(uSkyHorizon, uSkyTop, pow(max(R.y, 0.0), 0.6));

  // Body colour of the water (light scattered back from below the surface)
  float crest = clamp(vCrest / uWaveHeight * 0.5 + 0.5, 0.0, 1.0);
  vec3 body = mix(uDeepColor, uShallowColor, crest * 0.8);
  body *= 0.45 + 0.55 * max(dot(N, L) * 0.5 + 0.5, 0.0);

  vec3 col = mix(body, sky, fresnel);

  // Subsurface scattering through the wave tops, looking toward the sun
  vec3 Lh = normalize(vec3(L.x, 0.0, L.z));
  float toward = pow(clamp(dot(-V, Lh), 0.0, 1.0), 3.0);
  float sss = toward * smoothstep(0.45, 1.0, crest) * (1.0 - cosTheta * 0.6);
  col += uSssColor * sss * 0.45;

  // Sun glitter: normalised Blinn-Phong (energy stays sensible as it sharpens)
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  float spec = pow(nh, shininess) * (shininess + 8.0) / 25.0;
  col += uSunColor * min(spec, 30.0) * fresnel * 2.2 * smoothstep(-0.02, 0.06, L.y);

  // Whitecaps
  float pattern = texture2D(uNormalMap, p / 9.0 + vec2(0.01, 0.02) * uTime).a;
  float foam = smoothstep(0.35, 0.85, vFoam * (0.4 + pattern * 1.2)) * (1.0 - smoothstep(400.0, 1200.0, dist));
  vec3 foamLit = vec3(0.92) * (sky * 0.6 + uSunColor * max(dot(N, L), 0.0) * 0.8 + 0.15 * uSkyTop);
  col = mix(col, foamLit, foam * 0.85);

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
