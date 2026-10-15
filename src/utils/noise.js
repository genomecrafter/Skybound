import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from './math.js';

/**
 * Procedural noise helpers used to generate terrain heights.
 *
 * Simplex noise gives smooth pseudo-random values in [-1, 1].
 * Fractal Brownian Motion (fBm) adds several "octaves" of noise together:
 * each octave has double the frequency (lacunarity) and half the amplitude
 * (gain), giving large hills with progressively smaller bumps on top -
 * the classic look of natural terrain.
 */
export function createNoise(seed = 1) {
  const noise2D = createNoise2D(mulberry32(seed));

  /** Fractal Brownian Motion: sum of octaves. Output roughly in [-1, 1]. */
  function fbm(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise2D(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Ridged noise: 1 - |noise| creates sharp crests where the noise crosses 0.
   * Great for mountain ridges and canyon walls. Output in [0, 1].
   */
  function ridged(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(noise2D(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  return { noise2D, fbm, ridged };
}
