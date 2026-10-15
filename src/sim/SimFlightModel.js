import { Vector3, Quaternion } from 'three';
import { FlightModel } from '../aircraft/FlightModel.js';
import { clamp, damp, lerp, smoothstep } from '../utils/math.js';

/**
 * REALISTIC FLIGHT MODEL (simulator mode): a 6-degree-of-freedom rigid body.
 *
 * Unlike the arcade model, nothing here "helps" the plane fly: it only
 * stays up because the wing makes lift, and it goes where the forces push it.
 *
 * STATE  centre-of-gravity position and velocity (world), orientation
 *        (quaternion) and angular velocity (body axes). `position` (the
 *        model's origin, used by the renderer and camera) is derived from it.
 *
 * AERODYNAMICS (coefficient build-up, as in real flight-dynamics models)
 *   The air-relative velocity (aircraft velocity minus WIND) is turned into
 *   body axes. From it we get the airspeed V, the ANGLE OF ATTACK alpha
 *   (angle between the wing and the oncoming air, in the vertical plane)
 *   and the SIDESLIP beta (same, sideways). Dynamic pressure q = ½ρV².
 *   Every force is   coefficient x q x wing area,
 *   every moment     coefficient x q x wing area x (chord or span).
 *
 *   LIFT CURVE: CL grows linearly with alpha (slope 2πA/(A+2) from the
 *   aspect ratio A), rounds off to CLmax and then the wing STALLS: the airflow
 *   separates, lift drops and drag rises sharply. Flaps add lift (and drag).
 *   Each wing half is computed separately with its own local alpha, which
 *   includes the roll rate: the wing going down meets the air at a higher
 *   angle. Below the stall that damps the roll; ABOVE the stall it does the
 *   opposite (the dropping wing stalls deeper and loses even more lift), so
 *   an uncoordinated stall drops a wing and can turn into a SPIN.
 *   Induced drag  CDi = CL² / (π e A)  is the cost of making lift; near the
 *   ground it is reduced (GROUND EFFECT), which makes the plane "float" in
 *   the flare.
 *
 *   STABILITY and DAMPING derivatives (dimensionless "stability derivatives"):
 *     Cm_alpha < 0   nose-down moment when alpha grows (pitch stability)
 *     Cm_q, Cn_r     damping of pitch and yaw rates
 *     Cn_beta > 0    weathercock: the fin turns the nose into the airflow
 *     Cl_beta < 0    dihedral effect: sideslip rolls the plane level
 *     Cn_da < 0      ADVERSE YAW: ailerons yaw the nose the wrong way, so a
 *                    coordinated turn needs some rudder (watch the ball)
 *   Controls: elevator, ailerons and rudder add moments proportional to
 *   their deflection. Elevator TRIM shifts the elevator's neutral point so
 *   the plane flies hands-off at a chosen speed.
 *
 * ENGINE + PROPELLER: thrust falls off with airspeed (a fixed-pitch prop
 *   gives most thrust when standing still). The prop's slipstream blows over
 *   the tail, so rudder and elevator still work at low speed with power on.
 *   Engine torque rolls the plane left and "P-factor" yaws it left at high
 *   power and low speed: on the take-off roll you need right rudder.
 *
 * LANDING GEAR: each wheel is a SPRING-DAMPER (Hooke's law + viscous
 *   damping) pushing up when it sinks into the ground, plus tyre friction:
 *   rolling resistance, brakes on the main wheels and a sideways grip force.
 *   The nose wheel steers with the rudder pedals. These forces also create
 *   torques about the CG, so the plane pitches, rotates for take-off and
 *   settles on its gear by itself.
 *
 * INTEGRATION: Newton's second law for translation (F = m a) and EULER'S
 *   EQUATIONS for rotation, I dω/dt = M - ω x (I ω), with a diagonal inertia
 *   tensor, stepped at 120 Hz (semi-implicit Euler).
 *
 * Axes (same as the rest of the game): body x = right, y = up, z = back
 * (nose = -z). Classic aeronautical rates are p = roll (right wing down +),
 * q = pitch (nose up +), r = yaw (nose right +); in our axes p = -ωz,
 * q = ωx, r = -ωy.
 */

