import * as THREE from 'three';
import { clamp } from '../utils/math.js';

/**
 * DEV ONLY (?autopilot): flies the ring course (and, on routes with a runway,
 * the approach and landing) so routes can be tested without a human pilot.
 * Overrides the input axes. Also used by the headless route tests.
 */
const _local = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _target = new THREE.Vector3();
const TAN3 = Math.tan((3 * Math.PI) / 180);

/** Bank toward a world-space target point and climb/descend toward its height. */
function steerTo(input, flight, target, pitchFromHeight = true) {
  _local.subVectors(target, flight.position).applyQuaternion(_q.copy(flight.quaternion).invert());
  const yawErr = Math.atan2(_local.x, -_local.z);
  const pitchErr = Math.atan2(_local.y, Math.hypot(_local.x, _local.z));
  const { bank } = flight.getAttitude();
  const desiredBank = clamp(yawErr * 2.2, -1.0, 1.0);
  input.roll = clamp((desiredBank - (bank * Math.PI) / 180) * 2.5, -1, 1);
  if (pitchFromHeight) input.pitch = clamp(pitchErr * 3 + Math.abs(yawErr) * 0.6, -1, 1);
  input.yaw = clamp(yawErr, -1, 1);
  return yawErr;
}

export function autopilot(input, flight, rings, landing = null, clearance = 1.67) {
  const ring = rings?.nextRing;
  if (ring) {
    steerTo(input, flight, ring.center);
    input.throttle = flight.speed < 45 ? 1 : flight.speed > 55 ? -1 : 0;
    return;
  }
  if (!landing) return;

  const rw = landing.runway;
  const { along } = landing.local(flight.position.x, flight.position.z);

  if (flight.grounded) {
    // Roll-out: idle (brakes), keep straight on the centre-line
    _target.copy(landing.threshold).addScaledVector(rw.dir, along + 200);
    steerTo(input, flight, _target, false);
    input.pitch = 0;
    input.throttle = -1;
    return;
  }

  // Final approach: track the centre-line 400 m ahead, follow a 3° glide path
  _target.copy(landing.threshold).addScaledVector(rw.dir, along + 400);
  _target.y = flight.position.y;
  steerTo(input, flight, _target, false);
  const h = flight.position.y - clearance - rw.center.y;
  const hTarget = Math.max(0, 300 - along) * TAN3;
  let vsTarget = clamp(-flight.speed * TAN3 + (hTarget - h) * 0.25, -6, 3);
  if (h < 6) vsTarget = -0.9; // flare: slow the descent just before touchdown
  input.pitch = clamp((vsTarget - flight.velocity.y) * 0.25, -0.6, 0.7);
  input.throttle = flight.speed < 31 ? 1 : flight.speed > 35 ? -1 : 0;
}
