import { Vector3, Quaternion, Euler } from 'three';
import { CONFIG } from '../config.js';
import { clamp, damp, smoothstep } from '../utils/math.js';

/**
 * Arcade flight model.
 *
 * STATE
 *   position    Vector3     world position (metres)
 *   velocity    Vector3     world velocity (m/s)
 *   quaternion  Quaternion  orientation
 *   throttle    0..1
 *
 * WHY A QUATERNION?
 *   Euler angles (pitch/yaw/roll) suffer from gimbal lock: at 90° pitch two
 *   axes line up and one degree of freedom is lost, so a loop would glitch.
 *   A unit quaternion represents any orientation without singularities and is
 *   cheap to combine (multiply) and to interpolate (slerp).
 *
 * BODY AXES (the aircraft model is built to match these)
 *   forward = -Z (nose)    up = +Y    right = +X
 *   pitch = rotation about local X, yaw = local Y, roll = local Z.
 *
 * FORCES (evaluated each step in the body frame)
 *   thrust   along forward, proportional to throttle
 *   drag     opposes forward speed, proportional to speed^2
 *   lift     along body-up, proportional to speed^2. At cruise speed it
 *            exactly cancels gravity, so when slow the plane sinks.
 *   gravity  world -Y
 *   damping  of sideways / vertical body velocity: this is the arcade
 *            simplification of the aerodynamic forces that keep a real
 *            plane flying "in the direction it points".
 *
 * Because lift is along the plane's own up-vector, rolling tilts the lift
 * sideways and the velocity curves: the plane banks into turns naturally.
 */

const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _dir = new Vector3();
const _axis = new Vector3();
const _dq = new Quaternion();
const _qIdentity = new Quaternion();
const WORLD_UP = new Vector3(0, 1, 0);
const _euler = new Euler(0, 0, 0, 'YXZ');

export class FlightModel {
  constructor() {
    this.position = new Vector3();
    this.velocity = new Vector3();
    this.quaternion = new Quaternion();
    this.throttle = 0.6;
    this.gearDown = true;
    this.boostEnergy = 1; // 0..1, drains while boosting, refills otherwise
    this.boosting = false;
    this.gLoad = 1; // felt acceleration in g (for vapour trails / camera shake)
    this.grounded = false; // true while rolling on a runway after touchdown
    this.groundPitch = 0;

    // Body angular velocity (rad/s): x = pitch, y = yaw, z = roll
    this.angularVelocity = new Vector3();
    // Smoothed control inputs, used to animate the control surfaces
    this.surfaces = { pitch: 0, roll: 0, yaw: 0 };

    // Derived values for HUD / camera / audio
    this.speed = 0;
    this.outOfBounds = false;
  }

  /** Place the aircraft at a spawn point, flying forward at `speed` m/s. */
  reset(position, quaternion, speed = 40) {
    this.position.copy(position);
    this.quaternion.copy(quaternion).normalize();
    this.velocity.set(0, 0, -1).applyQuaternion(this.quaternion).multiplyScalar(speed);
    this.angularVelocity.set(0, 0, 0);
    this.boostEnergy = 1;
    this.boosting = false;
    this.grounded = false;
    this.surfaces.pitch = this.surfaces.roll = this.surfaces.yaw = 0;
    this.speed = speed;
  }

  /** Unit vectors of the body frame in world space. */
  getAxes(fwd = _fwd, up = _up, right = _right) {
    fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    up.set(0, 1, 0).applyQuaternion(this.quaternion);
    right.set(1, 0, 0).applyQuaternion(this.quaternion);
    return { fwd, up, right };
  }