const G = 9.81;
const RHO0 = 1.225;
const KT = 1.943844; // m/s -> knots

/** Aircraft data: a sporty 180 hp, 900 kg single-seater (similar to a Van's RV / Cessna 172 class). */
export const PLANE = {
  mass: 900,
  S: 13.5, // wing area (m²)
  b: 10.0, // span (m)
  c: 1.35, // mean chord (m)
  inertia: new Vector3(1650, 2600, 1150), // about body x (pitch), y (yaw), z (roll)  kg·m²
  cg: new Vector3(0, -0.15, -0.55), // centre of gravity in model coordinates
  // Lift
  CLa: 4.95, // lift-curve slope per radian
  aoaOffset: 0.07, // wing incidence + camber: lift is zero at body alpha = -0.07 rad
  CLmax: 1.45,
  flapCL: 0.1, // full flaps shift the zero-lift angle by this (≈ +0.5 CL)
  flapCLmax: 0.5,
  // Drag
  CD0: 0.026,
  gearCD: 0.01,
  flapCD: 0.045,
  e: 0.78, // Oswald efficiency
  // Pitch
  Cm0: -0.017, Cma: -0.9, Cmq: -12, Cmde: -1.1, flapCm: -0.03,
  // Roll / yaw / side
  Clb: -0.12, Clda: 0.16,
  Cnb: 0.08, Cnr: -0.14, Cnp: -0.03, Cnda: -0.012, Cndr: 0.06,
  CYb: -0.55, CYdr: -0.12,
  // Control throws (radians)
  maxElevator: 0.44, maxAileron: 0.35, maxRudder: 0.44, trimRange: 0.18,
  // Engine / propeller
  staticThrust: 3400, // N at full throttle, standing still
  propVmax: 95, // m/s where the fixed-pitch prop stops producing thrust
  enginePower: 134000, // W (180 hp)
  propRadius: 1.15,
  // Speeds (knots) for the airspeed indicator arcs and warnings
  vso: 45, vs1: 53, vfe: 85, vno: 125, vne: 160,
};

/** Landing-gear contact points (model coordinates) and their springs. */
const WHEELS = [
  { id: 'nose', p: new Vector3(0, -1.67, -2.1), k: 40000, c: 3200, steer: true, brake: false, r: 0.24 },
  { id: 'mainL', p: new Vector3(-1.5, -1.67, -0.2), k: 52000, c: 4200, steer: false, brake: true, r: 0.3 },
  { id: 'mainR', p: new Vector3(1.5, -1.67, -0.2), k: 52000, c: 4200, steer: false, brake: true, r: 0.3 },
];

/** Parts that must never touch the ground. */
const HARD_POINTS = [
  { p: new Vector3(0, -1.15, -2.95), reason: 'Propeller strike' },
  { p: new Vector3(0, -0.6, -1.4), reason: 'belly' },
  { p: new Vector3(0, -0.62, 0.3), reason: 'belly' },
  { p: new Vector3(0, 0.09, 4.5), reason: 'Tail strike' },
  { p: new Vector3(-5.0, -0.1, -0.3), reason: 'Wing tip hit the ground' },
  { p: new Vector3(5.0, -0.1, -0.3), reason: 'Wing tip hit the ground' },
  { p: new Vector3(0, 0.2, -3.3), reason: 'nose' },
];

// Scratch objects (no allocations inside the 120 Hz loop)
const _qInv = new Quaternion();
const _vb = new Vector3();
const _vhat = new Vector3();
const _liftDir = new Vector3();
const _F = new Vector3(); // body force
const _M = new Vector3(); // body moment
const _Fw = new Vector3(); // world force
const _tmp = new Vector3();
const _tmp2 = new Vector3();
const _r = new Vector3();
const _pw = new Vector3();
const _vp = new Vector3();
const _wWorld = new Vector3();
const _fdir = new Vector3();
const _sdir = new Vector3();
const _Iw = new Vector3();
const _dq = new Quaternion();
const _axis = new Vector3();
const X = new Vector3(1, 0, 0);
const UP = new Vector3(0, 1, 0);

