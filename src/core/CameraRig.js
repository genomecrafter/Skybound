import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, damp } from '../utils/math.js';
import { PILOT_EYE } from '../aircraft/Cockpit.js';

/**
 * Third-person chase camera.
 *
 *  - LAG: the camera follows a *smoothed* copy of the aircraft's forward
 *    vector (exponential smoothing), so when the plane turns the camera
 *    swings round a moment later, which gives a sense of weight.
 *  - BANKING: the camera's up-vector is a blend between world-up and the
 *    aircraft's up-vector. It rolls a little with the plane (bankFollow ~ 0.3)
 *    but keeps the horizon readable. When the plane points straight up/down
 *    the blend shifts toward the plane's up to avoid a degenerate lookAt.
 *  - FREE-LOOK: mouse movement rotates the chase offset around the plane
 *    (yaw about world-up, pitch about the camera's right axis).
 *  - SPEED FOV: the field of view widens with speed (and more when boosting),
 *    which exaggerates the sense of velocity.
 *  - SHAKE: small, smooth pseudo-random offsets at high speed / high g.
 *
 * COCKPIT MODE (C key): the camera is placed at the pilot's eye point, a
 * fixed offset in the AIRCRAFT'S LOCAL SPACE, transformed to world space by
 * the aircraft's quaternion. Its orientation is the aircraft's orientation
 * multiplied by the head-turn (free-look) rotation, so the horizon tilts as
 * the plane banks - just like being in a real cockpit.
 */
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _back = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _look = new THREE.Vector3();
const _ahead = new THREE.Vector3();
const _q = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const EYE = PILOT_EYE; // pilot's eye point in aircraft space (left seat)
const _headEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _headQ = new THREE.Quaternion();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.smoothFwd = new THREE.Vector3(0, 0, -1);
    this.smoothUp = new THREE.Vector3(0, 1, 0);
    this.groundAt = null; // optional (x, z) => height, keeps the camera above terrain
    this.fov = CONFIG.camera.fovMin;
    this.time = 0;
    this.mode = 'chase'; // 'chase' | 'cockpit'
    this.sim = false; // flight-simulator cockpit effects
    this.headG = 0;
  }

  setMode(mode) {
    this.mode = mode;
    // Cockpit parts are only ~0.6 m from the eye: move the near clip plane in
    this.camera.near = mode === 'cockpit' ? 0.1 : 0.5;
    this.camera.updateProjectionMatrix();
  }

  updateCockpit(dt, flight, look) {
    const cam = this.camera;
    cam.position.copy(EYE).applyQuaternion(flight.quaternion).add(flight.position);
    // Head turn: yaw about the plane's up axis, then pitch
    // Simulator: the head rests a little lower (to see the panel) and sinks
    // under positive g; runway bumps and stall buffet shake the view
    const bias = this.sim ? -0.11 : 0;
    _headEuler.set((look?.pitch ?? 0) * 0.8 + bias, look?.yaw ?? 0, 0);
    _headQ.setFromEuler(_headEuler);
    cam.quaternion.copy(flight.quaternion).multiply(_headQ);
    // Subtle vibration from the engine / boost
    let v = (flight.boosting ? 0.012 : 0.003) + flight.throttle * 0.002;
    if (this.sim) {
      this.headG += (clamp(flight.gLoad - 1, -2, 4) - this.headG) * damp(6, dt);
      _fwd.set(0, -1, 0).applyQuaternion(flight.quaternion);
      cam.position.addScaledVector(_fwd, this.headG * 0.025);
      if (flight.onGround) v += Math.min(flight.groundSpeed / 30, 1) * 0.006;
      if (flight.stallWarning) v += 0.008 + (flight.stalled ? 0.012 : 0);
    }
    cam.position.y += Math.sin(this.time * 53) * v + (this.sim ? Math.sin(this.time * 31.7) * v * 0.7 : 0);
    cam.position.x += Math.sin(this.time * 47) * v * 0.6;
    const targetFov = 70 + Math.max(0, (flight.speed - 30) / 50) * 8 + (flight.boosting ? 6 : 0);
    this.fov += (targetFov - this.fov) * damp(2, dt);
    cam.fov = this.fov;
    cam.updateProjectionMatrix();
  }

  /** Jump straight behind the aircraft (used on spawn/respawn). */
  snap(flight) {
    const { fwd, up } = flight.getAxes(_fwd, _up);
    this.smoothFwd.copy(fwd);
    this.smoothUp.copy(up);
    this.update(1, flight, null, true);
  }

  /**
   * @param {number} dt
   * @param {FlightModel} flight
   * @param {{yaw:number, pitch:number}|null} look  free-look angles from the mouse
   */
  update(dt, flight, look, instant = false) {
    const C = CONFIG.camera;
    const cam = this.camera;
    this.time += dt;
    if (this.mode === 'cockpit' && !instant) {
      this.updateCockpit(dt, flight, look);
      return;
    }
    const { fwd, up } = flight.getAxes(_fwd, _up);

    // 1) Smooth the direction we chase (rotational lag)
    const k = instant ? 1 : damp(C.followSharpness, dt);
    this.smoothFwd.lerp(fwd, k).normalize();

    // 2) Offset direction: behind the plane, rotated by free-look
    _back.copy(this.smoothFwd).negate();
    const lookYaw = look?.yaw ?? 0;
    const lookPitch = look?.pitch ?? 0;
    if (lookYaw) _back.applyQuaternion(_q.setFromAxisAngle(WORLD_UP, lookYaw));
    if (lookPitch) {
      _axis.crossVectors(_back, WORLD_UP);
      if (_axis.lengthSq() > 1e-6) _back.applyQuaternion(_q.setFromAxisAngle(_axis.normalize(), lookPitch));
    }

    // 3) Position: pull back a little with speed
    const dist = C.distance + flight.speed * 0.04;
    cam.position.copy(flight.position).addScaledVector(_back, dist).addScaledVector(WORLD_UP, C.height);
    if (this.groundAt) cam.position.y = Math.max(cam.position.y, this.groundAt(cam.position.x, cam.position.z) + 2);

    // 4) Shake: smooth sums of sines (cheap "noise"), stronger when boosting / pulling g
    const shake = (flight.boosting ? 0.12 : 0) + clamp((flight.gLoad - 2) * 0.05, 0, 0.1) + clamp((flight.speed - 70) * 0.004, 0, 0.06);
    if (shake > 0 && !instant) {
      const t = this.time;
      cam.position.x += (Math.sin(t * 37.1) + Math.sin(t * 23.7)) * shake * 0.5;
      cam.position.y += (Math.sin(t * 41.3) + Math.sin(t * 19.9)) * shake * 0.5;
    }

    // 5) Banking: blend world-up toward plane-up
    const vertical = Math.abs(this.smoothFwd.y);
    const bank = clamp(C.bankFollow + Math.pow(vertical, 4) * (1 - C.bankFollow), 0, 1);
    _look.copy(WORLD_UP).lerp(up, bank).normalize();
    this.smoothUp.lerp(_look, instant ? 1 : damp(5, dt)).normalize();
    cam.up.copy(this.smoothUp);

    // 6) Look slightly ahead of the plane; when free-looking, look at the plane itself
    const lookAmount = clamp((Math.abs(lookYaw) + Math.abs(lookPitch)) * 2, 0, 1);
    _ahead.copy(flight.position).addScaledVector(fwd, 12).addScaledVector(WORLD_UP, 1.0);
    _look.copy(flight.position).addScaledVector(WORLD_UP, 1.0).lerp(_ahead, 1 - lookAmount);
    cam.lookAt(_look);

    // 7) Speed-based field of view (+ extra while boosting)
    const t = clamp((flight.speed - 30) / 50, 0, 1);
    const targetFov = C.fovMin + (C.fovMax - C.fovMin) * t + (flight.boosting ? 8 : 0);
    this.fov += (targetFov - this.fov) * (instant ? 1 : damp(2, dt));
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
