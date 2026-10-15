import * as THREE from 'three';
import { smoothstep } from '../utils/math.js';
import { Cockpit, CANOPY, PILOT_X } from './Cockpit.js';

/**
 * Procedurally modelled light aircraft, built only in code.
 *
 * MODELLING TECHNIQUES USED
 *  - LatheGeometry (surface of revolution): the fuselage is a smooth 2D
 *    profile curve (radius vs. length) spun 360° around the long axis, the
 *    same way a wood-turner shapes a piece on a lathe. A spline through a
 *    few hand-picked stations gives the smooth nose-to-tail shape.
 *  - LOFTED AIRFOILS (custom BufferGeometry): wings, tail surfaces and
 *    propeller blades are built by placing a NACA-style airfoil cross
 *    section at the root and at the tip and joining them with triangles.
 *    The tip section is smaller (TAPER = non-uniform scaling) and shifted
 *    back (SWEEP, applied as a SHEAR matrix: z' = z + k*x).
 *  - Primitives (Sphere, Cylinder, Box) for the canopy, wheels, struts...
 *
 * SCENE GRAPH (hierarchical modelling)
 *   root (Group)                <- position + quaternion from FlightModel
 *   ├── fuselage, canopy, pilot, exhausts, antenna
 *   ├── cockpit (Group)         <- interior: panel, yokes, compass... (Cockpit.js)
 *   ├── propeller (Group)       <- ROTATION about Z, speed ~ throttle
 *   ├── wingL / wingR (Group, dihedral; left = mirrored copy, scale.x = -1)
 *   │     ├── wing panel, flap
 *   │     ├── aileronPivot      <- ROTATION about the hinge line (roll)
 *   │     └── navMount          (wing-tip light)
 *   ├── tail
 *   │     ├── stabilisers, fin
 *   │     ├── elevatorPivot     <- ROTATION (pitch)
 *   │     └── rudderAxis > rudderHinge <- ROTATION (yaw)
 *   └── landingGear: nose, mainL, mainR  <- TRANSLATION + ROTATION (retract)
 *
 * Axes: nose -Z, up +Y, right wing +X (matches FlightModel).
 */

/** Height from the aircraft origin to the bottom of the wheels (gear down). */
export const GEAR_CLEARANCE = 1.67;

// ------------------------------------------------------------ geometry --

/**
 * Closed airfoil outline (unit chord), NACA 4-digit style thickness
 * distribution + a parabolic camber line. Cosine spacing puts more points
 * near the rounded leading edge. Returns [x, y] with x = 0 at the leading edge.
 */
function airfoilPoints(thickness, camber, n = 12) {
  const pts = [];
  const yt = (x) =>
    5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const yc = (x) => camber * 4 * x * (1 - x);
  for (let i = n; i >= 0; i--) {
    const x = (1 - Math.cos((Math.PI * i) / n)) / 2; // upper surface, TE -> LE
    pts.push([x, yc(x) + yt(x)]);
  }
  for (let i = 1; i < n; i++) {
    const x = (1 - Math.cos((Math.PI * i) / n)) / 2; // lower surface, LE -> TE
    pts.push([x, yc(x) - yt(x)]);
  }
  return pts;
}

/**
 * Lofted lifting surface. Span runs along +X from 0 to `span`; the chord
 * runs along Z, centred on z = 0 at the root (leading edge toward -Z).
 */