/** ISA air density (kg/m³) at altitude h (m). */
export function airDensity(h) {
  return RHO0 * Math.pow(Math.max(1 - 2.2558e-5 * h, 0.2), 4.256);
}

/**
 * Lift coefficient of one wing half.
 * @param {number} a      angle of attack measured from zero lift (rad)
 * @param {number} clmax  maximum lift coefficient (higher with flaps)
 * @returns {number}
 */
function liftCoefficient(a, clmax) {
  const neg = a < 0;
  const x = Math.abs(a);
  const cm = neg ? 0.95 : clmax; // the cambered wing stalls earlier upside-down
  const as = cm / PLANE.CLa; // stall angle
  let cl;
  if (x < 0.75 * as) cl = PLANE.CLa * x;
  else if (x < as) {
    // Hermite blend from the straight line to a flat top at CLmax (rounded stall)
    const t = (x - 0.75 * as) / (0.25 * as);
    const h = (2 * t ** 3 - 3 * t ** 2 + 1) * 0.75 + (t ** 3 - 2 * t ** 2 + t) * 0.25 + (-2 * t ** 3 + 3 * t ** 2);
    cl = cm * h;
  } else {
    // Post-stall: lift collapses, then follows a flat plate (CL = sin 2α)
    const d = x - as;
    const post = cm * (1 - 0.32 * smoothstep(0, 0.12, d));
    const plate = 1.05 * Math.sin(2 * Math.min(x, Math.PI / 2));
    cl = lerp(post, plate, smoothstep(0.1, 0.45, d));
  }
  return neg ? -cl : cl;
}

export class SimFlightModel extends FlightModel {
  constructor() {
    super();
    this.cgPos = new Vector3();
    this.flaps = 0; // actual flap position 0..1 (0, 10, 20, 30 degrees)
    this.flapTarget = 0;
    this.trim = 0; // -1..1, + = nose-up trim
    this.brakes = 0;
    this.parkingBrake = false;
    this.rpm = 700;
    this.thrust = 0;
    this.autoRudder = true;
    this.wind = null; // Wind instance (optional)
    this.windNow = new Vector3();

    // Readouts for instruments / HUD
    this.ias = 0; // indicated airspeed (m/s)
    this.tas = 0;
    this.groundSpeed = 0;
    this.alpha = 0;
    this.beta = 0;
    this.stallWarning = false;
    this.stalled = false;
    this.slipBall = 0; // inclinometer ball (rad, + = ball to the right)
    this.turnRate = 0; // rad/s, + = turning right
    this.vsi = 0; // lagged vertical speed (like the real instrument)
    this.agl = 0;
    this.specificForce = new Vector3(0, G, 0); // what an accelerometer feels (body axes)

    this.wheels = WHEELS.map((w) => ({ ...w, compression: 0, contact: false, spin: 0, load: 0 }));
    this.onGround = false;
    this.airborneTime = 0;
    this.crashed = null; // reason string once crashed
    this.events = []; // { type: 'touchdown', ... } consumed by the game
    this.overstress = 0;
  }

  /** World position of a model-space point. */
  modelToWorld(p, out) {
    return out.copy(p).applyQuaternion(this.quaternion).add(this.position);
  }

  /**
   * Place the aircraft. `position` is the model origin (like the arcade model).
   * @param {number} speed  airspeed in m/s (0 = standing on the ground)
   */
  reset(position, quaternion, speed = 0) {
    super.reset(position, quaternion, speed);
    this.cgPos.copy(PLANE.cg).applyQuaternion(this.quaternion).add(this.position);
    this.angularVelocity.set(0, 0, 0);
    this.crashed = null;
    this.events.length = 0;
    this.airborneTime = speed > 1 ? 10 : 0;
    this.overstress = 0;
    this.vsi = 0;
    this.wind?.turb.set(0, 0, 0);
    for (const w of this.wheels) {
      w.compression = 0;
      w.contact = false;
      w.load = 0;
    }
    this.boosting = false;
    this.boostEnergy = 1;
    this.rpm = speed > 1 ? 2300 : 750;
    this.flaps = this.flapTarget;
    this.updateDerived();
  }

