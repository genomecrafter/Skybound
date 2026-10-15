import { PLANE, KT } from './SimFlightModel.js';
import { clamp } from '../utils/math.js';

/**
 * The instrument panel of the simulator, drawn with the Canvas 2D API.
 *
 * One drawing routine is used twice:
 *  - on a <canvas> overlaid on the screen (chase view, or H in the cockpit)
 *  - on a canvas that is uploaded as a TEXTURE onto the 3D instrument panel
 *    in the cockpit (CanvasTexture, re-uploaded about 30 times a second), so
 *    the needles in the 3D cockpit really move.
 *
 * Layout (logical units 1024 x 320, scaled to the canvas size):
 *   the classic "SIX-PACK" of flight instruments, arranged as in every
 *   light aircraft since the 1950s:
 *       airspeed    attitude      altimeter
 *       turn coord. heading       vertical speed
 *   then engine RPM, a g-meter, warning lights, flaps / trim / throttle
 *   indicators and a small digital readout.
 *
 * Every gauge is a rotation: a needle angle is a linear function of the
 * value (e.g. altimeter: 360° per 1000 ft). The attitude indicator is a
 * 2D transform of the horizon: rotate by -bank, then translate by pitch.
 */
export const PANEL_W = 1024;
export const PANEL_H = 320;
const FT = 3.28084;
const TAU = Math.PI * 2;
const rad = (deg) => (deg * Math.PI) / 180;

