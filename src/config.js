/**
 * Global tuning constants. Kept in one place so they are easy to tweak
 * during testing (and easy to point at during the viva).
 */
export const CONFIG = {
  // ---- Controls ----
  // false: Up arrow / W = nose UP (climb). true: flight-sim style (Up = nose down).
  invertPitch: false,
  keyResponse: 5, // how fast keyboard inputs ramp to full deflection (1/s) - smooths digital keys
  mouseLookSensitivity: 0.003, // free-look radians per pixel of mouse movement
  lookReturnDelay: 1.0, // seconds of mouse stillness before the camera swings back behind
  wheelThrottleStep: 0.05, // throttle change per mouse-wheel notch

  // ---- Boost (hold left mouse button) ----
  boost: {
    thrustMultiplier: 1.9,
    duration: 4, // seconds of continuous boost from full
    recharge: 10, // seconds to refill from empty
  },

  // ---- Renderer / graphics ----
  // Open the app with ?quality=low on slow laptops (no post-processing, fewer clouds)
  quality: new URLSearchParams(location.search).get('quality') === 'low' ? 'low' : 'high',
  maxPixelRatio: 1.5, // cap for high-DPI laptops; the biggest single fps saver
  shadowMapSize: 2048,
  bloom: { strength: 0.45, radius: 0.45, threshold: 1.0 }, // only HDR values > 1 glow

  // ---- Flight model (SI-ish units: metres, seconds) ----
  flight: {
    gravity: 9.81,
    maxThrust: 16, // m/s^2 at full throttle
    drag: 0.0025, // quadratic drag coefficient -> top speed = sqrt(maxThrust/drag) = 80 m/s
    cruiseSpeed: 42, // speed at which lift exactly balances gravity in level flight
    maxLiftG: 2.6, // lift limit, in multiples of g
    pitchRate: 1.3, // rad/s at full input
    rollRate: 2.4,
    yawRate: 0.55,
    rateResponse: 6, // how quickly angular rates reach their target (1/s)
    autoLevel: 0.9, // gentle wing-levelling when no roll input (arcade assist)
    normalDamping: 2.5, // kills velocity along body "up"   -> lift/AoA behaviour
    sideDamping: 3.0, // kills sideways velocity           -> no sliding
    weathervane: 3.0, // nose turns to follow the velocity vector (1/s)
    throttleRate: 0.5, // throttle change per second while holding the key
  },

  // ---- Chase camera ----
  camera: {
    fovMin: 62,
    fovMax: 82,
    distance: 13,
    height: 3.2,
    followSharpness: 4, // higher = less lag
    bankFollow: 0.3, // 0 = camera never rolls, 1 = camera rolls fully with the plane
  },
};