  /**
   * Trimmed straight-and-level condition at an airspeed: the angle of
   * attack where lift = weight, the elevator trim for zero pitching moment
   * and the throttle where thrust = drag.
   * @returns {{ alpha: number, trim: number, throttle: number }}
   */
  trimFor(speed, flaps = 0, gearDown = true, h = 300) {
    const P = PLANE;
    const qd = 0.5 * airDensity(h) * speed * speed;
    const CL = (P.mass * G) / (qd * P.S);
    const alphaEff = clamp(CL / P.CLa, -0.2, 0.28);
    const alpha = alphaEff - P.aoaOffset - flaps * P.flapCL;
    const de = -(P.Cm0 + P.Cma * Math.sin(alpha) + P.flapCm * flaps) / (P.Cmde * 0.95);
    const trim = clamp(-de / P.trimRange, -1, 1);
    const CD = P.CD0 + (gearDown ? P.gearCD : 0) + P.flapCD * flaps + (CL * CL) / (Math.PI * P.e * (P.b * P.b / P.S));
    const drag = qd * P.S * CD;
    // thr * T0' - (1 - thr) * windmill = drag  ->  solve for thr
    const t0 = (airDensity(h) / RHO0) * P.staticThrust * Math.max(1 - speed / P.propVmax, 0);
    const mill = 0.08 * speed * speed;
    const throttle = clamp((drag + mill) / Math.max(t0 + mill, 1), 0, 1);
    return { alpha, trim, throttle };
  }

  /** Start in trimmed level flight: right speed, attitude, trim and power. */
  resetAirborne(position, heading, speed, { flaps = 0, gearDown = false } = {}) {
    this.flapTarget = flaps;
    const t = this.trimFor(speed, flaps, gearDown, position.y);
    const q = new Quaternion().setFromAxisAngle(UP, -heading).multiply(new Quaternion().setFromAxisAngle(X, t.alpha));
    this.reset(position, q, speed);
    // The velocity is level (along the heading), the nose sits alpha above it
    this.velocity.set(Math.sin(heading), 0, -Math.cos(heading)).multiplyScalar(speed);
    this.trim = t.trim;
    this.throttle = t.throttle;
    this.parkingBrake = false;
    this.updateDerived();
  }

  /** Stand on the ground with the wheels just touching (springs at static compression). */
  resetOnGround(x, z, heading, groundY, { flaps = 0, parkingBrake = true } = {}) {
    this.flapTarget = flaps;
    // Static pitch: nose strut compresses a little less than the mains
    const pitch = -0.004;
    const q = new Quaternion().setFromAxisAngle(UP, -heading).multiply(new Quaternion().setFromAxisAngle(X, pitch));
    this.reset(new Vector3(x, groundY + 1.67 - 0.065, z), q, 0);
    this.velocity.set(0, 0, 0);
    this.trim = 0.25;
    this.throttle = 0;
    this.parkingBrake = parkingBrake;
    this.airborneTime = 0;
    this.updateDerived();
  }

