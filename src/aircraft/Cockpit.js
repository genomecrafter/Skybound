import * as THREE from 'three';

/**
 * Cockpit interior of the aircraft, modelled for the first-person view.
 *
 * Layout: a two-seat side-by-side trainer under a bubble canopy (think
 * Diamond DA20 / Grob 115). The pilot sits in the LEFT seat, the "six-pack"
 * of flight instruments is straight ahead of them.
 *
 *   canopy (ellipsoid) ─┬─ windscreen bow  (arch, TubeGeometry along an ellipse)
 *                       ├─ rear bow, canopy rails (tubes along the rim)
 *                       ├─ roof            (strip of the ellipsoid: paint outside, headliner inside)
 *                       └─ inner glass     (BackSide shell + canvas tint/dust map)
 *   glare shield        custom BufferGeometry: a parametric surface
 *                       y = top(v) - drop * u^8  (flat in the middle, rounded shoulders)
 *   instrument panel    ShapeGeometry with the same curved top edge, painted
 *                       canvas (switches, breakers, avionics) + live gauge plane
 *   yokes               hierarchical: column (TRANSLATION = pitch) > wheel (ROTATION = roll)
 *   throttle quadrant   levers rotate with throttle
 *   compass             card counter-rotates with the aircraft heading
 *
 * Coordinates are aircraft space (nose -Z, up +Y, right +X), same as AircraftModel.
 */

// Canopy ellipsoid (shared with AircraftModel so the glass, frame and
// fuselage cut-out all agree): centre and semi-axes.
export const CANOPY = { y: 0.42, z: -0.72, a: 0.495, b: 0.69, c: 1.155 };
/** Pilot's eye point (left seat), used by the CameraRig. */
export const PILOT_EYE = new THREE.Vector3(-0.22, 0.86, -0.38);
export const PILOT_X = PILOT_EYE.x;

const PANEL = { w: 0.46, top: 0.7, bottom: 0.28, z: -1.0, drop: 0.25 };
// Instrument (gauge texture) rectangle on the panel, 1024 x 320 aspect
const GAUGES = { w: 0.8, h: 0.25, y: 0.5 };

/** Height of the glare-shield lip / panel top edge across the cockpit. */
const lipY = (x) => PANEL.top - PANEL.drop * (x / PANEL.w) ** 8;

/** Half-width and height of the canopy cross-section at station z (inset a little). */
function canopySection(z, inset = 0.985) {
  const k = Math.sqrt(Math.max(1 - ((z - CANOPY.z) / CANOPY.c) ** 2, 0)) * inset;
  return { hw: CANOPY.a * k, h: CANOPY.b * k };
}

/** Frame arch over the canopy at station z (windscreen bow / rear bow). */
function bowGeometry(z, radius) {
  const { hw, h } = canopySection(z);
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / 24;
    pts.push(new THREE.Vector3(hw * Math.sin(t), CANOPY.y + h * Math.cos(t), z));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, radius, 8, false);
}

function canvasTexture(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  paint(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Fine random speckle so flat painted surfaces don't look like plastic. */
function grain(g, w, h, n, alpha) {
  for (let i = 0; i < n; i++) {
    const l = Math.random() < 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${l},${l},${l},${Math.random() * alpha})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
  }
}

// ------------------------------------------------------------ textures --

/**
 * Inner canopy glass: almost clear, a little darker toward the frame (the
 * glass is seen at a grazing angle there), soft sky reflections and dust.
 * Sphere UVs: u = around the vertical axis (0.75 = straight ahead), v = 1 at the top.
 */
function makeGlassTexture() {
  return canvasTexture(1024, 256, (g, W, H) => {
    g.fillStyle = 'rgba(205,222,238,0.075)';
    g.fillRect(0, 0, W, H);
    const edge = g.createLinearGradient(0, H * 0.55, 0, H);
    edge.addColorStop(0, 'rgba(70,90,110,0)');
    edge.addColorStop(1, 'rgba(45,55,68,0.22)');
    g.fillStyle = edge;
    g.fillRect(0, 0, W, H);
    // Broad diagonal reflection streaks on the windscreen and the sides
    for (const [x, wdt, a] of [[690, 50, 0.12], [765, 20, 0.09], [835, 80, 0.07], [180, 60, 0.07], [420, 50, 0.07]]) {
      const s = g.createLinearGradient(x - wdt, 0, x + wdt, 0);
      s.addColorStop(0, 'rgba(255,255,255,0)');
      s.addColorStop(0.5, `rgba(255,255,255,${a})`);
      s.addColorStop(1, 'rgba(255,255,255,0)');
      g.save();
      g.transform(1, 0, -0.35, 1, 0, 0);
      g.fillStyle = s;
      g.fillRect(x - wdt, 0, wdt * 2 + 120, H);
      g.restore();
    }
    // Faint reflection of the glare shield low on the windscreen
    const refl = g.createLinearGradient(0, H * 0.6, 0, H * 0.9);
    refl.addColorStop(0, 'rgba(140,150,165,0)');
    refl.addColorStop(1, 'rgba(140,150,165,0.12)');
    g.fillStyle = refl;
    g.fillRect(W * 0.62, H * 0.6, W * 0.26, H * 0.3);
    // Dust specks and fine scratches
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(235,235,225,${0.05 + Math.random() * 0.12})`;
      g.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random(), 1 + Math.random());
    }
    g.lineWidth = 0.6;
    for (let i = 0; i < 25; i++) {
      g.strokeStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.05})`;
      const x = Math.random() * W, y = Math.random() * H;
      g.beginPath();
      g.arc(x, y, 20 + Math.random() * 60, Math.random() * 6, Math.random() * 6 + 0.6);
      g.stroke();
    }
  });
}

