import * as THREE from 'three';

/**
 * Landing logic (no rendering, so it can also be unit-tested headlessly).
 *
 * A runway is described by its centre, its landing direction (unit vector on
 * the ground), length and width. A world point is converted to RUNWAY
 * COORDINATES with two dot products:
 *    along  = (p - threshold) . dir      (0 at the threshold, length at the far end)
 *    across = (p - centre)    . side     (0 on the centre-line)
 *
 * TOUCHDOWN: when the wheels reach the runway surface we check that
 *   - the landing gear is down,
 *   - the sink rate (vertical speed) is gentle,
 *   - the wings are roughly level and the nose isn't pointing down.
 * Pass -> the aircraft switches to ground-roll physics; fail -> crash.
 */
export const LIMITS = { maxSink: 4.0, maxBank: 12, minPitch: -6, maxSpeed: 62 };

const _d = new THREE.Vector3();
const _probe = new THREE.Vector3();

export class LandingController {
  /**
   * @param {object} runway { center: Vector3 (y = surface height), dir: Vector3, length, width }
   * @param {number} clearance  aircraft origin height above the wheels
   */
  constructor(runway, clearance) {
    this.runway = runway;
    this.clearance = clearance;
    this.side = new THREE.Vector3(-runway.dir.z, 0, runway.dir.x);
    this.threshold = runway.center.clone().addScaledVector(runway.dir, -runway.length / 2);
    this.reset();
  }

  reset() {
    this.state = 'air'; // 'air' | 'rolling' | 'stopped'
    this.touchdown = null;
  }

  /** Runway coordinates of a world point. */
  local(x, z) {
    _d.set(x - this.threshold.x, 0, z - this.threshold.z);
    const along = _d.dot(this.runway.dir);
    _d.set(x - this.runway.center.x, 0, z - this.runway.center.z);
    const across = _d.dot(this.side);
    return { along, across };
  }

  isOnRunway(x, z, margin = 0) {
    const { along, across } = this.local(x, z);
    return along >= -margin && along <= this.runway.length + margin && Math.abs(across) <= this.runway.width / 2 + margin;
  }

  /**
   * Call while airborne. Returns null if the wheels haven't reached the
   * runway yet; otherwise { ok, reason?, sink, grade? }.
   */
  checkTouchdown(flight) {
    if (this.state !== 'air') return null;
    const p = flight.position;
    if (!this.isOnRunway(p.x, p.z, 4)) return null;
    const { up } = flight.getAxes();
    _probe.copy(p).addScaledVector(up, -this.clearance); // lowest point: the wheels
    if (_probe.y > this.runway.center.y + 0.05) return null;

    const att = flight.getAttitude();
    const sink = -flight.velocity.y;
    const result = { sink, speed: flight.speed, along: this.local(p.x, p.z).along };
    if (!flight.gearDown) return { ...result, ok: false, reason: 'Belly landing! Lower the gear with G or right-click' };
    if (sink > LIMITS.maxSink) return { ...result, ok: false, reason: `Touchdown too hard (${sink.toFixed(1)} m/s)` };
    if (Math.abs(att.bank) > LIMITS.maxBank) return { ...result, ok: false, reason: 'Wings not level at touchdown' };
    if (att.pitch < LIMITS.minPitch) return { ...result, ok: false, reason: 'Nose-first touchdown' };
    if (flight.speed > LIMITS.maxSpeed) return { ...result, ok: false, reason: 'Far too fast to land' };

    this.state = 'rolling';
    const grade = sink < 1.2 ? 'BUTTER!' : sink < 2.4 ? 'SMOOTH' : 'FIRM';
    this.touchdown = { ...result, ok: true, grade };
    return this.touchdown;
  }

  /** While rolling: has the aircraft come to a stop (or run off the runway)? */
  checkRollout(flight) {
    if (this.state !== 'rolling') return null;
    const p = flight.position;
    if (!this.isOnRunway(p.x, p.z, 8)) return { event: 'overrun' };
    if (!flight.grounded) {
      this.state = 'air'; // touch-and-go: took off again
      return { event: 'takeoff' };
    }
    if (flight.speed < 1.5) {
      this.state = 'stopped';
      return { event: 'stopped', remaining: this.runway.length - this.local(p.x, p.z).along };
    }
    return null;
  }
}
