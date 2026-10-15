import { Vector3 } from 'three';
import { clamp, mulberry32 } from '../utils/math.js';

/**
 * Wind and turbulence for the flight simulator.
 *
 * STEADY WIND is given the way pilots read it in a weather report: the
 * direction it blows FROM (degrees, 0 = north = -Z, 90 = east = +X) and its
 * speed. Its velocity vector therefore points the opposite way.
 *
 * BOUNDARY LAYER: friction with the ground slows the wind near the surface.
 * Speed grows with the logarithm of height (the "log wind profile"), so on
 * final approach the headwind dies away in the last few metres.
 *
 * TURBULENCE: each axis is an ORNSTEIN-UHLENBECK random process, which is
 * random noise passed through a first-order low-pass filter:
 *     u += -u / tau * dt + sigma * sqrt(2 dt / tau) * N(0,1)
 * Its time constant tau = L / V comes from the size of the eddies L and the
 * airspeed V (flying faster crosses eddies more quickly). This is the same
 * idea as the Dryden turbulence model used in professional simulators.
 * Gusts are a slower process that scales the steady wind up and down.
 */
export class Wind {
  constructor({ from = 0, speed = 0, gust = 0, turbulence = 0, seed = 1 } = {}) {
    this.rand = mulberry32(seed);
    this.set({ from, speed, gust, turbulence });
    this.turb = new Vector3();
    this.gustState = 0;
    this.current = new Vector3(); // wind at the aircraft, updated by sample()
    this._spare = null;
  }

  set({ from = 0, speed = 0, gust = 0, turbulence = 0 }) {
    this.from = from;
    this.speed = speed;
    this.gust = gust; // extra gust speed (m/s) on top of the steady wind
    this.turbulence = turbulence; // rms of the random eddies (m/s)
    const a = (from * Math.PI) / 180;
    // Blowing FROM `from`, so the air moves toward from + 180°
    this.dir = new Vector3(-Math.sin(a), 0, Math.cos(a));
  }

  /** Standard normal random number (Box-Muller transform). */
  gauss() {
    if (this._spare !== null) {
      const s = this._spare;
      this._spare = null;
      return s;
    }
    const u = Math.max(this.rand(), 1e-9), v = this.rand();
    const r = Math.sqrt(-2 * Math.log(u));
    this._spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** Advance the random processes (call once per physics step). */
  step(dt, airspeed, agl) {
    // Eddies are smaller near the ground (more choppy close to the surface)
    const L = clamp(40 + agl * 0.8, 40, 300);
    const tau = L / Math.max(airspeed, 10);
    const s = Math.sqrt((2 * dt) / tau);
    const t = this.turb;
    t.x += -t.x / tau * dt + this.turbulence * s * this.gauss();
    t.y += -t.y / tau * dt + this.turbulence * 0.6 * s * this.gauss();
    t.z += -t.z / tau * dt + this.turbulence * s * this.gauss();
    // Gust factor: slow process (about 6 s), kept positive (gusts add to the wind)
    const gt = 6;
    this.gustState += -this.gustState / gt * dt + Math.sqrt((2 * dt) / gt) * this.gauss();
  }

  /**
   * Wind velocity at a height above the ground (world m/s), written to `out`.
   * @param {number} agl  height above ground level (m)
   */
  sample(agl, out = this.current) {
    // Log profile, normalised to 1 at 150 m, surface roughness 0.15 m
    const h = Math.max(agl, 0.5);
    const profile = clamp(Math.log(h / 0.15) / Math.log(150 / 0.15), 0.3, 1.15);
    const gust = this.gust * clamp(Math.abs(this.gustState), 0, 1.6);
    const speed = (this.speed + gust) * profile;
    out.copy(this.dir).multiplyScalar(speed);
    // Turbulence also weakens right at the ground (vertical gusts can't go through it)
    const tk = clamp(h / 20, 0.25, 1);
    out.x += this.turb.x * tk;
    out.y += this.turb.y * tk * clamp(h / 40, 0, 1);
    out.z += this.turb.z * tk;
    return out;
  }

  /** "270° / 12 kt G18" style text for the HUD. */
  describe() {
    if (this.speed < 0.5 && this.gust < 0.5) return 'CALM';
    const kt = (v) => Math.round(v * 1.944);
    const dir = String(Math.round(((this.from % 360) + 360) % 360) || 360).padStart(3, '0');
    return `${dir}° / ${kt(this.speed)} kt${this.gust > 0.5 ? ` G${kt(this.speed + this.gust)}` : ''}`;
  }
}