  /**
   * One physics step.
   * @param {number} dt
   * @param {object} input  pitch/roll/yaw [-1,1], throttle (rate), brake 0..1
   * @param {object} world  { heightAt(x,z), isWater(x,z), isSolid(p), bounds }
   */
  update(dt, input, world) {
    if (this.crashed) return;
    const P = PLANE;

    // ---------------- Pilot controls ----------------
    this.throttle = clamp(this.throttle + input.throttle * 0.5 * dt, 0, 1);
    this.brakes = Math.max(input.brake ?? 0, this.parkingBrake ? 1 : 0);
    // Flaps run on an electric motor: about 7 s from up to full
    this.flaps += clamp(this.flapTarget - this.flaps, -dt / 7, dt / 7);
    const s = damp(14, dt);
    let yawCmd = input.yaw;
    // Auto-rudder assist (like the option in desktop simulators): on the
    // take-off roll it holds the right rudder that full power needs; in the
    // air it follows the ailerons to cancel adverse yaw
    if (this.autoRudder) {
      if (this.onGround) yawCmd += this.throttle * clamp(1 - this.tas / 40, 0, 1) * 0.17;
      else yawCmd += input.roll * 0.28;
      yawCmd = clamp(yawCmd, -1, 1);
    }
    this.surfaces.pitch += (clamp(input.pitch + this.trim * 0.41, -1, 1) - this.surfaces.pitch) * s;
    this.surfaces.roll += (input.roll - this.surfaces.roll) * s;
    this.surfaces.yaw += (yawCmd - this.surfaces.yaw) * s;
    const de = -clamp(input.pitch * P.maxElevator + this.trim * P.trimRange, -P.maxElevator, P.maxElevator);
    const da = this.surfaces.roll * P.maxAileron;
    const dr = this.surfaces.yaw * P.maxRudder;

    // ---------------- Atmosphere ----------------
    const ground = world.heightAt(this.cgPos.x, this.cgPos.z);
    this.agl = this.cgPos.y - ground;
    const rho = airDensity(this.cgPos.y);
    const sigma = rho / RHO0;
    if (this.wind) {
      this.wind.step(dt, this.tas, this.agl);
      this.wind.sample(this.agl, this.windNow);
    } else this.windNow.set(0, 0, 0);

    // Air-relative velocity in body axes
    _qInv.copy(this.quaternion).invert();
    _vb.copy(this.velocity).sub(this.windNow).applyQuaternion(_qInv);
    const V = _vb.length();
    this.tas = V;
    this.ias = V * Math.sqrt(sigma);

    _F.set(0, 0, 0);
    _M.set(0, 0, 0);
    const w = this.angularVelocity;
    const p = -w.z, q = w.x, r = -w.y;

    // ---------------- Engine and propeller ----------------
    const thr = this.throttle;
    const rpmTarget = clamp(650 + thr * 1650 + Math.max(V, 0) * (12 - 6 * thr), 600, 2800);
    this.rpm += (rpmTarget - this.rpm) * damp(1.6, dt);
    // Thrust: falls with airspeed; a windmilling prop at idle adds drag
    const vf = Math.max(-_vb.z, 0);
    this.thrust = sigma * (P.staticThrust * thr * Math.max(1 - vf / P.propVmax, 0)) - (1 - thr) * 0.08 * vf * vf;
    _F.z -= this.thrust;
    // Propeller slipstream over the tail (momentum theory: extra dynamic pressure = T / disc area)
    const disc = Math.PI * P.propRadius * P.propRadius;
    const qd = 0.5 * rho * V * V;
    const qTail = qd * 0.95 + 0.5 * Math.max(this.thrust, 0) / disc;
    // Engine torque rolls left, P-factor yaws left. The fin and wings are
    // rigged to cancel both in cruise, so they only show at high power and
    // low speed (take-off, climb, go-around).
    const lowSpeed = Math.max(1 - vf / 50, 0);
    const torque = (P.enginePower * thr) / Math.max((this.rpm * 2 * Math.PI) / 60, 50);
    _M.z += 0.25 * torque * lowSpeed;
    _M.y += 0.06 * Math.max(this.thrust, 0) * lowSpeed;

    // ---------------- Aerodynamics ----------------
    let lift = 0;
    this.stalled = false;
    if (V > 0.5) {
      _vhat.copy(_vb).divideScalar(V);
      const alpha = Math.atan2(-_vb.y, -_vb.z);
      const beta = Math.asin(clamp(_vb.x / V, -1, 1));
      this.alpha = alpha;
      this.beta = beta;
      const Vn = Math.max(V, 8);
      _liftDir.crossVectors(X, _vhat).normalize();

      // Ground effect: induced drag shrinks within about one span of the ground
      const hb = (16 * Math.max(this.agl - 0.5, 0.05)) / P.b;
      const ge = (hb * hb) / (1 + hb * hb);
      const AR = (P.b * P.b) / P.S;
      const kInd = 1 / (Math.PI * P.e * AR);
      const clmax = P.CLmax + P.flapCLmax * this.flaps;
      const yArm = 0.22 * P.b;
      let stallFrac = 0;

      // Each wing half: own local alpha (roll rate) and own airspeed (yaw rate)
      for (const side of [-1, 1]) {
        const aLocal = alpha + (side * p * yArm) / Vn;
        const aEff = aLocal + P.aoaOffset + P.flapCL * this.flaps;
        const qi = qd * (1 - (side * r * yArm) / Vn) ** 2;
        const cl = liftCoefficient(aEff, clmax);
        const as = clmax / P.CLa;
        const sf = smoothstep(as - 0.01, as + 0.08, Math.abs(aEff));
        stallFrac = Math.max(stallFrac, sf);
        const cd = kInd * cl * cl * (0.25 + 0.75 * ge) + sf * 1.15 * Math.sin(aLocal) ** 2;
        const half = 0.5 * qi * P.S * (1 + 0.1 * (1 - ge));
        // Force on this half (body axes): lift ⟂ airflow, drag along -airflow
        _tmp.copy(_liftDir).multiplyScalar(half * cl).addScaledVector(_vhat, -half * cd);
        _F.add(_tmp);
        lift += half * cl;
        // Moment about the CG: r x F
        _r.set(side * yArm, 0, 0);
        _M.add(_tmp2.crossVectors(_r, _tmp));
      }
      this.stalled = stallFrac > 0.5;
      // Stall warner (vane on the leading edge): sounds about 5 knots before the stall
      const aEffMean = alpha + P.aoaOffset + P.flapCL * this.flaps;
      this.stallWarning = aEffMean > clmax / P.CLa - 0.045 && !this.onGround;

      // Parasite drag of fuselage, gear and flaps + sideforce from the fuselage and fin
      const CDp = P.CD0 + (this.gearDown ? P.gearCD : 0) + P.flapCD * this.flaps + 0.5 * Math.sin(beta) ** 2;
      _F.addScaledVector(_vhat, -qd * P.S * CDp);
      _F.x += qd * P.S * P.CYb * Math.sin(beta) + qTail * P.S * P.CYdr * dr;

      // Pitch (about body x): stability + damping + elevator (in the slipstream).
      // At the stall the centre of lift moves back (nose-down "break") and the
      // tail, sitting in the wing's disturbed wake, loses some of its power.
      const qHat = (q * P.c) / (2 * Vn);
      const Cm = P.Cm0 + P.Cma * Math.sin(alpha) + P.Cmq * qHat + P.flapCm * this.flaps - 0.3 * stallFrac;
      const tailEff = 1 - 0.45 * smoothstep(0.15, 0.45, Math.abs(alpha));
      _M.x += qd * P.S * P.c * Cm + qTail * P.S * P.c * P.Cmde * de * tailEff;

      // Roll (standard: right wing down +) -> body z with the opposite sign
      const Cl = P.Clb * Math.sin(beta) + P.Clda * da * (1 - 0.5 * stallFrac);
      _M.z -= qd * P.S * P.b * Cl;

      // Yaw (standard: nose right +) -> body y with the opposite sign
      const pHat = (p * P.b) / (2 * Vn), rHat = (r * P.b) / (2 * Vn);
      const Cn = P.Cnb * Math.sin(beta) + P.Cnr * rHat + P.Cnp * pHat + P.Cnda * da;
      _M.y -= qd * P.S * P.b * Cn + qTail * P.S * P.b * P.Cndr * dr;
    } else {
      this.alpha = 0;
      this.beta = 0;
      this.stallWarning = false;
      // Standing still: the slipstream still gives some rudder/elevator authority
      _M.x += qTail * P.S * P.c * P.Cmde * de;
      _M.y -= qTail * P.S * P.b * P.Cndr * dr;
    }

    // ---------------- Sum forces in world axes ----------------
    _Fw.copy(_F).applyQuaternion(this.quaternion);
    const aeroWorldY = _Fw.y; // for the g-meter (non-gravity force)
    _Fw.y -= P.mass * G;

    // ---------------- Landing gear and ground contact ----------------
    _wWorld.copy(w).applyQuaternion(this.quaternion);
    this.onGround = false;
    let touchdownSink = 0;
    let newContact = false;
    const gearUsable = this.gearDown;
    for (const wh of this.wheels) {
      wh.load = 0;
      if (!gearUsable) {
        wh.contact = false;
        wh.compression = 0;
        continue;
      }
      // Wheel bottom in world space and the velocity of that point (v + ω x r)
      _r.copy(wh.p).sub(P.cg).applyQuaternion(this.quaternion);
      _pw.copy(this.cgPos).add(_r);
      const gh = world.heightAt(_pw.x, _pw.z);
      const depth = gh - _pw.y;
      if (depth <= 0) {
        wh.contact = false;
        wh.compression = Math.max(wh.compression - dt * 2, 0);
        continue;
      }
      if (world.isWater?.(_pw.x, _pw.z)) {
        this.crash('Ditched in the water');
        return;
      }
      _vp.crossVectors(_wWorld, _r).add(this.velocity);
      if (!wh.contact) {
        newContact = true;
        touchdownSink = Math.max(touchdownSink, -_vp.y);
      }
      wh.contact = true;
      this.onGround = true;
      wh.compression = Math.min(depth, 0.3);
      // Hooke's law + damping, never pulling the wheel down
      const N = Math.max(wh.k * depth - wh.c * _vp.y, 0);
      wh.load = N;

      // Rolling direction on the ground: body forward, turned by nose-wheel steering
      _fdir.set(0, 0, -1).applyQuaternion(this.quaternion);
      _fdir.y = 0;
      _fdir.normalize();
      _sdir.set(-_fdir.z, 0, _fdir.x); // right
      if (wh.steer) {
        const steer = -this.surfaces.yaw * lerp(0.45, 0.12, clamp(this.groundSpeed / 30, 0, 1));
        const c = Math.cos(steer), sn = Math.sin(steer);
        _tmp.copy(_fdir).multiplyScalar(c).addScaledVector(_sdir, -sn);
        _sdir.copy(_fdir).multiplyScalar(sn).addScaledVector(_sdir, c);
        _fdir.copy(_tmp);
      }
      const vLong = _vp.dot(_fdir);
      const vLat = _vp.dot(_sdir);
      // Sideways touchdown breaks the gear
      if (newContact && Math.abs(vLat) > 6 && this.airborneTime > 1) {
        this.crash('Touched down sideways: the gear failed');
        return;
      }
      // Rolling resistance (more on grass/dirt) + brakes, linear near zero speed so it can hold still
      const rough = world.isRunway?.(_pw.x, _pw.z) ? 0.02 : 0.07;
      const mu = rough + (wh.brake ? this.brakes * 0.6 : 0);
      const fLong = -clamp(vLong * (mu * N) / 0.15, -mu * N, mu * N);
      const fLat = -clamp(vLat * (0.75 * N) / 0.35, -0.75 * N, 0.75 * N);
      _tmp.set(0, N, 0).addScaledVector(_fdir, fLong).addScaledVector(_sdir, fLat);
      _Fw.add(_tmp);
      // Torque about the CG (world) -> body
      _tmp2.crossVectors(_r, _tmp).applyQuaternion(_qInv);
      _M.add(_tmp2);
      wh.spin += (vLong / wh.r) * dt;
    }
    if (this.onGround) {
      if (newContact && this.airborneTime > 1.5) {
        if (touchdownSink > 3.6) {
          this.crash(`Landing gear collapsed (${Math.round(touchdownSink * 196.85)} ft/min)`);
          return;
        }
        this.events.push({ type: 'touchdown', sink: touchdownSink, ias: this.ias, position: this.position.clone(), ...this.getAttitude() });
      }
      this.airborneTime = 0;
    } else this.airborneTime += dt;

    // ---------------- Integrate translation ----------------
    this.velocity.addScaledVector(_Fw, dt / P.mass);
    this.cgPos.addScaledVector(this.velocity, dt);

    // Specific force (accelerometer) in body axes: everything except gravity
    _tmp.copy(_Fw).applyQuaternion(_qInv).divideScalar(P.mass);
    _tmp2.set(0, -G, 0).applyQuaternion(_qInv);
    this.specificForce.copy(_tmp).sub(_tmp2);
    const g = this.specificForce.y / G;
    this.gLoad += (g - this.gLoad) * damp(10, dt);
    this.slipBall += (Math.atan2(this.specificForce.x, Math.max(this.specificForce.y, 0.5)) * -1 - this.slipBall) * damp(5, dt);
    void aeroWorldY;

    // ---------------- Integrate rotation (Euler's equations) ----------------
    const I = P.inertia;
    _Iw.set(I.x * w.x, I.y * w.y, I.z * w.z);
    _tmp.crossVectors(w, _Iw);
    w.x += ((_M.x - _tmp.x) / I.x) * dt;
    w.y += ((_M.y - _tmp.y) / I.y) * dt;
    w.z += ((_M.z - _tmp.z) / I.z) * dt;
    if (w.length() > 8) w.setLength(8);
    const angle = w.length() * dt;
    if (angle > 1e-9) {
      _axis.copy(w).normalize();
      _dq.setFromAxisAngle(_axis, angle);
      this.quaternion.multiply(_dq).normalize();
    }

    // ---------------- Scenery boundary (gentle turn back, like the arcade mode) ----------------
    this.outOfBounds = false;
    const bd = world.bounds;
    if (bd && !this.onGround) {
      const dx = this.cgPos.x - bd.x, dz = this.cgPos.z - bd.z;
      const dist = Math.hypot(dx, dz);
      if (dist > bd.radius + 400) {
        this.outOfBounds = true;
        const { fwd } = this.getAxes();
        const err = Math.atan2(fwd.z * (-dx / dist) - fwd.x * (-dz / dist), fwd.x * (-dx / dist) + fwd.z * (-dz / dist));
        this.rotateWorld(UP, clamp(err, -1, 1) * 0.5 * clamp((dist - bd.radius - 400) / 300, 0, 1) * dt);
      } else if (dist > bd.radius) this.outOfBounds = true;
    }

    this.updateDerived();
    this.checkStructure(dt, world, g);
  }