export class Instruments {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.gMax = 1;
    this.gMin = 1;
  }

  resetGMeter() {
    this.gMax = 1;
    this.gMin = 1;
  }

  /**
   * Draw every instrument.
   * @param {import('./SimFlightModel.js').SimFlightModel} f
   * @param {object} extra { night, autoRudder, windText }
   */
  draw(f, extra = {}) {
    const g = this.g;
    const sx = this.canvas.width / PANEL_W, sy = this.canvas.height / PANEL_H;
    g.setTransform(sx, 0, 0, sy, 0, 0);
    this.gMax = Math.max(this.gMax, f.gLoad);
    this.gMin = Math.min(this.gMin, f.gLoad);
    this.night = !!extra.night;

    this.drawPanel(g);
    const att = f.getAttitude();
    const u = 160; // gauge cell size
    const R = 66;
    const cx = (i) => 86 + i * u, cy = (j) => 80 + j * u;
    this.airspeed(g, cx(0), cy(0), R, f.ias * KT);
    this.attitude(g, cx(1), cy(0), R, att.pitch, att.bank);
    this.altimeter(g, cx(2), cy(0), R, f.position.y * FT);
    this.turnCoordinator(g, cx(0), cy(1), R, f.turnRate, f.slipBall);
    this.heading(g, cx(1), cy(1), R, att.heading);
    this.vsi(g, cx(2), cy(1), R, f.vsi * FT * 60);

    this.tach(g, 600, 80, 62, f.rpm);
    this.gMeter(g, 744, 80, 62, f.gLoad);
    this.annunciators(g, 830, 22, f, extra);
    this.flapsIndicator(g, 548, 178, f.flaps, f.flapTarget);
    this.trimIndicator(g, 628, 178, f.trim);
    this.throttleIndicator(g, 700, 178, f.throttle);
    this.readout(g, 770, 182, f, extra);
  }

  // ------------------------------------------------------------ panel --

  drawPanel(g) {
    const grd = g.createLinearGradient(0, 0, 0, PANEL_H);
    grd.addColorStop(0, '#34383f');
    grd.addColorStop(1, '#22252b');
    g.fillStyle = grd;
    g.fillRect(0, 0, PANEL_W, PANEL_H);
    // Recessed block behind the six-pack
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(4, 2, 488, PANEL_H - 4);
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 2;
    g.strokeRect(4, 2, 488, PANEL_H - 4);
  }

  /** Round instrument case: bezel, black face, screws, glass reflection (drawn last). */
  face(g, x, y, r) {
    // Square mounting plate with 4 screws
    g.fillStyle = '#17191d';
    roundRect(g, x - r - 9, y - r - 9, 2 * r + 18, 2 * r + 18, 10);
    g.fill();
    g.fillStyle = '#5a5f68';
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      g.beginPath();
      g.arc(x + dx * (r + 2), y + dy * (r + 2), 3, 0, TAU);
      g.fill();
    }
    // Bezel ring
    const b = g.createLinearGradient(x - r, y - r, x + r, y + r);
    b.addColorStop(0, '#6d727c');
    b.addColorStop(1, '#202227');
    g.fillStyle = b;
    g.beginPath();
    g.arc(x, y, r + 5, 0, TAU);
    g.fill();
    g.fillStyle = '#0b0c0e';
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  glass(g, x, y, r) {
    const gl = g.createLinearGradient(x - r, y - r, x + r * 0.3, y + r * 0.3);
    gl.addColorStop(0, 'rgba(255,255,255,0.13)');
    gl.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  get ink() {
    return this.night ? '#ffe6c0' : '#f2f2ee';
  }

  /** Tick marks and labels on a dial. Angles in degrees, clockwise from 12 o'clock. */
  ticks(g, x, y, r, from, to, step, len, width, angleOf, color = this.ink) {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    for (let v = from; v <= to + 1e-6; v += step) {
      const a = rad(angleOf(v)) - Math.PI / 2;
      g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      g.lineTo(x + Math.cos(a) * (r - len), y + Math.sin(a) * (r - len));
    }
    g.stroke();
  }

  labels(g, x, y, r, values, angleOf, size = 14, fmt = String) {
    g.fillStyle = this.ink;
    g.font = `bold ${size}px Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const v of values) {
      const a = rad(angleOf(v)) - Math.PI / 2;
      g.fillText(fmt(v), x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
  }

  arc(g, x, y, r, a0, a1, color, width) {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.arc(x, y, r, rad(a0) - Math.PI / 2, rad(a1) - Math.PI / 2);
    g.stroke();
  }

  /** Tapered needle from the centre. */
  needle(g, x, y, angleDeg, len, width = 5, color = this.ink, tail = 12) {
    g.save();
    g.translate(x, y);
    g.rotate(rad(angleDeg));
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(-width / 2, tail);
    g.lineTo(-width * 0.18, -len);
    g.lineTo(width * 0.18, -len);
    g.lineTo(width / 2, tail);
    g.closePath();
    g.fill();
    g.restore();
  }

  hub(g, x, y, r = 6) {
    g.fillStyle = '#2b2e33';
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  caption(g, x, y, text, size = 10) {
    g.fillStyle = this.night ? 'rgba(255,230,192,0.75)' : 'rgba(242,242,238,0.75)';
    g.font = `${size}px Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x, y);
  }

  // ------------------------------------------------------- instruments --

  /** Airspeed indicator (knots) with the white / green / yellow arcs and red line. */
  airspeed(g, x, y, r, kt) {
    this.face(g, x, y, r);
    const ang = (v) => 12 + (clamp(v, 0, 180) / 180) * 330;
    this.arc(g, x, y, r - 13, ang(PLANE.vso), ang(PLANE.vfe), '#e8e8e8', 5);
    this.arc(g, x, y, r - 7, ang(PLANE.vs1), ang(PLANE.vno), '#2fbf4a', 6);
    this.arc(g, x, y, r - 7, ang(PLANE.vno), ang(PLANE.vne), '#e6c21e', 6);
    this.ticks(g, x, y, r - 3, PLANE.vne, PLANE.vne, 1, 14, 4, ang, '#e0302a');
    this.ticks(g, x, y, r - 3, 0, 180, 5, 6, 1.5, ang);
    this.ticks(g, x, y, r - 3, 0, 180, 10, 11, 2.5, ang);
    this.labels(g, x, y, r - 26, [40, 60, 80, 100, 120, 140, 160], ang, 12);
    this.caption(g, x, y - 14, 'AIRSPEED');
    this.caption(g, x, y + 22, 'KNOTS');
    this.needle(g, x, y, ang(kt), r - 8, 6);
    this.hub(g, x, y);
    this.glass(g, x, y, r);
  }

  /** Attitude indicator (artificial horizon). */
  attitude(g, x, y, r, pitch, bank) {
    this.face(g, x, y, r);
    const ppd = r / 32; // pixels per degree of pitch
    g.save();
    g.beginPath();
    g.arc(x, y, r - 1, 0, TAU);
    g.clip();
    g.translate(x, y);
    g.rotate(rad(-bank));
    g.translate(0, clamp(pitch, -60, 60) * ppd);
    const sky = g.createLinearGradient(0, -r * 2, 0, 0);
    sky.addColorStop(0, '#1f5fa8');
    sky.addColorStop(1, '#4a92d8');
    g.fillStyle = sky;
    g.fillRect(-r * 2, -r * 4, r * 4, r * 4);
    const gnd = g.createLinearGradient(0, 0, 0, r * 2);
    gnd.addColorStop(0, '#8a5a30');
    gnd.addColorStop(1, '#5a3a1e');
    g.fillStyle = gnd;
    g.fillRect(-r * 2, 0, r * 4, r * 4);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-r * 2, 0);
    g.lineTo(r * 2, 0);
    g.stroke();
    // Pitch ladder every 5° (labels every 10°)
    g.lineWidth = 1.5;
    g.font = 'bold 9px Arial, sans-serif';
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (let p = -30; p <= 30; p += 5) {
      if (p === 0) continue;
      const yy = -p * ppd;
      const w = p % 10 === 0 ? 18 : 8;
      g.beginPath();
      g.moveTo(-w, yy);
      g.lineTo(w, yy);
      g.stroke();
      if (p % 10 === 0) g.fillText(String(Math.abs(p)), w + 3, yy);
    }
    g.restore();

    // Bank scale on the fixed case: marks at 10, 20, 30, 45, 60 degrees
    g.save();
    g.translate(x, y);
    g.strokeStyle = '#fff';
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const big = Math.abs(a) === 30 || Math.abs(a) === 60;
      const t = rad(a) - Math.PI / 2;
      g.lineWidth = big ? 2.5 : 1.5;
      g.beginPath();
      g.moveTo(Math.cos(t) * (r - 2), Math.sin(t) * (r - 2));
      g.lineTo(Math.cos(t) * (r - (big ? 12 : 8)), Math.sin(t) * (r - (big ? 12 : 8)));
      g.stroke();
    }
    // Zero mark (fixed white triangle)
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(0, -r + 12);
    g.lineTo(-5, -r + 2);
    g.lineTo(5, -r + 2);
    g.fill();
    // Sky pointer turns with the horizon
    g.rotate(rad(-bank));
    g.fillStyle = '#ff9a2a';
    g.beginPath();
    g.moveTo(0, -r + 13);
    g.lineTo(-6, -r + 23);
    g.lineTo(6, -r + 23);
    g.fill();
    g.restore();

    // Miniature aircraft (fixed)
    g.strokeStyle = '#ff9a2a';
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x - r * 0.55, y);
    g.lineTo(x - r * 0.18, y);
    g.lineTo(x, y + 9);
    g.lineTo(x + r * 0.18, y);
    g.lineTo(x + r * 0.55, y);
    g.stroke();
    g.lineCap = 'butt';
    g.fillStyle = '#ff9a2a';
    g.beginPath();
    g.arc(x, y, 3, 0, TAU);
    g.fill();
    this.glass(g, x, y, r);
  }

  /** Three-pointer altimeter: 100 ft (long), 1000 ft (short, wide), 10 000 ft (thin). */
  altimeter(g, x, y, r, ft) {
    this.face(g, x, y, r);
    const ang = (v) => (v / 10) * 360;
    this.ticks(g, x, y, r - 3, 0, 10, 0.2, 6, 1.5, ang);
    this.ticks(g, x, y, r - 3, 0, 9, 1, 12, 3, ang);
    this.labels(g, x, y, r - 22, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], ang, 15);
    // Kollsman window (pressure setting)
    g.fillStyle = '#000';
    g.fillRect(x + 14, y - 7, 34, 14);
    g.strokeStyle = '#555';
    g.lineWidth = 1;
    g.strokeRect(x + 14, y - 7, 34, 14);
    g.fillStyle = this.ink;
    g.font = '10px Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('29.92', x + 31, y + 1);
    this.caption(g, x, y - 18, 'ALT');
    this.caption(g, x, y + 24, '100 FEET');
    const f = Math.max(ft, 0);
    this.needle(g, x, y, (f / 100000) * 360, r - 6, 2, this.ink, 4); // 10 000 ft
    this.needle(g, x, y, (f / 10000) * 360, r * 0.55, 8, this.ink, 8); // 1000 ft
    this.needle(g, x, y, (f / 1000) * 360, r - 8, 5, this.ink, 14); // 100 ft
    this.hub(g, x, y);
    this.glass(g, x, y, r);
  }

  /** Turn coordinator: aircraft symbol shows the rate of turn; the ball shows slip / skid. */
  turnCoordinator(g, x, y, r, turnRate, ball) {
    this.face(g, x, y, r);
    // Standard-rate turn (3°/s, a full circle in 2 minutes) = symbol on the 20° mark
    const std = rad(3);
    const tilt = clamp((turnRate / std) * 20, -35, 35);
    for (const s of [-1, 1]) {
      for (const a of [0, 20]) {
        const t = rad(90 + s * (90 + a)) - Math.PI / 2;
        g.strokeStyle = this.ink;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(x + Math.cos(t) * (r - 3), y + Math.sin(t) * (r - 3));
        g.lineTo(x + Math.cos(t) * (r - 14), y + Math.sin(t) * (r - 14));
        g.stroke();
      }
    }
    g.fillStyle = this.ink;
    g.font = 'bold 13px Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('L', x - r * 0.72, y + 22);
    g.fillText('R', x + r * 0.72, y + 22);
    this.caption(g, x, y - r * 0.55, 'TURN COORDINATOR', 8);
    this.caption(g, x, y + r * 0.62, '2 MIN', 9);
    // Inclinometer: curved glass tube with a ball
    const ty = y + 32;
    g.fillStyle = '#d8d4c4';
    roundRect(g, x - 34, ty - 8, 68, 16, 8);
    g.fill();
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(x + s * 9, ty - 8);
      g.lineTo(x + s * 9, ty + 8);
      g.stroke();
    }
    const bx = x + clamp(ball / 0.22, -1, 1) * 27;
    g.fillStyle = '#111';
    g.beginPath();
    g.arc(bx, ty, 6.5, 0, TAU);
    g.fill();
    // Aircraft symbol (rear view), rolls with the turn rate
    g.save();
    g.translate(x, y + 2);
    g.rotate(rad(tilt));
    g.fillStyle = this.ink;
    g.fillRect(-r * 0.62, -2.5, r * 1.24, 5);
    g.beginPath();
    g.arc(0, 0, 7, 0, TAU);
    g.fill();
    g.fillRect(-1.5, -16, 3, 12);
    g.restore();
    this.hub(g, x, y + 2, 3);
    this.glass(g, x, y, r);
  }

  /** Heading indicator: a compass card that turns under a fixed lubber line. */
  heading(g, x, y, r, hdg) {
    this.face(g, x, y, r);
    g.save();
    g.translate(x, y);
    g.rotate(rad(-hdg));
    g.strokeStyle = this.ink;
    for (let a = 0; a < 360; a += 5) {
      const big = a % 10 === 0;
      const t = rad(a) - Math.PI / 2;
      g.lineWidth = big ? 2 : 1;
      g.beginPath();
      g.moveTo(Math.cos(t) * (r - 3), Math.sin(t) * (r - 3));
      g.lineTo(Math.cos(t) * (r - (big ? 11 : 7)), Math.sin(t) * (r - (big ? 11 : 7)));
      g.stroke();
    }
    g.fillStyle = this.ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let a = 0; a < 360; a += 30) {
      g.save();
      g.rotate(rad(a));
      g.font = names[a] ? 'bold 15px Arial, sans-serif' : 'bold 12px Arial, sans-serif';
      g.fillStyle = a === 0 ? '#ff9a2a' : this.ink;
      g.fillText(names[a] ?? String(a / 10), 0, -r + 21);
      g.restore();
    }
    g.restore();
    // Fixed lubber line and aircraft symbol
    g.fillStyle = '#ff9a2a';
    g.beginPath();
    g.moveTo(x, y - r + 14);
    g.lineTo(x - 5, y - r + 3);
    g.lineTo(x + 5, y - r + 3);
    g.fill();
    g.strokeStyle = '#ff9a2a';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x, y - 18);
    g.lineTo(x, y + 16);
    g.moveTo(x - 15, y - 3);
    g.lineTo(x + 15, y - 3);
    g.moveTo(x - 7, y + 13);
    g.lineTo(x + 7, y + 13);
    g.stroke();
    this.glass(g, x, y, r);
  }

  /** Vertical speed indicator, ±2000 ft/min, zero at 9 o'clock. */
  vsi(g, x, y, r, fpm) {
    this.face(g, x, y, r);
    const ang = (v) => -90 + (clamp(v, -2000, 2000) / 2000) * 170;
    this.ticks(g, x, y, r - 3, -2000, 2000, 100, 6, 1.5, ang);
    this.ticks(g, x, y, r - 3, -2000, 2000, 500, 12, 3, ang);
    this.labels(g, x, y, r - 23, [-2000, -1500, -1000, -500, 0, 500, 1000, 1500, 2000], ang, 12, (v) => String(Math.abs(v / 100)));
    this.caption(g, x + 10, y - 22, 'UP');
    this.caption(g, x + 10, y + 22, 'DOWN');
    this.caption(g, x + 18, y, 'FPM x100', 8);
    this.needle(g, x, y, ang(fpm), r - 8, 6);
    this.hub(g, x, y);
    this.glass(g, x, y, r);
  }

  /** Tachometer (engine RPM). */
  tach(g, x, y, r, rpm) {
    this.face(g, x, y, r);
    const ang = (v) => -125 + (clamp(v, 0, 3500) / 3500) * 250;
    this.arc(g, x, y, r - 7, ang(2100), ang(2700), '#2fbf4a', 6);
    this.ticks(g, x, y, r - 3, 2700, 2700, 1, 14, 4, ang, '#e0302a');
    this.ticks(g, x, y, r - 3, 0, 3500, 100, 6, 1.5, ang);
    this.ticks(g, x, y, r - 3, 0, 3500, 500, 12, 3, ang);
    this.labels(g, x, y, r - 23, [0, 5, 10, 15, 20, 25, 30, 35], (v) => ang(v * 100), 12);
    this.caption(g, x, y + 18, 'RPM x100');
    g.fillStyle = '#000';
    g.fillRect(x - 20, y + 28, 40, 13);
    g.fillStyle = this.ink;
    g.font = '10px Consolas, monospace';
    g.textAlign = 'center';
    g.fillText(String(Math.round(rpm)).padStart(4, '0'), x, y + 35);
    this.needle(g, x, y, ang(rpm), r - 8, 6);
    this.hub(g, x, y);
    this.glass(g, x, y, r);
  }

  /** Accelerometer (g-meter) with max / min memory needles. */
  gMeter(g, x, y, r, gl) {
    this.face(g, x, y, r);
    const ang = (v) => -135 + ((clamp(v, -3, 7) + 3) / 10) * 270;
    this.arc(g, x, y, r - 7, ang(-1.5), ang(4.4), '#2fbf4a', 5);
    this.arc(g, x, y, r - 7, ang(4.4), ang(6), '#e6c21e', 5);
    this.ticks(g, x, y, r - 3, 6, 6, 1, 14, 4, ang, '#e0302a');
    this.ticks(g, x, y, r - 3, -3, 7, 0.5, 6, 1.5, ang);
    this.ticks(g, x, y, r - 3, -3, 7, 1, 12, 3, ang);
    this.labels(g, x, y, r - 23, [-2, 0, 2, 4, 6], ang, 12);
    this.caption(g, x, y + 22, 'G');
    this.needle(g, x, y, ang(this.gMax), r - 12, 3, '#ff9a2a', 0);
    this.needle(g, x, y, ang(this.gMin), r - 12, 3, '#ff9a2a', 0);
    this.needle(g, x, y, ang(gl), r - 8, 6);
    this.hub(g, x, y);
    this.glass(g, x, y, r);
  }

  /** Warning / status lights. */
  annunciators(g, x, y, f, extra) {
    const w = 82, h = 30, gap = 8;
    const lights = [
      ['STALL', f.stallWarning, '#ff3b30'],
      ['OVERSPEED', f.ias * KT > PLANE.vno + 20, '#ff3b30'],
      ['PARK BRK', f.parkingBrake, '#ffb020'],
      ['BRAKES', f.brakes > 0.05 && !f.parkingBrake, '#ffb020'],
      ['AUTO RUD', !!extra.autoRudder, '#3ddc84'],
      ['LOW ALT', !!extra.lowAlt, '#ffb020'],
    ];
    lights.forEach(([label, on, color], i) => {
      const lx = x + (i % 2) * (w + gap), ly = y + Math.floor(i / 2) * (h + gap);
      g.fillStyle = '#0d0e10';
      roundRect(g, lx - 2, ly - 2, w + 4, h + 4, 5);
      g.fill();
      g.fillStyle = on ? color : '#22252a';
      roundRect(g, lx, ly, w, h, 4);
      g.fill();
      g.fillStyle = on ? '#111' : '#555a63';
      g.font = 'bold 12px Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, lx + w / 2, ly + h / 2 + 1);
    });
    // Landing gear: three lights (green = down and locked, red = in transit)
    const gy = y + 3 * (h + gap) + 4;
    this.caption(g, x + 24, gy + 10, 'GEAR', 11);
    const gearState = extra.gearMoving ? '#ff3b30' : f.gearDown ? '#3ddc84' : '#22252a';
    for (let k = 0; k < 3; k++) {
      g.fillStyle = '#0d0e10';
      g.beginPath();
      g.arc(x + 70 + k * 30, gy + 10, 10, 0, TAU);
      g.fill();
      g.fillStyle = gearState;
      g.beginPath();
      g.arc(x + 70 + k * 30, gy + 10, 7.5, 0, TAU);
      g.fill();
    }
  }

  /** Vertical scale with a pointer; used for flaps, trim and throttle. */
  scale(g, x, y, title, marks, t, color = '#ff9a2a', target = null) {
    const h = 110;
    g.fillStyle = '#0d0e10';
    roundRect(g, x, y, 54, h + 26, 6);
    g.fill();
    this.caption(g, x + 27, y + 10, title, 10);
    const top = y + 22, bot = y + 18 + h - 6;
    g.strokeStyle = this.ink;
    g.lineWidth = 1.5;
    g.font = '10px Arial, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const [v, label] of marks) {
      const yy = top + (bot - top) * v;
      g.beginPath();
      g.moveTo(x + 32, yy);
      g.lineTo(x + 42, yy);
      g.stroke();
      g.fillStyle = this.ink;
      g.fillText(label, x + 29, yy);
    }
    if (target !== null) {
      const yy = top + (bot - top) * target;
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.strokeRect(x + 42, yy - 4, 8, 8);
    }
    const yy = top + (bot - top) * clamp(t, 0, 1);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x + 42, yy);
    g.lineTo(x + 51, yy - 6);
    g.lineTo(x + 51, yy + 6);
    g.fill();
  }

  flapsIndicator(g, x, y, flaps, target) {
    this.scale(g, x, y, 'FLAPS', [[0, 'UP'], [1 / 3, '10'], [2 / 3, '20'], [1, '30']], flaps, '#ff9a2a', target);
  }

  trimIndicator(g, x, y, trim) {
    // Top = nose down, bottom = nose up (like a trim wheel)
    this.scale(g, x, y, 'TRIM', [[0, 'DN'], [0.5, '—'], [1, 'UP']], 0.5 + trim * 0.5, '#3ddc84');
  }

  throttleIndicator(g, x, y, thr) {
    this.scale(g, x, y, 'THR', [[0, 'FULL'], [0.5, '50'], [1, 'IDLE']], 1 - thr, '#5fd8ff');
  }

  /** Small digital display: ground speed, true airspeed, wind, outside air temperature. */
  readout(g, x, y, f, extra) {
    const w = 236, h = 128;
    g.fillStyle = '#05070a';
    roundRect(g, x, y, w, h, 6);
    g.fill();
    g.strokeStyle = '#3a3f48';
    g.lineWidth = 2;
    g.stroke();
    const oat = Math.round(extra.oat ?? 15);
    const rows = [
      ['GS', `${Math.round(f.groundSpeed * KT)} KT`],
      ['TAS', `${Math.round(f.tas * KT)} KT`],
      ['WIND', extra.windText ?? 'CALM'],
      ['AGL', `${Math.max(0, Math.round((f.agl - 1.5) * FT))} FT`],
      ['OAT', `${oat}°C`],
    ];
    g.font = '15px Consolas, monospace';
    g.textBaseline = 'middle';
    rows.forEach(([k, v], i) => {
      const yy = y + 16 + i * 24;
      g.textAlign = 'left';
      g.fillStyle = '#4fd1ff';
      g.fillText(k, x + 12, yy);
      g.textAlign = 'right';
      g.fillStyle = '#e7f6ff';
      g.fillText(v, x + w - 12, yy);
    });
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