/**
 * Painted panel around the gauges: switch row, ignition key, circuit
 * breakers, avionics display, vents and placards. Canvas spans the panel's
 * bounding box x [-w, w], y [bottom, top].
 */
function makePanelTexture() {
  const W = 1024, H = 512;
  const px = (x) => ((x + PANEL.w) / (2 * PANEL.w)) * W;
  const py = (y) => ((PANEL.top - y) / (PANEL.top - PANEL.bottom)) * H;
  return canvasTexture(W, H, (g) => {
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#30343b');
    bg.addColorStop(1, '#24272c');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    grain(g, W, H, 9000, 0.06);

    // Recess and trim around the gauge insert
    const gx0 = px(-GAUGES.w / 2), gx1 = px(GAUGES.w / 2);
    const gy0 = py(GAUGES.y + GAUGES.h / 2), gy1 = py(GAUGES.y - GAUGES.h / 2);
    g.fillStyle = '#15171a';
    g.fillRect(gx0 - 8, gy0 - 8, gx1 - gx0 + 16, gy1 - gy0 + 16);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 2;
    g.strokeRect(gx0 - 9, gy0 - 9, gx1 - gx0 + 18, gy1 - gy0 + 18);

    g.textAlign = 'center';
    g.font = 'bold 13px Arial';
    // Placards above the gauges
    g.fillStyle = '#c9ccd2';
    g.fillText('SKY-01', px(0.3), py(0.648));
    g.font = '10px Arial';
    g.fillText('MANEUVERING SPEED 106 KIAS', px(-0.22), py(0.646));

    // Rocker switch row
    const sw = ['MASTER', 'AVION', 'FUEL P', 'BCN', 'LAND', 'TAXI', 'NAV', 'STROBE', 'PITOT'];
    const swY = py(0.325);
    sw.forEach((label, i) => {
      const x = px(-0.38 + i * 0.043);
      g.fillStyle = '#0d0e10';
      g.fillRect(x - 11, swY - 16, 22, 32);
      const on = i < 2 || i === 3 || i === 6;
      g.fillStyle = on ? '#3a3d44' : '#55595f';
      g.fillRect(x - 8, swY - (on ? 13 : 2), 16, 15);
      g.fillStyle = label === 'MASTER' ? '#b8261f' : '#2f3237';
      g.fillRect(x - 8, swY - (on ? 2 : 13), 16, 15);
      g.fillStyle = '#e6e6e0';
      g.font = 'bold 9px Arial';
      g.fillText(label, x, swY - 22);
    });

    // Ignition key (left end)
    const kx = px(-0.43), ky = py(0.36);
    g.fillStyle = '#0c0d0f';
    g.beginPath();
    g.arc(kx, ky, 15, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#8b9099';
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = '#b8bcc4';
    g.fillRect(kx - 2, ky - 11, 4, 22);
    g.fillStyle = '#e6e6e0';
    g.font = 'bold 8px Arial';
    g.fillText('OFF  R  L  BOTH', kx, ky - 20);

    // Avionics: COM/NAV radio and transponder with green 7-segment-style digits
    const rx = px(0.06), ry = py(0.355);
    g.fillStyle = '#0a0b0c';
    g.fillRect(rx, ry - 26, 170, 52);
    g.fillStyle = '#121416';
    g.fillRect(rx + 6, ry - 20, 158, 40);
    g.font = 'bold 15px Courier New';
    g.textAlign = 'left';
    g.fillStyle = '#5dff7a';
    g.fillText('121.500', rx + 12, ry - 3);
    g.fillStyle = '#3aa64f';
    g.fillText('118.300', rx + 88, ry - 3);
    g.font = 'bold 9px Arial';
    g.fillStyle = '#9aa0a8';
    g.fillText('COM1 ACT    STBY', rx + 12, ry + 13);
    g.fillStyle = '#0a0b0c';
    g.fillRect(rx + 180, ry - 26, 100, 52);
    g.font = 'bold 15px Courier New';
    g.fillStyle = '#ffb347';
    g.fillText('1200', rx + 196, ry - 1);
    g.font = 'bold 9px Arial';
    g.fillStyle = '#9aa0a8';
    g.fillText('XPDR  ALT', rx + 196, ry + 15);
    g.textAlign = 'center';

    // Circuit breakers (two rows) on the right
    g.font = 'bold 7px Arial';
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 6; i++) {
        const x = px(0.33 + i * 0.022), y = py(0.38 - r * 0.045);
        g.fillStyle = '#060607';
        g.beginPath();
        g.arc(x, y, 6, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#d8d8d0';
        g.lineWidth = 1.2;
        g.stroke();
        g.fillStyle = '#c9ccd2';
        g.fillText(String(5 + ((i * 3 + r * 7) % 20)), x, y - 9);
      }
    }

    // Round "eyeball" air vents in the panel corners
    for (const x of [-0.43, 0.43]) {
      const cx = px(x), cy = py(0.47);
      g.fillStyle = '#0b0c0e';
      g.beginPath();
      g.arc(cx, cy, 17, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#5a5f68';
      g.lineWidth = 3;
      g.stroke();
      g.strokeStyle = '#1e2024';
      g.lineWidth = 2;
      for (let k = -2; k <= 2; k++) {
        g.beginPath();
        g.moveTo(cx - 12, cy + k * 5);
        g.lineTo(cx + 12, cy + k * 5);
        g.stroke();
      }
    }
  });
}

/** Glare shield: matte anti-glare paint with a hint of texture. */
function makeShieldTexture() {
  return canvasTexture(256, 256, (g, W, H) => {
    g.fillStyle = '#25272b';
    g.fillRect(0, 0, W, H);
    grain(g, W, H, 4000, 0.08);
  });
}

/** Compass card: heading H printed at u = 1 - H/360 (see update()). */
function makeCompassTexture() {
  return canvasTexture(1024, 128, (g, W, H) => {
    g.fillStyle = '#111214';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#f2f2ea';
    g.strokeStyle = '#f2f2ea';
    g.textAlign = 'center';
    const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let hdg = 0; hdg < 360; hdg += 5) {
      const x = (1 - hdg / 360) * W;
      const major = hdg % 30 === 0;
      g.lineWidth = major ? 3 : 1.5;
      g.beginPath();
      g.moveTo(x, H);
      g.lineTo(x, H - (major ? 34 : hdg % 10 === 0 ? 24 : 14));
      g.stroke();
      if (major) {
        g.font = names[hdg] ? 'bold 44px Arial' : 'bold 36px Arial';
        const label = names[hdg] ?? String(hdg / 10);
        for (const xx of [x, x + W]) g.fillText(label, xx, H - 46); // wrap around the seam
      }
    }
  });
}

