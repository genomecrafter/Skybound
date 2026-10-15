/**
 * Small maths helpers shared across modules.
 */

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Frame-rate independent smoothing factor.
 * Using `x += (target - x) * damp(k, dt)` converges at the same speed whether
 * the game runs at 30 fps or 144 fps (exponential decay: 1 - e^(-k*dt)).
 */
export const damp = (k, dt) => 1 - Math.exp(-k * dt);

export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Seeded pseudo-random generator (mulberry32).
 * Same seed => same terrain / same tree placement every run, which keeps the
 * hand-crafted routes stable.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
