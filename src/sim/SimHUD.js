import { Instruments, PANEL_W, PANEL_H } from './Instruments.js';
import { KT } from './SimFlightModel.js';
import { clamp } from '../utils/math.js';

const FT = 3.28084;
const TAU = Math.PI * 2;

/**
 * Simulator heads-up display (HTML over the 3D view):
 *  - instructor box (scenario, current step, target heading / altitude / speed)
 *  - data strip (airspeed, altitude, vertical speed, heading, power, flaps, trim)
 *  - MOVING MAP: north-up 2D map centred on the aircraft (runway, traffic
 *    pattern, flown track, wind arrow). World x/z map to screen x/y with one
 *    scale factor: a 2D orthographic projection seen from above.
 *  - ILS-style needles: localiser (left/right of the centre-line) and glide
 *    slope (above/below 3°), computed from the angles to the runway.
 *  - instrument panel overlay (H), warnings, mouse-yoke position.
 */
export class SimHUD {
  constructor(root) {
    const el = (this.root = document.createElement('div'));
    el.className = 'hud sim-hud';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="hud-panel sim-brief">
        <div class="sim-title"></div>
        <div class="sim-place"></div>
        <div class="sim-step"></div>
        <div class="sim-target"></div>
      </div>
      <div class="sim-strip"></div>
      <div class="sim-side">
        <canvas class="sim-map" width="200" height="200"></canvas>
        <canvas class="sim-ils" width="200" height="120"></canvas>
      </div>
      <div class="sim-warning"></div>
      <div class="sim-yoke"><div class="sim-yoke-dot"></div></div>
      <canvas class="sim-panel"></canvas>
      <div class="sim-keys">Arrows / WASD elevator + ailerons · Q/E rudder · Shift/Ctrl or wheel throttle · F/V flaps · [ ] trim · Space brakes · P parking brake · G gear · Y mouse yoke · H panel · C view</div>
      <div class="hud-fps"></div>
      <div class="hud-status"></div>`;
    root.append(el);
    const q = (s) => el.querySelector(s);
    this.e = {
      title: q('.sim-title'), place: q('.sim-place'), step: q('.sim-step'), target: q('.sim-target'),
      strip: q('.sim-strip'), warning: q('.sim-warning'), yoke: q('.sim-yoke'), yokeDot: q('.sim-yoke-dot'),
      fps: q('.hud-fps'), status: q('.hud-status'), keys: q('.sim-keys'), ils: q('.sim-ils'),
    };
    this.map = q('.sim-map').getContext('2d');
    this.ils = this.e.ils.getContext('2d');
    this.panelCanvas = q('.sim-panel');
    this.instruments = new Instruments(this.panelCanvas);
    this.panelVisible = true;
    this.compact = true;
    this.fps = 60;
    this.textTimer = 0;
    this.panelTimer = 0;
    this.track = []; // breadcrumb trail for the map
    this.trackTimer = 0;
    this.keysTimer = 12; // the key hint fades out after a while
    window.addEventListener('resize', () => this.sizePanel());
    this.sizePanel();
  }

  /** Match the panel canvas resolution to its on-screen size (sharp on high-DPI screens). */
  sizePanel() {
    // Larger when it replaces the 3D panel (cockpit + H), smaller in chase view so the plane stays visible
    const w = this.compact ? Math.min(760, window.innerWidth * 0.56) : Math.min(980, window.innerWidth * 0.76);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.panelCanvas.style.width = `${w}px`;
    this.panelCanvas.style.height = `${(w * PANEL_H) / PANEL_W}px`;
    this.panelCanvas.width = Math.round(w * dpr);
    this.panelCanvas.height = Math.round((w * dpr * PANEL_H) / PANEL_W);
  }

  setVisible(v) {
    this.root.style.display = v ? '' : 'none';
  }

  setPanelVisible(v, compact = this.compact) {
    this.panelVisible = v;
    this.panelCanvas.style.display = v ? '' : 'none';
    if (compact !== this.compact) {
      this.compact = compact;
      this.sizePanel();
    }
  }

  reset(scenario) {
    this.track.length = 0;
    this.instruments.resetGMeter();
    this.e.title.textContent = scenario.name;
    this.e.place.textContent = scenario.place;
    this.keysTimer = 14;
    this.e.keys.style.opacity = '';
  }

  /**
   * @param {number} dt
   * @param {object} d  { flight, lesson: {step, target}, warning, runway, local, wind, yoke, cockpit, muted, resScale, night, gearMoving }
   */
  update(dt, d) {
    const f = d.flight;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    // Panel at ~30 Hz (it is the most expensive part of the HUD)
    this.panelTimer -= dt;
    if (this.panelVisible && this.panelTimer <= 0) {
      this.panelTimer = 1 / 30;
      this.instruments.draw(f, d.instruments);
    }

    this.trackTimer -= dt;
    if (this.trackTimer <= 0) {
      this.trackTimer = 1;
      this.track.push(f.position.x, f.position.z);
      if (this.track.length > 600) this.track.splice(0, 2);
    }
    this.drawMap(f, d);
    this.drawIls(d.approach);

    // Mouse-yoke position marker
    this.e.yoke.style.display = d.yoke ? '' : 'none';
    if (d.yoke) this.e.yokeDot.style.transform = `translate(${d.yoke.x * 40}px, ${d.yoke.y * 40}px)`;

    if (this.keysTimer > 0) {
      this.keysTimer -= dt;
      if (this.keysTimer <= 0) this.e.keys.style.opacity = '0';
    }

    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 1 / 10;

    const e = this.e;
    const att = f.getAttitude();
    const fpm = f.vsi * FT * 60;
    const flapDeg = Math.round(f.flaps * 30);
    const trim = f.trim;
    const cells = [
      ['IAS', `${Math.round(f.ias * KT)} KT`],
      ['ALT', `${Math.round(f.position.y * FT)} FT`],
      ['V/S', `${fpm >= 0 ? '+' : ''}${Math.round(fpm / 10) * 10}`],
      ['HDG', String(Math.round(att.heading) % 360 || 360).padStart(3, '0')],
      ['PWR', `${Math.round(f.throttle * 100)}% · ${Math.round(f.rpm / 10) * 10} RPM`],
      ['FLAPS', flapDeg ? `${flapDeg}°` : 'UP'],
      ['TRIM', `${trim >= 0 ? 'UP' : 'DN'} ${Math.abs(Math.round(trim * 100))}`],
    ];
    e.strip.innerHTML = cells.map(([k, v]) => `<span><i>${k}</i>${v}</span>`).join('');

    e.step.innerHTML = d.lesson?.step ?? '';
    e.target.innerHTML = d.lesson?.target ?? '';
    e.target.style.display = d.lesson?.target ? '' : 'none';

    e.warning.textContent = d.warning?.text ?? '';
    e.warning.className = `sim-warning${d.warning ? ` show ${d.warning.level ?? ''}` : ''}`;

    e.fps.textContent = `${this.fps.toFixed(0)} FPS · ${Math.round((d.resScale ?? 1) * 100)}% res`;
    const ctrl = d.yoke ? 'MOUSE YOKE' : d.gamepad ? 'GAMEPAD' : 'KEYBOARD';
    e.status.textContent = `${d.cockpit ? 'COCKPIT' : 'CHASE'} VIEW · ${ctrl} · ${d.muted ? '🔇 MUTED (M)' : '🔊 M = mute'}`;
  }

  /** North-up moving map, 2.5 km radius. */
  drawMap(f, d) {
    const g = this.map;
    const S = 200, c = S / 2, R = 96;
    const scale = R / 2500; // pixels per metre
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath();
    g.arc(c, c, R, 0, TAU);
    g.fillStyle = 'rgba(6, 12, 22, 0.62)';
    g.fill();
    g.clip();
    const px = (x) => c + (x - f.position.x) * scale;
    const py = (z) => c + (z - f.position.z) * scale; // north (-z) is up

    // Range rings (1 km)
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    g.lineWidth = 1;
    for (const r of [1000, 2000]) {
      g.beginPath();
      g.arc(c, c, r * scale, 0, TAU);
      g.stroke();
    }

    const rw = d.runway;
    if (rw) {
      const { center, dir, length, width } = rw;
      const sx = -dir.z, sz = dir.x;
      const hl = length / 2, hw = width / 2;
      // Traffic pattern (left-hand) for the circuit lesson
      if (d.showPattern) {
        const pt = (along, across) => [px(center.x + dir.x * (along - hl) + sx * across), py(center.z + dir.z * (along - hl) + sz * across)];
        const corners = [pt(-900, 0), pt(length + 700, 0), pt(length + 700, -900), pt(-900, -900)];
        g.setLineDash([5, 5]);
        g.strokeStyle = 'rgba(95, 216, 255, 0.55)';
        g.lineWidth = 1.5;
        g.beginPath();
        corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.stroke();
        g.setLineDash([]);
      }
      // Extended centre-line
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.beginPath();
      g.moveTo(px(center.x - dir.x * (hl + 3000)), py(center.z - dir.z * (hl + 3000)));
      g.lineTo(px(center.x - dir.x * hl), py(center.z - dir.z * hl));
      g.stroke();
      // Runway (drawn as a thick line so it stays visible at this scale)
      g.strokeStyle = '#f0f0f0';
      g.lineWidth = Math.max(hw * 2 * scale, 4);
      g.beginPath();
      g.moveTo(px(center.x - dir.x * hl), py(center.z - dir.z * hl));
      g.lineTo(px(center.x + dir.x * hl), py(center.z + dir.z * hl));
      g.stroke();
    }

    // Flown track
    const t = this.track;
    if (t.length >= 4) {
      g.strokeStyle = 'rgba(255, 211, 77, 0.55)';
      g.lineWidth = 1.5;
      g.beginPath();
      for (let i = 0; i < t.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, px(t[i]), py(t[i + 1]));
      g.lineTo(c, c);
      g.stroke();
    }
    g.restore();

    // Aircraft symbol (rotated to the heading)
    const hdg = (f.getAttitude().heading * Math.PI) / 180;
    g.save();
    g.translate(c, c);
    g.rotate(hdg);
    g.fillStyle = '#ffd34d';
    g.beginPath();
    g.moveTo(0, -9);
    g.lineTo(6, 7);
    g.lineTo(0, 3);
    g.lineTo(-6, 7);
    g.closePath();
    g.fill();
    g.restore();

    // Bezel, north mark, wind arrow
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(c, c, R, 0, TAU);
    g.stroke();
    g.fillStyle = '#fff';
    g.font = 'bold 12px Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', c, 12);
    if (d.wind && d.wind.speed > 0.3) {
      // Arrow shows where the wind blows TO, from the top-left corner
      const a = Math.atan2(d.wind.dir.x, -d.wind.dir.z);
      g.save();
      g.translate(24, 24);
      g.rotate(a);
      g.strokeStyle = '#5fd8ff';
      g.fillStyle = '#5fd8ff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, 10);
      g.lineTo(0, -6);
      g.stroke();
      g.beginPath();
      g.moveTo(0, -12);
      g.lineTo(-5, -4);
      g.lineTo(5, -4);
      g.fill();
      g.restore();
      g.fillStyle = '#5fd8ff';
      g.font = '10px Consolas, monospace';
      g.fillText(`${Math.round(d.wind.speed * KT)}KT`, 24, 46);
    }
  }

  /**
   * ILS-style approach indicator. a = { locDev (deg, + = runway to the right),
   * gsDev (deg, + = aircraft above the 3° path), dist (m) } or null.
   */
  drawIls(a) {
    const g = this.ils;
    const W = 200, H = 120;
    g.clearRect(0, 0, W, H);
    this.e.ils.style.display = a ? '' : 'none';
    if (!a) return;
    g.fillStyle = 'rgba(6, 12, 22, 0.62)';
    g.beginPath();
    g.roundRect?.(0, 0, W, H, 10);
    if (!g.roundRect) g.rect(0, 0, W, H);
    g.fill();
    const cx = 92, cy = 62, span = 52;
    // Dots
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = 1.5;
    for (let k = -2; k <= 2; k++) {
      if (!k) continue;
      g.beginPath();
      g.arc(cx + (k * span) / 2, cy, 3.5, 0, TAU);
      g.stroke();
      g.beginPath();
      g.arc(cx, cy + (k * span) / 2 * 0.8, 3.5, 0, TAU);
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    g.strokeRect(cx - 8, cy - 8, 16, 16);
    // Localiser: full scale = 2.5° ; glide slope: full scale = 0.7°
    const lx = cx + clamp(a.locDev / 2.5, -1.15, 1.15) * span;
    const gy = cy + clamp(a.gsDev / 0.7, -1.15, 1.15) * span * 0.8;
    g.strokeStyle = '#ff5fd0';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(lx, cy - span * 0.9);
    g.lineTo(lx, cy + span * 0.9);
    g.moveTo(cx - span * 1.05, gy);
    g.lineTo(cx + span * 1.05, gy);
    g.stroke();
    g.fillStyle = '#fff';
    g.font = '11px Consolas, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(`${(a.dist / 1852).toFixed(1)} NM`, 152, 8);
    g.fillText('ILS', 8, 8);
    g.fillText('G/S', 160, 54);
    g.fillText('LOC', 8, 104);
  }
}
