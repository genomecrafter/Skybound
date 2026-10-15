import * as THREE from 'three';
import { createNoise4D } from 'simplex-noise';
import { mulberry32 } from '../utils/math.js';

/**
 * Tileable procedural noise textures for terrain surface detail.
 *
 * To tile seamlessly, the 2D texture coordinate (u, v) is mapped onto a
 * TORUS in 4D:  (cos 2πu, sin 2πu, cos 2πv, sin 2πv) * r
 * and 4D simplex noise is sampled there. Because cos/sin wrap around, the
 * left edge matches the right edge and the top matches the bottom exactly.
 *
 * Two textures are produced:
 *   colorDetail  grey ~0.75..1.0: multiplies the vertex colours (grain, patches)
 *   bump         grey height field used as a bump map: perturbs the shading
 *                normal per pixel, so slopes catch light like real rough ground
 */
let cache = null;

function makeTileable(size, octaves, freq, seed, map) {
  const noise4D = createNoise4D(mulberry32(seed));
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const TAU = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let sum = 0, amp = 1, norm = 0, f = freq;
      for (let o = 0; o < octaves; o++) {
        sum += amp * noise4D(Math.cos(TAU * u) * f, Math.sin(TAU * u) * f, Math.cos(TAU * v) * f, Math.sin(TAU * v) * f);
        norm += amp;
        amp *= 0.5;
        f *= 2;
      }
      const n = map(sum / norm); // -> 0..1
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, n * 255));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function getTerrainDetail() {
  if (cache) return cache;
  const colorDetail = makeTileable(256, 5, 0.9, 11, (n) => 0.82 + n * 0.18);
  colorDetail.colorSpace = THREE.SRGBColorSpace;
  const bump = makeTileable(256, 5, 1.6, 23, (n) => 0.5 + n * 0.5);
  bump.colorSpace = THREE.NoColorSpace;
  bump.channel = 1; // sample with the second (finer) UV set, uv1
  cache = { colorDetail, bump };
  return cache;
}