function loftSurface({ rootChord, tipChord, span, thickness = 0.12, camber = 0.02, sweep = 0 }) {
  const prof = airfoilPoints(thickness, camber);
  const m = prof.length;
  const pos = [];
  for (const [x, c] of [[0, rootChord], [span, tipChord]]) {
    for (const [px, py] of prof) pos.push(x, py * c, (px - 0.5) * c);
  }
  const idx = [];
  for (let i = 0; i < m; i++) {
    const a = i, b = (i + 1) % m, c = m + i, d = m + ((i + 1) % m);
    idx.push(a, c, b, b, c, d); // side quads (outward facing)
  }
  // End caps as triangle fans (separate vertices so their normals stay flat)
  for (const [ring, x, c] of [[0, 0, rootChord], [1, span, tipChord]]) {
    const base = pos.length / 3;
    for (const [px, py] of prof) pos.push(x, py * c, (px - 0.5) * c);
    for (let i = 1; i < m - 1; i++) {
      if (ring === 0) idx.push(base, base + i, base + i + 1);
      else idx.push(base, base + i + 1, base + i);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  // SWEEP as a shear transformation: z' = z + sweep * x  (makeShear(xy, xz, yx, yz, zx, zy))
  if (sweep) geo.applyMatrix4(new THREE.Matrix4().makeShear(0, sweep, 0, 0, 0, 0));
  geo.computeVertexNormals();
  return geo;
}

/** Spline profile (radius, length) revolved around the long axis. */
function latheAlongZ(stations, segments = 36, samples = 48) {
  // LatheGeometry revolves around +Y using points (radius, y). We use y = -z,
  // then rotate so +Y becomes -Z (the nose direction).
  const curve = new THREE.SplineCurve(stations.map(([r, z]) => new THREE.Vector2(r, -z)));
  // Keep a tiny non-zero radius at the tips: a radius of exactly 0 creates
  // zero-length normals there, which become NaN in the lighting shader.
  const pts = curve.getPoints(samples).map((p) => new THREE.Vector2(Math.max(p.x, 0.003), p.y));
  return new THREE.LatheGeometry(pts, segments).rotateX(-Math.PI / 2);
}

/**
 * Livery painted on a <canvas> (no image files). On the lathe, u wraps around
 * the fuselage (0 = top, 0.25 = right side, 0.5 = belly, 0.75 = left side)
 * and v runs from the tail (v = 0, canvas bottom) to the nose (v = 1, top).
 */
/**
 * Instrument panel face for the scenic (arcade) mode: the same layout as the
 * simulator's live panel (Instruments.js) - six-pack on the left, engine
 * gauges on the right - but painted once with fixed needles.
 */
function makeInstrumentTexture() {
  const W = 1024, H = 320;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#34383f');
  bg.addColorStop(1, '#22252b');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(4, 2, 488, H - 4);
  const gauge = (cx, cy, r, label, i) => {
    g.fillStyle = '#17191d';
    g.fillRect(cx - r - 9, cy - r - 9, 2 * r + 18, 2 * r + 18);
    g.fillStyle = '#4a4f58';
    g.beginPath();
    g.arc(cx, cy, r + 5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0b0c0e';
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    if (label === 'ATT') {
      g.save();
      g.beginPath();
      g.arc(cx, cy, r * 0.92, 0, Math.PI * 2);
      g.clip();
      g.fillStyle = '#3d7fd0';
      g.fillRect(cx - r, cy - r, 2 * r, r);
      g.fillStyle = '#8a5a34';
      g.fillRect(cx - r, cy, 2 * r, r);
      g.restore();
      g.strokeStyle = '#ffd34d';
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(cx - r * 0.5, cy);
      g.lineTo(cx - r * 0.15, cy);
      g.moveTo(cx + r * 0.15, cy);
      g.lineTo(cx + r * 0.5, cy);
      g.stroke();
    } else {
      g.strokeStyle = '#e8e8e8';
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI * 2;
        const major = k % 3 === 0;
        g.lineWidth = major ? 2.5 : 1.2;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r * (major ? 0.78 : 0.86), cy + Math.sin(a) * r * (major ? 0.78 : 0.86));
        g.lineTo(cx + Math.cos(a) * r * 0.94, cy + Math.sin(a) * r * 0.94);
        g.stroke();
      }
      g.strokeStyle = '#f2f2ee';
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(cx, cy);
      const a = -0.8 + i * 1.3;
      g.lineTo(cx + Math.cos(a) * r * 0.75, cy + Math.sin(a) * r * 0.75);
      g.stroke();
    }
    g.fillStyle = '#cfd3da';
    g.font = 'bold 13px Arial';
    g.textAlign = 'center';
    g.fillText(label, cx, cy + r * 0.45);
  };
  ['ASI', 'ATT', 'ALT', 'TURN', 'HDG', 'VSI'].forEach((label, i) => gauge(86 + (i % 3) * 160, 80 + Math.floor(i / 3) * 160, 66, label, i));
  gauge(600, 80, 62, 'RPM', 7);
  gauge(744, 80, 62, 'G', 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeLiveryTexture() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4f0';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#c9ccd3'; // belly
  g.fillRect(0.38 * W, 0, 0.24 * W, H);
  g.fillStyle = '#b8261f'; // red nose cowl (front 12%)
  g.fillRect(0, 0, W, 0.12 * H);
  // Matte anti-glare panel on top of the nose, in front of the windscreen
  // (u = 0 is the top, so it wraps around both edges of the canvas; v is
  // spread evenly over the lathe stations, so v = 0.64..0.8 is z = -1.3..-2.5)
  g.fillStyle = '#26292e';
  for (const x0 of [0, W]) {
    g.beginPath();
    g.moveTo(x0 - 0.085 * W, 0.37 * H);
    g.lineTo(x0 + 0.085 * W, 0.37 * H);
    g.lineTo(x0 + 0.05 * W, 0.19 * H);
    g.lineTo(x0 - 0.05 * W, 0.19 * H);
    g.closePath();
    g.fill();
  }
  for (const u of [0.25, 0.75]) {
    // Swooping cheat-line: thick red + navy pin-stripe running nose to tail
    g.fillStyle = '#b8261f';
    g.fillRect(u * W - 22, 0.12 * H, 44, 0.88 * H);
    g.fillStyle = '#1d3a6e';
    g.fillRect(u * W + 28, 0.12 * H, 8, 0.88 * H);
    g.fillRect(u * W - 36, 0.12 * H, 8, 0.88 * H);
  }
  // Panel lines: thin darker lines around the circumference
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (const v of [0.14, 0.34, 0.52, 0.72]) g.fillRect(0, (1 - v) * H, W, 2);
  // Registration letters on both sides of the rear fuselage
  g.fillStyle = '#1d3a6e';
  g.font = 'bold 64px Arial';
  g.textAlign = 'center';
  for (const u of [0.25, 0.75]) {
    g.save();
    g.translate(u * W, 0.62 * H);
    g.rotate(u < 0.5 ? Math.PI / 2 : -Math.PI / 2);
    g.fillText('SKY-01', 0, 22);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class AircraftModel {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'Aircraft';

    // Physically based (PBR) materials: a satin paint finish that reflects the
    // route's sky through the environment map. (A glossy clear-coat looked
    // great from the side but glared badly when flying into a low sun.)
    const paint = { roughness: 0.4, metalness: 0.05 };
    const M = (this.materials = {
      body: new THREE.MeshPhysicalMaterial({ map: makeLiveryTexture(), ...paint }),
      white: new THREE.MeshPhysicalMaterial({ color: 0xf4f4f0, ...paint }),
      red: new THREE.MeshPhysicalMaterial({ color: 0xb8261f, ...paint }),
      dark: new THREE.MeshStandardMaterial({ color: 0x1e2126, roughness: 0.6, metalness: 0.2 }),
      tyre: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }),
      metal: new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.25, metalness: 0.9 }),
      yellow: new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5 }),
      glass: new THREE.MeshPhysicalMaterial({
        color: 0x223a52, roughness: 0.12, metalness: 0.0,
        transparent: true, opacity: 0.5, envMapIntensity: 1.4,
      }),
      pilot: new THREE.MeshStandardMaterial({ color: 0x2c313b, roughness: 0.7 }),
      helmet: new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.35 }),
      blur: new THREE.MeshBasicMaterial({
        color: 0x1a1a1a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      }),
    });

    this.parts = {};
    this.mounts = {}; // empty Object3Ds where NavLights / trails attach

    this.buildFuselage(M);
    this.buildPropeller(M);
    this.buildWings(M);
    this.buildTail(M);
    this.buildGear(M);

    this.root.traverse((o) => {
      if (o.isMesh && o !== this.parts.blurDisc && !o.material.transparent && !o.userData.noShadow) o.castShadow = true;
    });

    this.propAngle = 0;
    this.gearT = 1; // 1 = fully down, 0 = fully retracted
    this.gearTarget = 1;
  }

  // ---------------------------------------------------------------- build --

  buildFuselage(M) {
    // Stations: [radius, z]. Tail (z = +5.05) to nose (z = -2.92).
    const geo = latheAlongZ([
      [0.0, 5.05], [0.1, 4.95], [0.2, 4.4], [0.33, 3.4], [0.47, 2.2], [0.58, 1.0],
      [0.63, -0.2], [0.62, -1.3], [0.56, -2.1], [0.46, -2.6], [0.3, -2.88], [0.0, -2.92],
    ]);
    // Bend the rear fuselage upward (vertex displacement): y += k * (z - 1.2)^2
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      if (z > 1.2) p.setY(i, p.getY(i) + 0.028 * (z - 1.2) ** 2);
    }
    geo.computeVertexNormals();
    // Cockpit opening: drop the skin triangles under the canopy (inside its
    // footprint, between the glare shield and the seat backs) by editing the index buffer
    const idx = geo.index.array;
    const keep = [];
    // (a triangle is removed only when all three corners lie under the
    // canopy, so the opening never extends past the canopy rim: no gaps)
    for (let t = 0; t < idx.length; t += 3) {
      let under = true;
      for (let k = 0; k < 3; k++) {
        const x = p.getX(idx[t + k]), y = p.getY(idx[t + k]), z = p.getZ(idx[t + k]);
        const inFootprint = (x / CANOPY.a) ** 2 + ((z - CANOPY.z) / CANOPY.c) ** 2 < 1;
        if (!(y > 0.4 && inFootprint && z > -1.75 && z < 0.3)) under = false;
      }
      if (!under) keep.push(idx[t], idx[t + 1], idx[t + 2]);
    }
    geo.setIndex(keep);
    const fuselage = new THREE.Mesh(geo, M.body);
    fuselage.name = 'fuselage';
    this.root.add(fuselage);

    // Cabin lining: the same skin triangles between the firewall and the rear
    // cabin wall, shrunk a little and drawn from the inside (BackSide), so
    // the cockpit walls follow the fuselage and the opening exactly
    const cabin = [];
    for (let t = 0; t < keep.length; t += 3) {
      let inside = true;
      for (let k = 0; k < 3; k++) {
        const z = p.getZ(keep[t + k]);
        if (z < -2.1 || z > 0.6) inside = false;
      }
      if (inside) cabin.push(keep[t], keep[t + 1], keep[t + 2]);
    }
    const liningGeo = new THREE.BufferGeometry();
    liningGeo.setAttribute('position', p);
    liningGeo.setAttribute('normal', geo.attributes.normal);
    liningGeo.setIndex(cabin);
    const lining = new THREE.Mesh(liningGeo, new THREE.MeshStandardMaterial({ color: 0x3a3d43, roughness: 0.9, emissive: 0x0b0c0d, side: THREE.BackSide }));
    lining.scale.set(0.975, 0.975, 1);
    const firewall = new THREE.Mesh(new THREE.CircleGeometry(0.56, 28), new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.9 }));
    firewall.position.set(0, 0, -1.75); // faces back, toward the pilot
    this.root.add(lining, firewall);

    // Canopy bubble: top half of a unit sphere, non-uniformly SCALED into a teardrop
    const glass = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.glass);
    glass.scale.set(CANOPY.a, CANOPY.b, CANOPY.c);
    glass.position.set(0, CANOPY.y, CANOPY.z);
    glass.renderOrder = 2; // transparent: draw after opaque parts
    this.root.add(glass);
    this.parts.cockpitGlass = glass;

    // Cockpit interior: glare shield, panel, yokes, canopy frame, inner glass...
    this.cockpit = new Cockpit(M);
    this.root.add(this.cockpit.group);
    this.staticGauges = makeInstrumentTexture();
    this.parts.panelFace = this.cockpit.panelFace;
    this.setPanelTexture(null);

    // Pilot (left seat): body + helmet
    const torso = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), M.pilot);
    torso.scale.set(1, 1.25, 0.8);
    torso.position.set(PILOT_X, 0.4, -0.3);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), M.helmet);
    helmet.position.set(PILOT_X, 0.78, -0.33);
    this.root.add(torso, helmet);
    this.parts.pilot = [torso, helmet]; // hidden in cockpit view (the camera is the pilot's eyes)

    // Exhaust stubs under the cowl and a radio antenna on the spine
    for (const side of [-1, 1]) {
      const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.35, 8), M.metal);
      ex.rotation.x = Math.PI / 2 - 0.4;
      ex.position.set(0.33 * side, -0.38, -1.95);
      this.root.add(ex);
    }
    const antenna = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.45, 0.08), M.dark);
    antenna.position.set(0, 0.78, 1.4);
    antenna.rotation.x = 0.35;
    this.root.add(antenna);
  }

  buildPropeller(M) {
    const prop = new THREE.Group();
    prop.name = 'propeller';
    prop.position.z = -2.95;

    // Bullet-shaped spinner: a small lathe
    const spinner = new THREE.Mesh(
      latheAlongZ([[0.25, 0.08], [0.24, -0.08], [0.18, -0.28], [0.08, -0.42], [0.0, -0.46]], 24, 16),
      M.red,
    );
    prop.add(spinner);

    // Two lofted, twisted blades with yellow warning tips
    const bladeGeo = loftSurface({ rootChord: 0.2, tipChord: 0.11, span: 0.95, thickness: 0.14, camber: 0.04 })
      .rotateZ(Math.PI / 2) // span along +Y
      .translate(0, 0.12, 0);
    const tipGeo = loftSurface({ rootChord: 0.115, tipChord: 0.1, span: 0.1, thickness: 0.14, camber: 0.04 })
      .rotateZ(Math.PI / 2)
      .translate(0, 1.06, 0);
    for (let i = 0; i < 2; i++) {
      const holder = new THREE.Group();
      holder.rotation.z = i * Math.PI;
      const blade = new THREE.Group();
      // Turn the chord into the propeller disc plane, leaving a 20° blade pitch
      blade.rotation.y = Math.PI / 2 - 0.35;
      blade.add(new THREE.Mesh(bladeGeo, M.dark), new THREE.Mesh(tipGeo, M.yellow));
      holder.add(blade);
      prop.add(holder);
    }

    // Semi-transparent disc that imitates motion blur at high RPM
    const blur = new THREE.Mesh(new THREE.CircleGeometry(1.15, 40), M.blur);
    prop.add(blur);
    this.parts.blurDisc = blur;

    this.root.add(prop);
    this.parts.propeller = prop;
  }

  buildWings(M) {
    const span = 4.6, rootChord = 1.25, tipChord = 0.8, sweep = 0.04;
    const chordAt = (s) => rootChord + (tipChord - rootChord) * (s / span);
    const trailingEdgeAt = (s) => chordAt(s) / 2 + sweep * s;

    const panelGeo = loftSurface({ rootChord, tipChord, span, thickness: 0.13, camber: 0.03, sweep });
    // Control surfaces: thin lofts with their leading edge on the pivot (hinge)
    const surf = (len) => loftSurface({ rootChord: 0.32, tipChord: 0.3, span: len, thickness: 0.1, camber: 0 }).translate(0, 0, 0.16);
    const flapGeo = surf(2.3);
    const aileronGeo = surf(1.9);

    for (const side of [-1, 1]) {
      const wing = new THREE.Group();
      wing.name = side < 0 ? 'wingL' : 'wingR';
      wing.position.set(0.42 * side, -0.36, -0.3);
      wing.rotation.z = 0.06 * side; // dihedral
      wing.scale.x = side; // left wing = mirror image (negative scale)

      wing.add(new THREE.Mesh(panelGeo, M.white));

      // Flap: hinged at its leading edge like the ailerons (ROTATION when lowered)
      const flap = new THREE.Mesh(flapGeo, M.white);
      flap.position.set(0.05, 0, trailingEdgeAt(0.05) - 0.02);
      wing.add(flap);
      this.parts[side < 0 ? 'flapL' : 'flapR'] = flap;

      // Aileron pivot sits on the hinge line at the wing's trailing edge
      const aileronPivot = new THREE.Group();
      aileronPivot.position.set(2.45, 0, trailingEdgeAt(2.45) - 0.02);
      aileronPivot.add(new THREE.Mesh(aileronGeo, M.red));
      wing.add(aileronPivot);

      // Red wing-tip cap + mount for the nav light / vapour trail
      const mount = new THREE.Object3D();
      mount.position.set(span + 0.02, 0, sweep * span);
      wing.add(mount);

      this.root.add(wing);
      if (side < 0) {
        this.parts.aileronL = aileronPivot;
        this.mounts.navLeft = mount;
      } else {
        this.parts.aileronR = aileronPivot;
        this.mounts.navRight = mount;
      }
    }
  }

  buildTail(M) {
    const tail = new THREE.Group();
    tail.name = 'tail';
    const tailY = 0.32, tailZ = 4.3;

    // Horizontal stabilisers (mirrored pair) + elevators on one shared pivot
    const stabGeo = loftSurface({ rootChord: 0.85, tipChord: 0.5, span: 1.75, thickness: 0.1, camber: 0, sweep: 0.12 });
    const elevGeo = loftSurface({ rootChord: 0.3, tipChord: 0.26, span: 1.6, thickness: 0.09, camber: 0 }).translate(0, 0, 0.15);
    const elevatorPivot = new THREE.Group();
    elevatorPivot.position.set(0, tailY, tailZ + 0.425);
    for (const side of [-1, 1]) {
      const stab = new THREE.Mesh(stabGeo, M.white);
      stab.position.set(0.08 * side, tailY, tailZ);
      stab.scale.x = side;
      tail.add(stab);
      const elev = new THREE.Mesh(elevGeo, M.red);
      elev.position.x = 0.12 * side;
      elev.scale.x = side;
      elevatorPivot.add(elev);
    }
    tail.add(elevatorPivot);

    // Vertical fin: a lofted surface rotated so its span points up
    const finSpan = 1.4, finSweep = 0.55, finRoot = 1.2, finTip = 0.6;
    const finGeo = loftSurface({ rootChord: finRoot, tipChord: finTip, span: finSpan, thickness: 0.1, camber: 0, sweep: finSweep })
      .rotateZ(Math.PI / 2);
    const fin = new THREE.Mesh(finGeo, M.body);
    fin.position.set(0, 0.45, 4.2);
    tail.add(fin);

    // Rudder: hinge follows the fin's swept trailing edge
    const rootTE = finRoot / 2, tipTE = finTip / 2 + finSweep * finSpan;
    const rudderAxis = new THREE.Group();
    rudderAxis.position.set(0, 0.45, 4.2 + rootTE);
    rudderAxis.rotation.x = Math.atan2(tipTE - rootTE, finSpan); // tilt the hinge line back
    const rudderHinge = new THREE.Group();
    const rudderGeo = loftSurface({ rootChord: 0.36, tipChord: 0.3, span: 1.45, thickness: 0.09, camber: 0 })
      .rotateZ(Math.PI / 2)
      .translate(0, 0, 0.18);
    rudderHinge.add(new THREE.Mesh(rudderGeo, M.red));
    rudderAxis.add(rudderHinge);
    tail.add(rudderAxis);

    const strobeMount = new THREE.Object3D();
    strobeMount.position.set(0, 0.45 + finSpan + 0.05, 4.2 + finSweep * finSpan);
    tail.add(strobeMount);

    this.root.add(tail);
    this.parts.elevator = elevatorPivot;
    this.parts.rudder = rudderHinge;
    this.mounts.tailStrobe = strobeMount;
  }

  buildGear(M) {
    const gear = new THREE.Group();
    gear.name = 'landingGear';

    const makeLeg = (length, wheelR, spat) => {
      const pivot = new THREE.Group();
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, length, 10), M.metal);
      strut.position.y = -length / 2;
      const wheel = new THREE.Group();
      wheel.position.y = -length;
      const spin = new THREE.Group(); // turns about the axle when rolling
      wheel.add(spin);
      const tyre = new THREE.Mesh(new THREE.TorusGeometry(wheelR * 0.72, wheelR * 0.3, 10, 20).rotateY(Math.PI / 2), M.tyre);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 0.5, wheelR * 0.5, 0.14, 14).rotateZ(Math.PI / 2), M.metal);
      spin.add(tyre, hub);
      // A dark cross on the hub makes the rotation visible
      for (const a of [0, Math.PI / 2]) {
        const mark = new THREE.Mesh(new THREE.BoxGeometry(0.15, wheelR * 0.75, 0.05), M.dark);
        mark.rotation.x = a;
        spin.add(mark);
      }
      if (spat) {
        // Aerodynamic wheel fairing: a scaled sphere hugging the upper wheel
        const s = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), M.white);
        s.scale.set(0.16, wheelR * 1.25, wheelR * 2.3);
        wheel.add(s);
      }
      pivot.add(strut, wheel);
      pivot.userData.spin = spin;
      return pivot;
    };

    // Attachment points chosen so every wheel bottom sits at y = -GEAR_CLEARANCE
    const nose = makeLeg(0.93, 0.24, false);
    nose.position.set(0, -0.5, -2.1);
    const mainL = makeLeg(0.95, 0.3, true);
    mainL.position.set(-1.5, -0.42, -0.2);
    const mainR = makeLeg(0.95, 0.3, true);
    mainR.position.set(1.5, -0.42, -0.2);
    gear.add(nose, mainL, mainR);
    this.root.add(gear);

    for (const leg of [nose, mainL, mainR]) leg.userData.baseY = leg.position.y;
    this.parts.gear = { nose, mainL, mainR };
  }

  // -------------------------------------------------------------- animate --

  /** Cockpit view: hide the pilot (the camera sits where their eyes are). */
  setCockpitView(on) {
    for (const p of this.parts.pilot) p.visible = !on;
    this.cockpit.setInteriorView(on);
    this.cockpitView = on;
  }

  /** Request gear up/down; the actual motion is animated in update(). */
  setGear(down) {
    this.gearTarget = down ? 1 : 0;
  }

  /** Put the gear fully up or down instantly (new flight). */
  snapGear(down) {
    this.gearTarget = this.gearT = down ? 1 : 0;
  }

  /**
   * Simulator: show live instruments on the 3D panel (a CanvasTexture that is
   * redrawn every frame), or the static painted gauges when `tex` is null.
   */
  setPanelTexture(tex) {
    const m = this.parts.panelFace.material;
    m.map = m.emissiveMap = tex ?? this.staticGauges;
    m.emissiveIntensity = tex ? 0.55 : 0.35;
    m.needsUpdate = true;
  }

  get gearMoving() {
    return this.gearT !== this.gearTarget;
  }

  /**
   * Copy the flight state onto the scene graph and animate moving parts.
   * @param {number} dt
   * @param {FlightModel} flight
   */
  update(dt, flight) {
    // --- Whole-aircraft transform (TRANSLATION + ROTATION) ---
    this.root.position.copy(flight.position);
    this.root.quaternion.copy(flight.quaternion);

    // --- Propeller ROTATION: angular speed proportional to throttle ---
    // (simulator: from the engine RPM; the visible rate is capped because a
    // real 2500 RPM prop would only strobe at 60 frames per second)
    const power = flight.rpm !== undefined ? 0.45 + 0.6 * Math.max((flight.rpm - 550) / 2150, 0) : flight.boosting ? 1.2 : flight.throttle;
    const rpm = 8 + power * 52; // rad/s
    this.propAngle = (this.propAngle + rpm * dt) % (Math.PI * 2);
    this.parts.propeller.rotation.z = this.propAngle;
    this.materials.blur.opacity = 0.06 + power * 0.2;
    // From the cockpit a spinning prop is just a faint disc (the blades would strobe)
    const discOnly = !!this.cockpitView && power > 0.3;
    for (const c of this.parts.propeller.children) if (c !== this.parts.blurDisc && c.children.length) c.visible = !discOnly;
    if (discOnly) this.materials.blur.opacity = 0.05 + power * 0.08;

    // --- Control surfaces: ROTATION about their hinge lines ---
    const s = flight.surfaces;
    // Roll right: right aileron trailing edge UP (negative X rotation), left DOWN
    this.parts.aileronR.rotation.x = -s.roll * 0.35;
    this.parts.aileronL.rotation.x = s.roll * 0.35;
    // Nose up: elevator trailing edge UP
    this.parts.elevator.rotation.x = -s.pitch * 0.4;
    // Yaw right: rudder trailing edge to the right (+X)
    this.parts.rudder.rotation.y = s.yaw * 0.45;
    // Flaps: trailing edge down, up to 30° (simulator only)
    const flapAngle = (flight.flaps ?? 0) * 0.52;
    this.parts.flapL.rotation.x = this.parts.flapR.rotation.x = flapAngle;
    // Yokes, throttle lever and compass card in the cockpit
    this.cockpit.update(flight);

    // --- Landing gear: TRANSLATION up into the wing + fold ROTATION ---
    const step = dt / 1.8; // full cycle takes 1.8 s
    if (this.gearT < this.gearTarget) this.gearT = Math.min(this.gearTarget, this.gearT + step);
    else if (this.gearT > this.gearTarget) this.gearT = Math.max(this.gearTarget, this.gearT - step);
    const up = 1 - smoothstep(0, 1, this.gearT); // eased 0 (down) .. 1 (up)
    const { nose, mainL, mainR } = this.parts.gear;
    // Simulator: struts compress under load and the wheels spin when rolling
    const wheels = flight.wheels;
    [nose, mainL, mainR].forEach((leg, i) => {
      leg.position.y = leg.userData.baseY + up * 0.35 + (wheels ? wheels[i].compression : 0);
      if (wheels) leg.userData.spin.rotation.x = -wheels[i].spin;
    });
    nose.rotation.x = -up * (Math.PI / 2); // nose wheel folds backwards
    mainL.rotation.z = up * (Math.PI / 2); // main wheels fold inwards
    mainR.rotation.z = -up * (Math.PI / 2);
    // Gear counts as "down" for physics/landing only when fully extended
    flight.gearDown = this.gearT > 0.99;
  }
}
