import { CONFIG } from '../config.js';
import { clamp, damp } from '../utils/math.js';

/**
 * Keyboard + mouse input.
 *
 * FLYING (keyboard)
 *   ↑ / W   nose up (climb)        ↓ / S   nose down (dive)
 *   ← / A   bank & turn left       → / D   bank & turn right
 *   Q / E   rudder (fine yaw)      Shift / Ctrl   throttle (keyboard alternative)
 *   ←/→ also add a little rudder automatically ("coordinated turn"), so turning
 *   needs only one key.
 *
 * MOUSE
 *   move      free-look: orbit the camera around the plane (springs back)
 *   wheel     throttle up / down
 *   left btn  hold for boost
 *   right btn toggle landing gear
 *
 * Produces axes in [-1, 1]:  pitch +1 = nose up, roll +1 = right, yaw +1 = right.
 * Mouse movement comes from the Pointer Lock API (raw deltas, hidden cursor).
 * We use `event.code` (physical key) so the layout of the keyboard doesn't matter.
 *
 * SIMULATOR MODE adds
 *   Space / B hold = wheel brakes     [ / ] = elevator trim (nose down / up)
 *   MOUSE YOKE (Y toggles): the mouse moves the control column like a real
 *   yoke (forward = push = nose down) instead of looking around.
 *   Keyboard axes ramp more slowly in the simulator, so a tap is a small
 *   correction and holding the key builds up to full deflection.
 * GAMEPAD (Gamepad API, "standard" layout, both modes): left stick = ailerons
 *   + elevator, right stick X = rudder, RT / LT = throttle up / down,
 *   X = brakes, A / B = flaps down / up, Y = gear, D-pad = trim, View = camera.
 */
const FLIGHT_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Space',
  'KeyB', 'KeyF', 'KeyV', 'KeyP', 'KeyY', 'KeyH', 'BracketLeft', 'BracketRight',
]);
// Gamepad buttons (standard mapping) that act like a key press
const PAD_PRESS = { 0: 'KeyF', 1: 'KeyV', 3: 'KeyG', 8: 'KeyC' };

