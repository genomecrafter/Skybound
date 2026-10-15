import * as THREE from 'three';

/**
 * Head-up display: HTML elements layered over the WebGL canvas, plus two small
 * 2D canvases for the attitude indicator and the heading tape.
 *
 * Text is refreshed at 15 Hz (changing DOM text every frame is wasteful);
 * the instruments and the ring marker are redrawn every frame so they move
 * smoothly.
 *
 * The NEXT-RING MARKER transforms the ring's 3D position into camera space
 * (view matrix) and then by the projection matrix into normalised device
 * coordinates (-1..1), exactly what the GPU does for every vertex.
 * If the ring is behind the camera or off-screen, the marker is clamped to
 * the screen edge and becomes an arrow pointing toward it.
 */
const _v = new THREE.Vector3();

export class HUD {
  constructor(root) {
    const el = (this.root = document.createElement('div'));
    el.className = 'hud';
    el.innerHTML = `
      <div class="hud-panel hud-route">
        <div class="hud-route-name"></div>
        <div class="hud-row"><span class="hud-label">RINGS</span><span class="hud-rings">0 / 0</span></div>
        <div class="hud-row"><span class="hud-label">TIME</span><span class="hud-time">0:00</span></div>
      </div>
      <canvas class="hud-heading" width="360" height="40"></canvas>
      <div class="hud-panel hud-speed">
        <div class="hud-label">SPEED</div>
        <div class="hud-big"><span class="hud-spd">0</span><small> km/h</small></div>
        <div class="hud-label">THROTTLE <span class="hud-thr-val"></span></div>
        <div class="hud-bar"><div class="hud-bar-fill"></div></div>
        <div class="hud-label hud-boost-label">BOOST</div>
        <div class="hud-bar boost"><div class="hud-boost-fill"></div></div>
      </div>
      <div class="hud-center">
        <canvas class="hud-attitude" width="150" height="150"></canvas>
        <div class="hud-gear">GEAR DOWN</div>
      </div>
      <div class="hud-panel hud-alt">
        <div class="hud-label">ALTITUDE</div>
        <div class="hud-big"><span class="hud-altv">0</span><small> m</small></div>
        <div class="hud-row"><span class="hud-label">AGL</span><span class="hud-agl">0</span></div>
        <div class="hud-row"><span class="hud-label">V/S</span><span class="hud-vs">0</span></div>
      </div>
      <div class="hud-marker"><div class="hud-marker-shape"></div><div class="hud-marker-dist"></div></div>
      <div class="hud-warning"></div>
      <div class="hud-approach"></div>
      <div class="hud-fps"></div>
      <div class="hud-status"></div>`;
    root.append(el);

    const q = (s) => el.querySelector(s);
    this.e = {
      routeName: q('.hud-route-name'), rings: q('.hud-rings'), time: q('.hud-time'),
      spd: q('.hud-spd'), boostFill: q('.hud-boost-fill'), boostLabel: q('.hud-boost-label'), thrVal: q('.hud-thr-val'), thrFill: q('.hud-bar-fill'),
      gear: q('.hud-gear'), alt: q('.hud-altv'), agl: q('.hud-agl'), vs: q('.hud-vs'),
      marker: q('.hud-marker'), markerShape: q('.hud-marker-shape'), markerDist: q('.hud-marker-dist'),
      warning: q('.hud-warning'), fps: q('.hud-fps'), approach: q('.hud-approach'), status: q('.hud-status'),
    };
    this.att = q('.hud-attitude').getContext('2d');
    this.hdg = q('.hud-heading').getContext('2d');
    this.fps = 60;
    this.textTimer = 0;
  }

  setVisible(v) {
    this.root.style.display = v ? '' : 'none';
  }

  /**
   * @param {number} dt
   * @param {object} d { flight, agl, gearMoving, routeName, rings, elapsed, camera, warning }
   */
  update(dt, d) {
    const f = d.flight;
    const att = f.getAttitude();
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    this.drawAttitude(att);
    // Boost bar updates every frame (it drains visibly)
    this.e.boostFill.style.transform = `scaleX(${d.boost ?? 1})`;
    this.e.boostLabel.classList.toggle('active', !!d.boosting);
    this.drawHeading(att.heading);
    this.updateMarker(d);

    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 1 / 15;

    const e = this.e;
    e.routeName.textContent = d.routeName;
    e.rings.textContent = d.rings ? `${d.rings.collected} / ${d.rings.total}` : '-';
    const s = Math.floor(d.elapsed);
    e.time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    e.spd.textContent = (f.speed * 3.6).toFixed(0);
    e.thrVal.textContent = `${Math.round(f.throttle * 100)}%`;
    e.thrFill.style.transform = `scaleX(${f.throttle})`;
    e.alt.textContent = f.position.y.toFixed(0);
    e.agl.textContent = `${Math.max(0, d.agl).toFixed(0)} m`;
    e.vs.textContent = `${f.velocity.y >= 0 ? '+' : ''}${f.velocity.y.toFixed(1)} m/s`;

    e.gear.textContent = d.gearMoving ? 'GEAR TRANSIT' : f.gearDown ? 'GEAR DOWN' : 'GEAR UP';
    e.gear.dataset.state = d.gearMoving ? 'moving' : f.gearDown ? 'down' : 'up';

    this.updateApproach(d.approach);
    e.status.textContent = `${d.cockpit ? 'COCKPIT VIEW' : 'CHASE VIEW'} · ${d.muted ? '🔇 MUTED (M)' : '🔊 M = mute'}`;
    e.warning.textContent = d.warning ?? '';
    e.warning.classList.toggle('show', !!d.warning);
    e.fps.textContent = `${this.fps.toFixed(0)} FPS · ${Math.round((d.resScale ?? 1) * 100)}% res`;
  }

