import { CONFIG } from '../config.js';

/**
 * ADAPTIVE RESOLUTION ("dynamic resolution scaling").
 *
 * Most of the GPU's work is per pixel (lighting, water, bloom), so render time
 * is roughly proportional to the number of pixels, i.e. to pixelRatio².
 * Once per second we measure the frame rate; if it is below the target, the
 * pixel ratio is scaled by sqrt(fps / target), which should bring the frame
 * rate close to the target in one step. When there is spare headroom, the
 * resolution creeps back up slowly. The HUD shows the current scale.
 */
export class ResolutionGovernor {
  constructor(postfx) {
    this.postfx = postfx;
    this.max = Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio);
    this.min = Math.min(0.55, this.max);
    // Start a little below the maximum on high-DPI screens
    this.scale = Math.min(this.max, 1.0);
    this.postfx.setPixelRatio(this.scale);
    this.target = 57;
    this.frames = 0;
    this.time = 0;
    this.goodWindows = 0;
    this.warmup = 3; // seconds to ignore while shaders compile on start
  }

  update(dt) {
    if (this.warmup > 0) {
      this.warmup -= dt;
      return;
    }
    if (dt > 0.25) return; // ignore one-off hitches (tab switch, route loading)
    this.frames++;
    this.time += dt;
    if (this.time < 1) return;

    const fps = this.frames / this.time;
    this.frames = 0;
    this.time = 0;

    let next = this.scale;
    if (fps < this.target - 5) {
      next = this.scale * Math.max(0.75, Math.sqrt(fps / this.target));
      this.goodWindows = 0;
    } else if (fps > this.target) {
      // Only increase after 3 good seconds in a row, in small steps (avoids oscillating)
      if (++this.goodWindows >= 3) {
        next = this.scale + 0.05;
        this.goodWindows = 0;
      }
    }
    next = Math.min(this.max, Math.max(this.min, next));
    if (Math.abs(next - this.scale) > 0.02) {
      this.scale = next;
      this.postfx.setPixelRatio(next);
    }
  }
}