  /** Attitude angles for the HUD (degrees). */
  getAttitude() {
    const { fwd, up, right } = this.getAxes();
    return {
      pitch: Math.asin(clamp(fwd.y, -1, 1)) * (180 / Math.PI),
      bank: Math.atan2(-right.y, up.y) * (180 / Math.PI), // + = right wing down
      heading: ((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI + 360) % 360, // 0 = -Z
    };
  }

  /**
   * Advance the simulation.
   * @param {number} dt   seconds (kept small by the caller via sub-stepping)
   * @param {object} input  { pitch, roll, yaw, throttle } in [-1, 1], boost (bool)
   * @param {object} world  { bounds: { x, z, radius, ceiling } }
   */
  update(dt, input, world) {
    const F = CONFIG.flight;
    const g = F.gravity;

    // ---------------- Throttle ----------------
    this.throttle = clamp(this.throttle + input.throttle * F.throttleRate * dt, 0, 1);

    // ---------------- Boost (energy drains while used, then recharges) ----------------
    const B = CONFIG.boost;
    this.boosting = !!input.boost && this.boostEnergy > 0;
    if (this.boosting) this.boostEnergy = Math.max(0, this.boostEnergy - dt / B.duration);
    else if (!input.boost) this.boostEnergy = Math.min(1, this.boostEnergy + dt / B.recharge);

    // Smoothed inputs drive the control-surface animation
    const s = damp(10, dt);
    this.surfaces.pitch += (input.pitch - this.surfaces.pitch) * s;
    this.surfaces.roll += (input.roll - this.surfaces.roll) * s;
    this.surfaces.yaw += (input.yaw - this.surfaces.yaw) * s;

    let { fwd, up, right } = this.getAxes();
    const forwardSpeed = this.velocity.dot(fwd);

    // ---------------- Rotation (control input) ----------------
    // Control surfaces need airflow: authority grows with speed.
    const authority = clamp(forwardSpeed / 28, 0.25, 1.2);
    let targetRoll = -input.roll * F.rollRate; // roll right = negative rotation about +Z
    if (Math.abs(input.roll) < 0.05 && up.y > 0) {
      targetRoll -= right.y * F.autoLevel; // gentle wings-level assist
    }
    const tx = input.pitch * F.pitchRate * authority;
    const ty = -input.yaw * F.yawRate * authority;
    const tz = targetRoll * authority;

    const r = damp(F.rateResponse, dt);
    const w = this.angularVelocity;
    w.x += (tx - w.x) * r;
    w.y += (ty - w.y) * r;
    w.z += (tz - w.z) * r;

    // Integrate angular velocity: q = q * dq, where dq is a small rotation
    // about the body-space axis. Post-multiplying applies it in LOCAL space.
    const angle = w.length() * dt;
    if (angle > 1e-6) {
      _axis.copy(w).normalize();
      _dq.setFromAxisAngle(_axis, angle);
      this.quaternion.multiply(_dq).normalize();
    }

    // ---------------- Soft world boundary ----------------
    // Outside the play radius, gently yaw the aircraft back toward the centre.
    // Pre-multiplying applies the rotation in WORLD space (about world Y).
    this.outOfBounds = false;
    const b = world.bounds;
    if (b) {
      const dx = this.position.x - b.x;
      const dz = this.position.z - b.z;
      const dist = Math.hypot(dx, dz);
      if (dist > b.radius) {
        this.outOfBounds = true;
        const over = clamp((dist - b.radius) / 250, 0, 1);
        ({ fwd } = this.getAxes());
        const hx = fwd.x, hz = fwd.z;
        const tdx = -dx / dist, tdz = -dz / dist;
        const err = Math.atan2(hz * tdx - hx * tdz, hx * tdx + hz * tdz);
        this.rotateWorld(WORLD_UP, clamp(err, -1, 1) * 0.9 * over * dt);
      }
      if (this.position.y > b.ceiling) {
        this.outOfBounds = true;
        const over = clamp((this.position.y - b.ceiling) / 100, 0, 1);
        ({ fwd, right } = this.getAxes());
        if (fwd.y > -0.3) this.rotateWorld(right, -0.6 * over * dt);
      }
    }

    // ---------------- Weathervane stability ----------------
    // The nose slowly turns to follow the velocity vector (like a dart).
    // When slow, the velocity points downward, so the nose drops gently and
    // the plane regains speed. This replaces stalls and spins.
    const speed = this.velocity.length();
    if (speed > 3) {
      ({ fwd } = this.getAxes());
      _dir.copy(this.velocity).divideScalar(speed);
      _dq.setFromUnitVectors(fwd, _dir);
      _qIdentity.identity().slerp(_dq, clamp(F.weathervane * dt, 0, 1));
      this.quaternion.premultiply(_qIdentity).normalize();
    }

    // ---------------- Forces (body frame) ----------------
    ({ fwd, up, right } = this.getAxes());
    let vf = this.velocity.dot(fwd);
    let vu = this.velocity.dot(up);
    let vr = this.velocity.dot(right);

    // Lift ~ speed^2 below cruise speed (so a slow plane sinks), capped at 1 g
    // above it: extra speed does NOT make the plane balloon upward on its own
    // (arcade simplification: the pilot climbs by pulling, not by speeding up).
    // Manoeuvring force comes from the angle-of-attack damping term below.
    // When banked, add a little extra so moderate turns hold altitude
    // (an arcade "auto back-pressure" assist).
    const sf = Math.min(Math.max(vf, 0) / F.cruiseSpeed, 1);
    const bankComp = 1 + (1 / Math.max(up.y, 0.6) - 1) * smoothstep(0, 0.6, up.y);
    const lift = Math.min(g * sf * sf * bankComp, F.maxLiftG * g);

    const drag = F.drag * (this.gearDown ? 1.25 : 1); // extended gear adds drag
    // While boosting, the engine behaves as if at full throttle x boost multiplier
    const thrust = this.boosting ? F.maxThrust * B.thrustMultiplier : this.throttle * F.maxThrust;

    // Each axis: sum of forces + the gravity component along that axis
    const af = thrust - drag * vf * Math.abs(vf) - g * fwd.y;
    const au = lift - g * up.y - F.normalDamping * vu;
    const ar = -g * right.y - F.sideDamping * vr;

    vf += af * dt;
    vu += au * dt;
    vr += ar * dt;
    // Load factor felt by the pilot: normal acceleration / g (1 = level flight)
    this.gLoad += ((lift - F.normalDamping * vu) / g - this.gLoad) * damp(8, dt);

    this.velocity
      .copy(fwd).multiplyScalar(vf)
      .addScaledVector(up, vu)
      .addScaledVector(right, vr);

    // ---------------- Translation ----------------
    this.position.addScaledVector(this.velocity, dt);
    this.speed = this.velocity.length();
  }

  // ------------------------------------------------------------ ground --

  /** Switch to ground-roll mode after a successful touchdown. */
  setGrounded(groundY, clearance) {
    this.grounded = true;
    const { pitch } = this.getAttitude();
    this.groundPitch = Math.min(Math.max((pitch * Math.PI) / 180, 0), 0.15);
    this.position.y = groundY + clearance;
    this.velocity.y = 0;
    this.angularVelocity.set(0, 0, 0);
  }

  /**
   * Ground roll: the aircraft is constrained to the runway surface.
   *  - Orientation is rebuilt from heading + a small pitch (Euler 'YXZ':
   *    yaw first, then pitch), wings level.
   *  - Steering (nose-wheel) turns the heading; it works better with speed.
   *  - Rolling friction always; brakes when the throttle is near idle.
   *  - Pull up above take-off speed to lift off again (touch-and-go).
   */
  updateGround(dt, input, groundY, clearance) {
    const F = CONFIG.flight;
    this.throttle = clamp(this.throttle + input.throttle * F.throttleRate * dt, 0, 1);
    const s = damp(10, dt);
    this.surfaces.pitch += (input.pitch - this.surfaces.pitch) * s;
    this.surfaces.roll += (input.roll - this.surfaces.roll) * s;
    this.surfaces.yaw += (input.yaw - this.surfaces.yaw) * s;
    this.boosting = false;
    this.gLoad = 1;

    const { fwd } = this.getAxes();
    let heading = Math.atan2(fwd.x, -fwd.z);
    let speed = Math.max(0, this.velocity.x * fwd.x + this.velocity.z * fwd.z);

    // Nose-wheel steering
    heading += (input.yaw * 0.45 + input.roll * 0.2) * Math.min(1, speed / 8) * dt;

    // Rotation for take-off, otherwise lower the nose wheel
    const rotate = input.pitch > 0.3 && speed > 33;
    this.groundPitch += ((rotate ? 0.16 : 0) - this.groundPitch) * damp(2.5, dt);

    const thrust = this.throttle * F.maxThrust;
    const brakes = this.throttle < 0.12 ? 3.5 : 0;
    speed += (thrust - F.drag * speed * speed - 0.3 - brakes) * dt;
    speed = Math.max(0, speed);

    _euler.set(this.groundPitch, -heading, 0);
    this.quaternion.setFromEuler(_euler);
    this.getAxes();
    this.velocity.set(_fwd.x, 0, _fwd.z).normalize().multiplyScalar(speed);
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = groundY + clearance;
    this.speed = speed;

    // Lift-off
    if (rotate && speed > 37 && this.groundPitch > 0.1) {
      this.grounded = false;
      this.velocity.y = 2.5;
      this.position.y += 0.2;
    }
  }

  /** Rotate both orientation and velocity about a WORLD axis. */
  rotateWorld(axis, angle) {
    _dq.setFromAxisAngle(axis, angle);
    this.quaternion.premultiply(_dq).normalize();
    this.velocity.applyQuaternion(_dq);
  }
}
