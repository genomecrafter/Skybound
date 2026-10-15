import * as THREE from 'three';

/**
 * TRANSFORM DEBUG PANEL (toggle with T).
 *
 * Shows the aircraft root's live transformation, i.e. what three.js combines
 * into its model matrix  M = T · R · S :
 *   - Translation  position (x, y, z)
 *   - Rotation     as Euler angles (order 'YXZ' = heading, pitch, bank)
 *                  AND as a unit quaternion (x, y, z, w)
 *   - Scale        (x, y, z)
 *   - the resulting 4x4 matrix (column 4 = translation)
 * plus examples of the three transformation types on child objects:
 *   propeller rotation, landing-gear translation, next ring's scale pulse.
 *
 * An AxesHelper is attached to the aircraft: red = local X (right wing),
 * green = local Y (up), blue = local Z (tail; the nose points to -Z).
 * It is drawn on top of everything (depthTest off) so it's always visible.
 */
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const deg = (r) => ((r * 180) / Math.PI).toFixed(1).padStart(7);
const num = (v, d = 2) => v.toFixed(d).padStart(9);

export class DebugPanel {
  constructor(root, aircraft) {
    this.aircraft = aircraft;
    this.el = document.createElement('div');
    this.el.className = 'debug-panel hidden';
    root.append(this.el);
    this.visible = false;
    this.timer = 0;

    this.axes = new THREE.AxesHelper(7);
    this.axes.material.depthTest = false;
    this.axes.material.transparent = true;
    this.axes.renderOrder = 999;
    this.axes.visible = false;
    aircraft.root.add(this.axes);
  }

  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
    this.axes.visible = this.visible;
    return this.visible;
  }

  update(dt, rings) {
    if (!this.visible) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.1; // 10 Hz is readable

    const root = this.aircraft.root;
    root.updateMatrix();
    const p = root.position, q = root.quaternion, s = root.scale;
    _e.setFromQuaternion(q, 'YXZ');
    const m = root.matrix.elements; // column-major
    const row = (r) => `${num(m[r])} ${num(m[r + 4])} ${num(m[r + 8])} ${num(m[r + 12], 1)}`;
    const parts = this.aircraft.parts;
    const ring = rings?.nextRing;

    this.el.textContent =
      `TRANSFORM DEBUG  (T to hide)\n` +
      `─ Aircraft root ───────────────────────\n` +
      `Translation  x${num(p.x, 1)}  y${num(p.y, 1)}  z${num(p.z, 1)}\n` +
      `Rotation (Euler YXZ, deg)\n` +
      `   heading ${deg(_e.y)}  pitch ${deg(_e.x)}  bank ${deg(_e.z)}\n` +
      `Quaternion  x${num(q.x, 3)} y${num(q.y, 3)}\n` +
      `            z${num(q.z, 3)} w${num(q.w, 3)}   |q| = ${q.length().toFixed(3)}\n` +
      `Scale        x${num(s.x)}  y${num(s.y)}  z${num(s.z)}\n` +
      `Model matrix M = T·R·S\n` +
      `${row(0)}\n${row(1)}\n${row(2)}\n${row(3)}\n` +
      `─ Child transforms ────────────────────\n` +
      `Propeller rotation.z   ${deg(parts.propeller.rotation.z)}°\n` +
      `Aileron R rotation.x   ${deg(parts.aileronR.rotation.x)}°\n` +
      `Elevator rotation.x    ${deg(parts.elevator.rotation.x)}°\n` +
      `Gear translation.y     ${num(parts.gear.mainL.position.y - parts.gear.mainL.userData.baseY)} m\n` +
      `Next ring scale        ${ring ? num(ring.mesh.scale.x, 3) : '      -'}`;
  }
}