  /**
   * Landing aid shown on final approach: distance to the runway, height,
   * and whether the aircraft is on the 3° glide slope (like a real PAPI).
   */
  updateApproach(a) {
    const el = this.e.approach;
    if (!a) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    if (a.rolling) {
      el.innerHTML = `<b>ROLLOUT</b> ${Math.round(a.speed * 3.6)} km/h · throttle idle = brakes`;
      return;
    }
    const slope = a.angle > 3.7 ? 'HIGH ▼' : a.angle < 2.3 ? 'LOW ▲' : 'ON SLOPE ●';
    const cls = a.angle > 3.7 || a.angle < 2.3 ? 'warn' : 'ok';
    const dist = a.dist > 1000 ? `${(a.dist / 1000).toFixed(1)} km` : `${Math.round(a.dist)} m`;
    const lineup = Math.abs(a.across) < 8 ? 'CENTRED' : a.across > 0 ? 'RUNWAY ◀' : 'RUNWAY ▶';
    el.innerHTML =
      `<b>RWY ${a.name ?? '36'}</b> ${dist} · ${Math.round(a.height)} m · <span class="${cls}">${slope}</span> · ${lineup} · ` +
      `<span class="${a.gearDown ? 'ok' : 'warn'}">${a.gearDown ? 'GEAR ✓' : 'GEAR ✗'}</span>`;
  }

  /** Artificial horizon: rotate by -bank, shift by pitch, draw sky/ground + pitch ladder. */
  drawAttitude({ pitch, bank }) {
    const g = this.att;
    const W = 150, R = 70, cx = W / 2, cy = W / 2;
    const pxPerDeg = 2.2;
    g.clearRect(0, 0, W, W);
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.clip();

    g.translate(cx, cy);
    g.rotate((-bank * Math.PI) / 180);
    g.translate(0, pitch * pxPerDeg);
    g.fillStyle = 'rgba(70, 140, 220, 0.75)';
    g.fillRect(-200, -400, 400, 400);
    g.fillStyle = 'rgba(140, 95, 55, 0.75)';
    g.fillRect(-200, 0, 400, 400);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-200, 0);
    g.lineTo(200, 0);
    g.stroke();
    // Pitch ladder every 10°
    g.lineWidth = 1;
    g.font = '9px Consolas, monospace';
    g.fillStyle = '#fff';
    for (let p = -60; p <= 60; p += 10) {
      if (p === 0) continue;
      const y = -p * pxPerDeg;
      const w = p % 20 === 0 ? 22 : 12;
      g.beginPath();
      g.moveTo(-w, y);
      g.lineTo(w, y);
      g.stroke();
      if (p % 20 === 0) g.fillText(String(Math.abs(p)), w + 3, y + 3);
    }
    g.restore();

    // Fixed aircraft symbol + bezel
    g.strokeStyle = '#ffd34d';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - 30, cy);
    g.lineTo(cx - 10, cy);
    g.lineTo(cx, cy + 8);
    g.lineTo(cx + 10, cy);
    g.lineTo(cx + 30, cy);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
  }

  /** Scrolling compass tape. */
  drawHeading(hdg) {
    const g = this.hdg;
    const W = 360, H = 40, pxPerDeg = 3;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#fff';
    g.fillStyle = '#fff';
    g.font = '12px Consolas, monospace';
    g.textAlign = 'center';
    const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    const start = Math.floor((hdg - 60) / 5) * 5;
    for (let a = start; a <= hdg + 60; a += 5) {
      const x = W / 2 + (a - hdg) * pxPerDeg;
      const n = ((a % 360) + 360) % 360;
      const major = n % 30 === 0;
      g.beginPath();
      g.moveTo(x, H);
      g.lineTo(x, H - (major ? 12 : 6));
      g.stroke();
      if (major) g.fillText(names[n] ?? String(n / 10).padStart(2, '0'), x, 15);
    }
    g.fillStyle = '#ffd34d';
    g.beginPath();
    g.moveTo(W / 2 - 6, H);
    g.lineTo(W / 2 + 6, H);
    g.lineTo(W / 2, H - 9);
    g.fill();
  }

  updateMarker(d) {
    const m = this.e.marker;
    const ring = d.rings?.nextRing;
    if (!ring || !d.camera) {
      m.style.display = 'none';
      return;
    }
    m.style.display = '';
    // Ring position in CAMERA space: x right, y up, -z forward
    _v.copy(ring.center).applyMatrix4(d.camera.matrixWorldInverse);
    const behind = _v.z > 0;
    let x, y;
    if (behind) {
      // Behind us: just point toward its side of the screen
      x = _v.x;
      y = Math.abs(_v.x) + Math.abs(_v.y) < 1e-3 ? -1 : _v.y;
    } else {
      _v.applyMatrix4(d.camera.projectionMatrix); // -> normalised device coords
      x = _v.x;
      y = _v.y;
    }
    const margin = 0.88;
    const off = behind || Math.abs(x) > margin || Math.abs(y) > margin;
    if (off) {
      // Push the point onto the screen border along the same direction
      const k = margin / Math.max(Math.abs(x), Math.abs(y), 1e-6);
      x *= k;
      y *= k;
    }
    const sx = (x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-y * 0.5 + 0.5) * window.innerHeight;
    const angle = Math.atan2(-y, x) * (180 / Math.PI) + 90;
    m.style.transform = `translate(${sx}px, ${sy}px)`;
    m.classList.toggle('off', off);
    this.e.markerShape.style.transform = off ? `rotate(${angle}deg)` : 'rotate(45deg)';
    this.e.markerDist.textContent = `${Math.round(d.flight.position.distanceTo(ring.center))} m`;
  }
}