  /** Recompute the CG from `position` + `quaternion` (after moving the aircraft by hand). */
  syncCG() {
    this.cgPos.copy(PLANE.cg).applyQuaternion(this.quaternion).add(this.position);
  }

  /** Positions and readouts that follow from the state. */
  updateDerived() {
    this.position.copy(PLANE.cg).applyQuaternion(this.quaternion).negate().add(this.cgPos);
    this.speed = this.velocity.length();
    this.groundSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.vsi += (this.velocity.y - this.vsi) * 0.03; // the real VSI lags a few seconds
    // Turn rate = rate of change of heading (world yaw rate)
    _wWorld.copy(this.angularVelocity).applyQuaternion(this.quaternion);
    this.turnRate = -_wWorld.y;
    this.grounded = false; // the arcade ground-roll mode is never used in the simulator
  }

  /** Crashes: parts touching the ground, obstacles, over-stress. */
  checkStructure(dt, world, g) {
    for (const hp of HARD_POINTS) {
      this.modelToWorld(hp.p, _pw);
      const touching = _pw.y < world.heightAt(_pw.x, _pw.z) - 0.02;
      if (touching || world.isSolid?.(_pw)) {
        if (world.isWater?.(_pw.x, _pw.z)) this.crash('Ditched in the water');
        else if (hp.reason === 'belly') this.crash(this.gearDown ? 'Crashed' : 'Gear-up landing! Lower the gear with G');
        else if (hp.reason === 'nose') this.crash('Flew into the ground');
        else this.crash(touching ? hp.reason : 'Hit an obstacle');
        return;
      }
    }
    // Structure: +6 / -3 g limits and the never-exceed speed (with a little margin)
    const over = g > 6 || g < -3 || this.ias * KT > PLANE.vne * 1.12;
    this.overstress = over ? this.overstress + dt : Math.max(0, this.overstress - dt);
    if (this.overstress > 0.4) this.crash(g > 6 || g < -3 ? 'Structural failure: too many g' : 'Structural failure: overspeed');
  }

  crash(reason) {
    this.crashed = reason;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
  }
}

export { KT };