/** Stick dead-zone + gentle expo curve (finer control near the centre). */
const stick = (v) => {
  const d = 0.08;
  if (Math.abs(v) < d) return 0;
  const x = (Math.abs(v) - d) / (1 - d);
  return Math.sign(v) * (0.35 * x + 0.65 * x * x * x);
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pointerLocked = false;
    this.listeners = new Set(); // one-shot key/button press subscribers
    this.capture = false; // true while flying: swallow browser shortcuts on flight keys

    // Free-look angles (radians), driven by the mouse and eased back to 0
    this.look = { yaw: 0, pitch: 0 };
    this.lookIdle = 0; // seconds since the mouse last moved
    this.wheelSteps = 0; // accumulated wheel notches, consumed each frame
    this.boost = false;

    // Simulator extras
    this.simMode = false;
    this.yokeEnabled = false; // mouse yoke (simulator)
    this.yoke = { x: 0, y: 0 }; // mouse-yoke position, -1..1
    this.brake = 0;
    this.trimRate = 0; // -1 nose down .. +1 nose up while a trim key is held
    this.padConnected = false;
    this.padPrev = [];
    this.keyAxes = { pitch: 0, roll: 0, yaw: 0 };

    // Output axes, recomputed every frame by update()
    this.pitch = 0;
    this.roll = 0;
    this.yaw = 0;
    this.throttle = 0;

    window.addEventListener('keydown', (e) => {
      // Only while flying, so Ctrl+R etc. still work in menus.
      if (this.capture && FLIGHT_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.listeners.forEach((fn) => fn(e.code));
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // Releasing keys when the window loses focus avoids "stuck" controls.
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.boost = false;
    });

    this.lockPending = false; // a pointer-lock request is in flight
    document.addEventListener('pointerlockerror', () => {
      this.lockPending = false;
      this.onLockError?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.lockPending = false;
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) this.boost = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      if (this.simMode && this.yokeEnabled) {
        // Mouse yoke: moving the mouse away from you pushes the nose down
        const k = 0.0022;
        this.yoke.x = clamp(this.yoke.x + e.movementX * k, -1, 1);
        this.yoke.y = clamp(this.yoke.y + e.movementY * k, -1, 1);
        return;
      }
      const s = CONFIG.mouseLookSensitivity;
      this.look.yaw = clamp(this.look.yaw - e.movementX * s, -Math.PI * 0.95, Math.PI * 0.95);
      this.look.pitch = clamp(this.look.pitch - e.movementY * s, -0.6, 1.0);
      this.lookIdle = 0;
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.pointerLocked) return;
      if (e.button === 0 && !this.simMode) this.boost = true;
      // Simulator: middle click re-centres the mouse yoke
      if (e.button === 1 && this.simMode) this.yoke.x = this.yoke.y = 0;
      if (e.button === 2) this.listeners.forEach((fn) => fn('MouseRight'));
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.boost = false;
    });
    window.addEventListener('contextmenu', (e) => {
      if (this.capture) e.preventDefault();
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.pointerLocked) return;
        e.preventDefault();
        this.wheelSteps += e.deltaY < 0 ? 1 : -1; // wheel up = more throttle
      },
      { passive: false },
    );
  }

  requestPointerLock() {
    // Asynchronous: the result arrives as a pointerlockchange / pointerlockerror
    // event. (Browsers refuse re-locking within ~1 s of the user pressing Esc.)
    if (this.pointerLocked) return;
    this.lockPending = true;
    const p = this.canvas.requestPointerLock?.();
    if (p && p.catch) {
      p.catch(() => {
        this.lockPending = false;
        this.onLockError?.();
      });
    }
  }

  /** Subscribe to single presses (keys by event.code, plus 'MouseRight'). Returns unsubscribe fn. */
  onPress(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  isDown(code) {
    return this.keys.has(code);
  }

  /** Throttle change requested by the mouse wheel since the last call. */
  consumeWheel() {
    const s = this.wheelSteps;
    this.wheelSteps = 0;
    return s * CONFIG.wheelThrottleStep;
  }

  /** Re-centre the controls (new flight). */
  resetAxes() {
    this.pitch = this.roll = this.yaw = 0;
    this.keyAxes.pitch = this.keyAxes.roll = this.keyAxes.yaw = 0;
    this.yoke.x = this.yoke.y = 0;
  }

  /**
   * Read the first connected gamepad. Returns its shaped axes and fires
   * press events for the mapped buttons (on the frame they go down).
   */
  pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    let pad = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
    this.padConnected = !!pad;
    if (!pad) return null;
    const btn = (i) => pad.buttons[i]?.value ?? 0;
    for (const [i, code] of Object.entries(PAD_PRESS)) {
      const down = btn(i) > 0.5;
      if (down && !this.padPrev[i]) this.listeners.forEach((fn) => fn(code));
      this.padPrev[i] = down;
    }
    return {
      roll: stick(pad.axes[0] ?? 0),
      pitch: stick(pad.axes[1] ?? 0), // stick back (+1) = nose up
      yaw: clamp(stick(pad.axes[2] ?? 0) + btn(5) - btn(4), -1, 1),
      throttle: btn(7) - btn(6),
      brake: btn(2),
      trim: btn(13) - btn(12),
    };
  }

  update(dt) {
    const k = (code) => (this.keys.has(code) ? 1 : 0);
    const pad = this.pollGamepad();

    // Free-look eases back behind the plane once the mouse is still
    this.lookIdle += dt;
    if (this.lookIdle > CONFIG.lookReturnDelay) {
      const c = damp(2.5, dt);
      this.look.yaw -= this.look.yaw * c;
      this.look.pitch -= this.look.pitch * c;
    }

    let pitch = Math.max(k('ArrowUp'), k('KeyW')) - Math.max(k('ArrowDown'), k('KeyS'));
    if (CONFIG.invertPitch) pitch = -pitch;
    const roll = Math.max(k('ArrowRight'), k('KeyD')) - Math.max(k('ArrowLeft'), k('KeyA'));
    const rudder = k('KeyE') - k('KeyQ');

    if (this.simMode) {
      this.updateSim(dt, pitch, roll, rudder, pad, k);
      return;
    }

    // Keys are on/off; ramp the axes smoothly so taps give gentle corrections
    const r = damp(CONFIG.keyResponse, dt);
    this.pitch += (pitch - this.pitch) * r;
    this.roll += (roll - this.roll) * r;
    // Auto-coordination: a little rudder in the direction of the bank
    this.yaw += (clamp(rudder + roll * 0.35, -1, 1) - this.yaw) * r;

    if (pad) {
      this.pitch = clamp(this.pitch + pad.pitch, -1, 1);
      this.roll = clamp(this.roll + pad.roll, -1, 1);
      this.yaw = clamp(this.yaw + pad.yaw, -1, 1);
    }

    const up = k('ShiftLeft') || k('ShiftRight');
    const down = k('ControlLeft') || k('ControlRight');
    this.throttle = clamp(up - down + (pad?.throttle ?? 0), -1, 1);
  }

  /**
   * Simulator axes: keys move the control at a limited rate (and centre
   * again when released); the mouse yoke and the gamepad add analogue input.
   */
  updateSim(dt, pitch, roll, rudder, pad, k) {
    const ka = this.keyAxes;
    const ramp = (v, target) => {
      // Slow build-up, quicker return to centre or reversal
      const rate = target === 0 ? 3.5 : v * target < 0 ? 4 : 1.8;
      return v + clamp(target - v, -rate * dt, rate * dt);
    };
    ka.pitch = ramp(ka.pitch, pitch);
    ka.roll = ramp(ka.roll, roll);
    ka.yaw = ramp(ka.yaw, rudder);
    const yokeP = this.yokeEnabled ? this.yoke.y : 0;
    const yokeR = this.yokeEnabled ? this.yoke.x : 0;
    this.pitch = clamp(ka.pitch + yokeP + (pad?.pitch ?? 0), -1, 1);
    this.roll = clamp(ka.roll + yokeR + (pad?.roll ?? 0), -1, 1);
    this.yaw = clamp(ka.yaw + (pad?.yaw ?? 0), -1, 1);

    const up = k('ShiftLeft') || k('ShiftRight');
    const down = k('ControlLeft') || k('ControlRight');
    this.throttle = clamp(up - down + (pad?.throttle ?? 0), -1, 1);
    this.brake = Math.max(k('Space'), k('KeyB'), pad?.brake ?? 0);
    this.trimRate = clamp(k('BracketRight') - k('BracketLeft') + (pad?.trim ?? 0), -1, 1);
  }
}