// --------------------------------------------------------------- build --

export class Cockpit {
  constructor(M) {
    this.group = new THREE.Group();
    this.group.name = 'cockpit';
    const mats = (this.mats = {
      shield: new THREE.MeshStandardMaterial({ map: makeShieldTexture(), roughness: 0.95, metalness: 0, emissive: 0x0c0d0f }),
      leather: new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.8, emissive: 0x08090a }),
      frame: new THREE.MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.5, metalness: 0.25 }),
      yoke: new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.4, metalness: 0.1 }),
      seat: new THREE.MeshStandardMaterial({ color: 0x3b3f47, roughness: 0.85 }),
      carpet: new THREE.MeshStandardMaterial({ color: 0x232428, roughness: 1 }),
      red: new THREE.MeshStandardMaterial({ color: 0xa3221b, roughness: 0.4 }),
      metal: M.metal,
    });
    const panelTex = makePanelTexture();
    mats.panel = new THREE.MeshStandardMaterial({
      map: panelTex, emissiveMap: panelTex, emissive: 0xffffff, emissiveIntensity: 0.3, roughness: 0.75, metalness: 0.1,
    });

    mats.paint = M.white;
    this.bubbleOnly = []; // chase view only (inside, the cabin shell replaces them)
    mats.headliner = new THREE.MeshStandardMaterial({ color: 0x8d8f93, roughness: 1, emissive: 0x16171a, side: THREE.BackSide });
    this.buildCanopyFrame(mats);
    this.buildRoof(mats);
    this.buildGlass();
    this.buildGlareShield(mats);
    this.buildPanel(mats);
    this.buildYokes(mats);
    this.buildPedestal(mats);
    this.buildCompass(mats);
    this.buildCabin(mats);
    this.buildCabinShell(mats);
  }

  /**
   * Solid cabin roof between the windscreen bow and the rear bow: a strip of
   * the canopy ellipsoid, parametrised by station z and the angle phi around
   * the long axis (phi = 0 at the top). Painted outside, fabric headliner
   * inside (same geometry, FrontSide / BackSide). Below the roof edges the
   * side windows stay glass.
   */
  buildRoof(mats) {
    const z0 = -1.27, z1 = 0.28, zEnd = 0.425, phi0 = 0.8, nz = 24, np = 20;
    const shell = (inset) => {
      const pos = [], idx = [];
      for (let j = 0; j <= nz; j++) {
        const z = z0 + ((zEnd - z0) * j) / nz;
        const { hw, h } = canopySection(z, inset);
        for (let i = 0; i <= np; i++) {
          const phi = -phi0 + (2 * phi0 * i) / np;
          pos.push(hw * Math.sin(phi), CANOPY.y + h * Math.cos(phi), z);
        }
      }
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < np; i++) {
          const a = j * (np + 1) + i, b = a + 1, c = a + np + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    };
    // Paint just outside the glass, headliner just inside the inner glass
    // (so neither glass layer is drawn over the roof)
    const headliner = new THREE.Mesh(shell(0.97), mats.headliner);
    this.group.add(new THREE.Mesh(shell(1.004), mats.paint), headliner);
    this.bubbleOnly.push(headliner);

    // Door-frame trim along both roof edges (top of the side windows)
    for (const s of [-1, 1]) {
      const pts = [];
      for (let j = 0; j <= nz; j++) {
        const z = z0 + ((zEnd - z0) * j) / nz;
        const { hw, h } = canopySection(z, 0.99);
        pts.push(new THREE.Vector3(s * hw * Math.sin(phi0), CANOPY.y + h * Math.cos(phi0), z));
      }
      const trim = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.012, 8, false), mats.frame);
      this.group.add(trim);
      this.bubbleOnly.push(trim);
    }
    // Dome light in the headliner
    const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.012, 20), mats.frame);
    dome.position.set(0, CANOPY.y + canopySection(-0.3).h - 0.012, -0.3);
    this.group.add(dome);
    this.bubbleOnly.push(dome);

    // Rear cabin wall closing the cabin behind the seats: the canopy section
    // above the rail, the fuselage section (inner radius) below it
    const { hw, h } = canopySection(z1, 1.01);
    const r = 0.6;
    const outline = [];
    for (let i = 0; i <= 24; i++) {
      const t = -Math.PI / 2 + (Math.PI * i) / 24;
      outline.push(hw * Math.sin(t), CANOPY.y + h * Math.cos(t));
    }
    const a0 = Math.asin(CANOPY.y / r);
    for (let i = 0; i <= 24; i++) {
      const t = a0 - ((Math.PI + 2 * a0) * i) / 24; // round the bottom to the other side
      outline.push(r * Math.cos(t), r * Math.sin(t));
    }
    // The outline is star-shaped around (0, 0.2): a triangle fan fills it
    const wallPos = [0, 0.2, 0];
    for (let i = 0; i < outline.length; i += 2) wallPos.push(outline[i], outline[i + 1], 0);
    const n = outline.length / 2, wallIdx = [];
    for (let i = 1; i <= n; i++) wallIdx.push(0, i, (i % n) + 1);
    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
    wallGeo.setIndex(wallIdx);
    wallGeo.computeVertexNormals();
    const rear = new THREE.Mesh(
      wallGeo,
      new THREE.MeshStandardMaterial({ color: 0x5a5d63, roughness: 0.95, emissive: 0x111214, side: THREE.DoubleSide }),
    );
    rear.position.z = z1 - 0.01;
    this.group.add(rear);
    this.bubbleOnly.push(rear);

    // Carpeted baggage shelf between the seat backs and the rear wall (covers
    // the painted top of the fuselage, which would otherwise show inside)
    const shelf = new THREE.Shape();
    shelf.moveTo(-0.35, 0);
    shelf.lineTo(0.35, 0);
    shelf.lineTo(0.19, -0.27);
    shelf.lineTo(-0.19, -0.27);
    shelf.closePath();
    const shelfMesh = new THREE.Mesh(new THREE.ShapeGeometry(shelf).rotateX(-Math.PI / 2), mats.carpet);
    shelfMesh.position.y = 0.64;
    this.group.add(shelfMesh);
  }

  buildCanopyFrame(mats) {
    const g = this.group;
    // Windscreen bow: the arch that frames the forward view
    g.add(new THREE.Mesh(bowGeometry(-1.27, 0.016), mats.frame));
    // Rear bow behind the seats
    const rearBow = new THREE.Mesh(bowGeometry(0.28, 0.018), mats.frame);
    g.add(rearBow);
    this.bubbleOnly.push(rearBow);
    // Canopy rail: a closed tube following the rim of the bubble
    const rim = [];
    for (let i = 0; i < 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      rim.push(new THREE.Vector3(CANOPY.a * 0.99 * Math.sin(t), CANOPY.y + 0.01, CANOPY.z + CANOPY.c * 0.99 * Math.cos(t)));
    }
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rim, true), 96, 0.02, 8, true), mats.frame));
  }

  /**
   * Inside surface of the windscreen (the part of the canopy ahead of the
   * windscreen bow): only drawn in the cockpit view. The side windows belong
   * to the cabin shell (buildCabinShell).
   */
  buildGlass() {
    const mat = new THREE.MeshPhysicalMaterial({
      map: makeGlassTexture(), transparent: true, side: THREE.BackSide, depthWrite: false,
      roughness: 0.05, metalness: 0, envMapIntensity: 0.35, color: 0xffffff,
    });
    const geo = new THREE.SphereGeometry(1, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    // Keep only the triangles ahead of the windscreen bow (index buffer edit)
    const p = geo.attributes.position, src = geo.index.array, keep = [];
    const zAt = (i) => CANOPY.z + p.getZ(i) * CANOPY.c * 0.995;
    for (let t = 0; t < src.length; t += 3) {
      if (zAt(src[t]) < -1.25 && zAt(src[t + 1]) < -1.25 && zAt(src[t + 2]) < -1.25) keep.push(src[t], src[t + 1], src[t + 2]);
    }
    geo.setIndex(keep);
    const glass = new THREE.Mesh(geo, mat);
    glass.scale.set(CANOPY.a * 0.995, CANOPY.b * 0.995, CANOPY.c * 0.995);
    glass.position.set(0, CANOPY.y, CANOPY.z);
    glass.renderOrder = 3;
    glass.visible = false;
    this.innerGlass = glass;
    this.group.add(glass);
  }

  /**
   * Glare shield: parametric surface from the padded lip over the panel
   * (v = 0) forward to the base of the windscreen (v = 1).
   */
  buildGlareShield(mats) {
    const nu = 32, nv = 8;
    const zLip = -0.97, zFront = -1.55;
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      const z = zLip + (zFront - zLip) * v;
      const w = Math.min(PANEL.w, canopySection(z, 0.97).hw / 0.97) * (1 - 0.12 * v);
      const top = PANEL.top - 0.11 * v;
      for (let i = 0; i <= nu; i++) {
        const u = (i / nu) * 2 - 1;
        pos.push(u * w, top - PANEL.drop * u ** 8 * (1 - 0.3 * v), z);
        uv.push((u + 1) / 2, v);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const shield = new THREE.Mesh(geo, mats.shield);
    this.group.add(shield);
    // Padded lip along the pilot-side edge
    const lip = [];
    for (let i = 0; i <= 32; i++) {
      const x = ((i / 32) * 2 - 1) * PANEL.w;
      lip.push(new THREE.Vector3(x, lipY(x) - 0.012, zLip + 0.012));
    }
    this.group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lip), 64, 0.022, 8, false), mats.leather));
  }

  buildPanel(mats) {
    const { w, bottom } = PANEL;
    // Outline: straight sides and bottom, curved top that follows the lip
    const shape = new THREE.Shape();
    shape.moveTo(-w, bottom);
    shape.lineTo(w, bottom);
    for (let i = 0; i <= 32; i++) {
      const x = w - (i / 32) * 2 * w;
      shape.lineTo(x, lipY(x) - 0.02);
    }
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape, 8);
    // ShapeGeometry's UVs are the raw x/y: map them onto the panel canvas
    const p = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      uv.setXY(i, (p.getX(i) + w) / (2 * w), (p.getY(i) - bottom) / (PANEL.top - bottom));
    }
    // Tilt the top away from the pilot, pivoting about the panel's centre height
    const panel = new THREE.Group();
    panel.position.set(0, 0.5, PANEL.z);
    panel.rotation.x = -0.12;
    const inner = new THREE.Group();
    inner.position.y = -0.5;
    panel.add(inner);
    inner.add(new THREE.Mesh(geo, mats.panel));

    // Live gauges (CanvasTexture swapped in by AircraftModel.setPanelTexture)
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(GAUGES.w, GAUGES.h),
      new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.6 }),
    );
    face.position.set(0, GAUGES.y, 0.004);
    inner.add(face);
    this.panelFace = face;

    // Backing box so the panel looks solid from the side / outside
    const back = new THREE.Mesh(new THREE.BoxGeometry(2 * w, PANEL.top - bottom - 0.08, 0.12), mats.leather);
    back.position.set(0, (PANEL.top + bottom) / 2 - 0.04, -0.065);
    inner.add(back);
    this.group.add(panel);
  }

  /** Two control yokes: column slides in/out (pitch), wheel turns (roll). */
  buildYokes(mats) {
    this.yokes = [];
    for (const x of [PILOT_X, -PILOT_X]) {
      const column = new THREE.Group(); // TRANSLATION along Z
      column.position.set(x, 0.385, PANEL.z + 0.03);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.3, 12).rotateX(Math.PI / 2), mats.metal);
      shaft.position.z = -0.01;
      // Rubber boot where the shaft leaves the panel
      const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.05, 14).rotateX(Math.PI / 2), mats.leather);
      boot.position.z = -0.01;
      const wheel = new THREE.Group(); // ROTATION about Z (roll)
      wheel.position.z = 0.14;
      // Ram's-horn yoke: a hub, a horizontal bar and two upturned grips
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.05, 20).rotateX(Math.PI / 2), mats.yoke);
      const badge = new THREE.Mesh(new THREE.CircleGeometry(0.03, 20), mats.red);
      badge.position.z = 0.026;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.03), mats.yoke);
      bar.position.y = 0.01;
      wheel.add(hub, badge, bar);
      for (const s of [-1, 1]) {
        const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.1, 4, 10), mats.yoke);
        grip.position.set(0.14 * s, 0.06, 0);
        grip.rotation.z = -0.15 * s;
        const button = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), mats.red);
        button.position.set(0.13 * s, 0.13, 0.008);
        wheel.add(grip, button);
      }
      column.add(shaft, boot, wheel);
      column.userData.baseZ = column.position.z;
      this.group.add(column);
      this.yokes.push({ column, wheel });
    }
  }

  /** Centre pedestal between the seats with throttle and mixture levers. */
  buildPedestal(mats) {
    const ped = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.5), mats.leather);
    ped.position.set(0, 0.2, -0.72);
    ped.rotation.x = 0.35;
    this.group.add(ped);
    this.levers = [];
    [[-0.03, 'yoke'], [0.03, 'red']].forEach(([x, m], i) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.27, -0.72);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.14, 0.012), mats.metal);
      arm.position.y = 0.07;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.022, 14, 10), mats[m]);
      knob.position.y = 0.15;
      pivot.add(arm, knob);
      this.group.add(pivot);
      this.levers.push(pivot);
      if (i === 1) pivot.rotation.x = -0.35; // mixture: full rich
    });
  }

  /** Whisky compass hanging from the windscreen bow. */
  buildCompass(mats) {
    const z = -1.24;
    const top = CANOPY.y + canopySection(z).h;
    const housing = new THREE.Group();
    housing.position.set(0, top - 0.045, z);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.045, 0.05), mats.yoke);
    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.02), mats.frame);
    mount.position.y = 0.04;
    const card = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, 0.026, 32, 1, true),
      new THREE.MeshBasicMaterial({ map: makeCompassTexture() }),
    );
    card.position.z = 0.012;
    const lubber = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.034, 0.002), new THREE.MeshBasicMaterial({ color: 0xff5a2a }));
    lubber.position.z = 0.038;
    housing.add(box, mount, card, lubber);
    this.group.add(housing);
    this.compassCard = card;
  }

  /** Seats, side panels and floor. */
  buildCabin(mats) {
    for (const x of [PILOT_X, -PILOT_X]) {
      const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.09, 0.46), mats.seat);
      cushion.position.set(x, 0.0, -0.32);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.62, 0.09), mats.seat);
      back.position.set(x, 0.3, -0.07);
      back.rotation.x = -0.22;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.08), mats.seat);
      head.position.set(x, 0.68, 0.01);
      head.rotation.x = -0.22;
      this.group.add(cushion, back, head);
    }
    // Side consoles / arm rests along the canopy rails
    for (const s of [-1, 1]) {
      const rest = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.8), mats.leather);
      rest.position.set(0.45 * s, 0.37, -0.5);
      this.group.add(rest);
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 2.0).rotateX(-Math.PI / 2), mats.carpet);
    floor.position.set(0, -0.25, -0.75);
    this.group.add(floor);
  }

  /**
   * Cabin seen from the pilot's seat (cockpit view only). The bubble is too
   * narrow to sit under from the LEFT seat (its roof edge would pass a hand's
   * width from the pilot's eye), so inside we draw a roomier cabin:
   * a superellipse cross-section |x/W|^4 + |(y - rail)/H|^4 = 1 (flat roof,
   * near-vertical sides) from the windscreen to the rear wall, with
   *   headliner (top) - door-top rails - side windows - door posts (B-pillars),
   *   a windscreen surround (A-pillars + header) filling the gap between the
   *   bubble's windscreen arch and the cabin section, sills, sun visors.
   * Nothing here is drawn in the chase view, so the outside stays as it is.
   */
  buildCabinShell(mats) {
    const W = 0.53, H = 0.64, y0 = CANOPY.y, zF = -1.27, zR = 0.28;
    const g = (this.interior = new THREE.Group());
    g.visible = false;
    this.group.add(g);
    // Point on the section for s in [-1, 1] (-1 = left rail, 0 = roof centre, 1 = right rail)
    const section = (s, scale = 1) => {
      const t = (s * Math.PI) / 2;
      const sn = Math.sin(t), cs = Math.cos(t);
      return [Math.sign(sn) * W * Math.sqrt(Math.abs(sn)) * scale, y0 + H * Math.sqrt(Math.abs(cs)) * scale];
    };
    const sDoor = 0.45; // headliner / side window boundary (door top, about 0.98 m)
    // Surface patch over s in [s0, s1] and z in [z0, z1] (u along s, v along z)
    const patch = (s0, s1, z0, z1, scale = 1, ns = 24, nz = 16) => {
      const pos = [], uv = [], idx = [];
      for (let j = 0; j <= nz; j++) {
        const z = z0 + ((z1 - z0) * j) / nz;
        for (let i = 0; i <= ns; i++) {
          const [x, y] = section(s0 + ((s1 - s0) * i) / ns, scale);
          pos.push(x, y, z);
          uv.push(i / ns, j / nz);
        }
      }
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < ns; i++) {
          const a = j * (ns + 1) + i, b = a + 1, c = a + ns + 1, d = c + 1;
          idx.push(a, b, c, b, d, c);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    };
    const add = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      g.add(m);
      return m;
    };

    // Headliner: light fabric with lengthwise stitched seams
    const fabric = canvasTexture(512, 256, (c, w, h) => {
      c.fillStyle = '#8f9196';
      c.fillRect(0, 0, w, h);
      grain(c, w, h, 6000, 0.07);
      for (const x of [0.2, 0.4, 0.6, 0.8]) {
        c.fillStyle = 'rgba(0,0,0,0.18)';
        c.fillRect(x * w - 1, 0, 2, h);
        c.fillStyle = 'rgba(255,255,255,0.08)';
        c.fillRect(x * w + 1, 0, 2, h);
      }
    });
    const lining = new THREE.MeshStandardMaterial({ map: fabric, roughness: 1, emissive: 0x2a2b2e, side: THREE.DoubleSide });
    const pad = new THREE.MeshStandardMaterial({ color: 0x3c3f45, roughness: 0.85, emissive: 0x0e0f11, side: THREE.DoubleSide });
    add(patch(-sDoor, sDoor, zF, zR), lining);

    // Side windows (plain, very light glass: no haze at grazing angles)
    const sideGlass = new THREE.MeshPhysicalMaterial({
      color: 0xe8f0f6, transparent: true, opacity: 0.05, roughness: 0.05, envMapIntensity: 0.3,
      depthWrite: false, side: THREE.DoubleSide,
    });
    for (const [a, b] of [[-1, -sDoor], [sDoor, 1]]) add(patch(a, b, zF, zR, 1.005, 12, 8), sideGlass).renderOrder = 3;

    for (const side of [-1, 1]) {
      // Padded rail along the door top
      const [x, y] = section(side * sDoor, 0.985);
      add(new THREE.CylinderGeometry(0.024, 0.024, zR - zF, 12).rotateX(Math.PI / 2).translate(x, y - 0.012, (zF + zR) / 2), pad);
      // Door post (B-pillar) just behind the seats
      const sOut = side < 0 ? [-1, -sDoor] : [sDoor, 1];
      add(patch(sOut[0], sOut[1], 0.0, 0.07, 0.985, 12, 1), pad);
      // Sill along the bottom of the window, over the fuselage side
      const sill = add(new THREE.BoxGeometry(0.14, 0.03, zR - zF), pad);
      sill.position.set(side * (W - 0.06), y0 + 0.005, (zF + zR) / 2);
    }

    // Windscreen surround between the bubble's windscreen arch (inner edge)
    // and the cabin section (outer edge): a slim frame band next to the
    // arch (A-pillars + header), glass in the corners beyond it
    const { hw, h } = canopySection(zF);
    const band = 0.06;
    const frameRing = [], glassRing = [], ringIdx = [];
    const n = 40;
    for (let i = 0; i <= n; i++) {
      const s = -1 + (2 * i) / n, t = (s * Math.PI) / 2;
      const ix = hw * Math.sin(t), iy = y0 + h * Math.cos(t);
      const [ox, oy] = section(s, 0.99);
      const dx = ox - ix, dy = oy - iy, len = Math.hypot(dx, dy) || 1;
      const k = Math.min(band / len, 1);
      const mx = ix + dx * k, my = iy + dy * k;
      frameRing.push(ix, iy, zF, mx, my, zF);
      glassRing.push(mx, my, zF, ox, oy, zF);
    }
    for (let i = 0; i < n; i++) {
      const a = 2 * i, b = a + 1, c = a + 2, d = a + 3;
      ringIdx.push(a, b, c, b, d, c);
    }
    for (const [pts, mat] of [[frameRing, pad], [glassRing, sideGlass]]) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      geo.setIndex(ringIdx);
      geo.computeVertexNormals();
      add(geo, mat).renderOrder = mat === sideGlass ? 3 : 0;
    }
    // Frame along the outer edge of the corner windows (cabin section)
    const edge = [];
    for (let i = 0; i <= n; i++) {
      const [x, y] = section(-1 + (2 * i) / n, 0.985);
      edge.push(new THREE.Vector3(x, y, zF + 0.01));
    }
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge), 64, 0.018, 8, false), pad);

    // Rear wall: the cabin section above the rail, the fuselage below it
    // (star-shaped around (0, 0.3): a triangle fan fills it)
    const outline = [];
    for (let i = 0; i <= 32; i++) outline.push(section(-1 + (2 * i) / 32, 1.01));
    const r = 0.6, a0 = Math.asin(y0 / r);
    for (let i = 0; i <= 24; i++) {
      const t = a0 - ((Math.PI + 2 * a0) * i) / 24;
      outline.push([r * Math.cos(t), r * Math.sin(t)]);
    }
    const wallPos = [0, 0.3, zR];
    for (const [x, y] of outline) wallPos.push(x, y, zR);
    const wallIdx = [];
    for (let i = 1; i <= outline.length; i++) wallIdx.push(0, i, (i % outline.length) + 1);
    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
    wallGeo.setIndex(wallIdx);
    wallGeo.computeVertexNormals();
    add(wallGeo, pad);

    // Dome light and two sun visors folded up against the headliner
    const dome = add(new THREE.CylinderGeometry(0.04, 0.045, 0.012, 20), mats.frame);
    dome.position.set(0, y0 + H - 0.008, -0.3);
    for (const x of [PILOT_X, -PILOT_X]) {
      const visor = add(new THREE.BoxGeometry(0.28, 0.13, 0.012), pad);
      visor.position.set(x, y0 + H - 0.05, zF + 0.1);
      visor.rotation.x = -1.25;
      const hinge = add(new THREE.CylinderGeometry(0.008, 0.008, 0.3, 8).rotateZ(Math.PI / 2), pad);
      hinge.position.set(x, y0 + H - 0.012, zF + 0.05);
    }
    g.traverse((o) => { o.userData.noShadow = true; });
  }

  // -------------------------------------------------------------- animate --

  /** Cockpit view on/off: swap the bubble's inside parts for the cabin. */
  setInteriorView(on) {
    this.innerGlass.visible = on;
    this.interior.visible = on;
    for (const m of this.bubbleOnly) m.visible = !on;
  }

  update(flight) {
    const s = flight.surfaces;
    for (const { column, wheel } of this.yokes) {
      column.position.z = column.userData.baseZ + s.pitch * 0.06; // pull = toward the pilot
      wheel.rotation.z = -s.roll * 0.9;
    }
    // Throttle lever: forward = full power
    this.levers[0].rotation.x = -0.9 * flight.throttle + 0.3;
    // Compass card stays aligned with magnetic north (aircraft heading h)
    const e = flight.quaternion;
    const fx = -2 * (e.x * e.z + e.w * e.y);
    const fz = -(1 - 2 * (e.x * e.x + e.y * e.y));
    this.compassCard.rotation.y = Math.atan2(fx, -fz);
  }
}
