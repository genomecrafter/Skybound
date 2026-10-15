// Cloud puff fragment shader.
//
// The atlas stores, per pixel: a normal (RG, in billboard space), the
// thickness of the puff (B) and the opacity (A).
//
// Every puff is lit as part of its whole cloud, modelled as an ELLIPSOID
// (centre + radii per instance). Because neighbouring puffs then compute the
// same lighting at the same place, they blend into one soft volume.
//  * Pixel position: the billboard point pushed toward the camera by the
//    puff's bulge (texture normal z), so each puff is a rounded bump.
//  * NORMAL: gradient of the ellipsoid at that point, plus a little detail
//    from the texture normal.
//  * SELF-SHADOWING (Beer-Lambert law): we intersect a ray from the pixel
//    toward the sun with the ellipsoid; the distance travelled inside the
//    cloud gives the optical depth, and transmitted light = exp(-depth / k).
//    The sun side is bright, the far side fades smoothly into shadow.
//  * AMBIENT: sky colour from above, darker shadow colour toward the flat
//    base (the bottom of a real cumulus is grey).
//  * FORWARD SCATTERING ("silver lining"): water droplets scatter light mostly
//    forward, so when we look toward the sun the thin edges light up brightly
//    - modelled with pow(dot(viewDir, sunDir), n).

uniform sampler2D uMap;
uniform vec3 uLitColor;
uniform vec3 uShadowColor;
uniform vec3 uSkyColor;
uniform vec3 uSunDir;

varying vec2 vUv;
varying float vOpacity;
varying float vNearFade;
varying vec3 vViewDir;
varying vec3 vRight;
varying vec3 vUp;
varying vec2 vSpin;
varying vec3 vCenter;
varying vec3 vRadii;
varying vec3 vWorldPos;
varying float vSize;

#include <common>
#include <fog_pars_fragment>

void main() {
  vec4 t = texture2D(uMap, vUv);
  float alpha = t.a * vOpacity * vNearFade;
  if (alpha < 0.01) discard;

  vec3 V = normalize(vViewDir);
  vec3 L = normalize(uSunDir);

  // Texture normal (billboard space, rotated with the quad's spin)
  vec2 nxy = t.rg * 2.0 - 1.0;
  nxy = mat2(vSpin.x, vSpin.y, -vSpin.y, vSpin.x) * nxy;
  float nz = sqrt(max(1.0 - dot(nxy, nxy), 0.0));
  vec3 Nt = normalize(vRight * nxy.x + vUp * nxy.y - V * nz);

  // Point on the rounded puff, in the cloud's normalised ellipsoid space
  vec3 P = vWorldPos - V * (nz * vSize * 0.35);
  vec3 q = (P - vCenter) / vRadii;
  vec3 Ne = normalize(q / vRadii);
  vec3 N = normalize(Ne + Nt * 0.25);

  // Beer-Lambert: path length from P to the cloud surface toward the sun
  vec3 l = L / vRadii;
  float a = dot(l, l), b = dot(q, l), c = dot(q, q) - 1.0;
  float disc = b * b - a * c;
  float depth = disc > 0.0 ? max((-b + sqrt(disc)) / a, 0.0) : 0.0;
  float meanR = (vRadii.x + vRadii.y + vRadii.z) / 3.0;
  float trans = exp(-depth / (meanR * 0.55));
  // Multiple scattering keeps the shadowed side from going black
  float sunLight = trans * 0.85 + 0.08;
  sunLight *= clamp(dot(N, L) * 0.5 + 0.6, 0.0, 1.0);

  // Thickness along the VIEW ray through the whole cloud: thin near the
  // cloud's silhouette, thick through the middle
  vec3 o = (cameraPosition - vCenter) / vRadii;
  vec3 dv = V / vRadii;
  float av = dot(dv, dv), bv = dot(o, dv), cv = dot(o, o) - 1.0;
  float dvd = bv * bv - av * cv;
  float viewDepth = 0.0;
  if (dvd > 0.0) {
    float sq = sqrt(dvd);
    viewDepth = max((-bv + sq) / av - max((-bv - sq) / av, 0.0), 0.0);
  }
  float thin = exp(-viewDepth / (meanR * 0.5));

  float h = clamp(q.y * 0.5 + 0.5, 0.0, 1.0); // 0 = base, 1 = top
  vec3 ambient = mix(uShadowColor, uSkyColor, clamp(h * 0.8 + N.y * 0.3, 0.0, 1.0));

  float cosVL = max(dot(V, L), 0.0);
  float phase = 0.75 + 1.4 * pow(cosVL, 6.0); // forward-scattering phase
  vec3 col = ambient * 0.8 + uLitColor * sunLight * phase;

  // Silver lining: light shining through the thin outer parts of the cloud
  col += uLitColor * pow(cosVL, 8.0) * thin * 3.0;

  // The outer, thin parts of the cloud are also more see-through
  alpha *= mix(1.0, 0.55, thin);

  gl_FragColor = vec4(col, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
