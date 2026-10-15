import * as THREE from 'three';
import beamVert from '../shaders/beam.vert.glsl?raw';
import beamFrag from '../shaders/beam.frag.glsl?raw';
import { createGlowSprite } from './Glow.js';

/**
 * Lighthouse with a rotating SpotLight beam.
 *
 *   group
 *   ├── keeper's house, tower (striped CanvasTexture), gallery, railing
 *   ├── lantern (emissive glass) + roof
 *   ├── lampLight (PointLight: warm glow on the gallery)
 *   ├── glow sprite
 *   └── beamPivot (Group)          <- ROTATION about Y every frame
 *         ├── SpotLight            (really lights the islands / the plane)
 *         ├── spot target (Object3D, 100 m ahead, slightly down)
 *         └── beam cone mesh       (visible fake-volumetric light shaft)
 *
 * A SpotLight emits a cone of light from its position toward its target.
 * `angle` is the cone's half-angle and `penumbra` softens the edge.
 * Because the light and target are children of beamPivot, rotating the
 * pivot sweeps the light around the horizon.
 */
function makeStripeTexture() {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const g = c.getContext('2d');
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    g.fillStyle = i % 2 ? '#f2efe8' : '#b8322b';
    g.fillRect(0, (i * c.height) / bands, c.width, c.height / bands);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Lighthouse {
  constructor({ position, towerHeight = 26, rotationSpeed = 0.7 }) {
    this.group = new THREE.Group();
    this.group.name = 'Lighthouse';
    this.group.position.copy(position);
    this.rotationSpeed = rotationSpeed;

    const white = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.7 });
    const darkRed = new THREE.MeshStandardMaterial({ color: 0x6e1f1b, roughness: 0.6 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.6 });
    const H = towerHeight;

    // Keeper's house with a pyramid roof (a 4-sided cone rotated 45°)
    const house = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 6), white);
    house.position.set(6.5, 2, 0);
    const houseRoof = new THREE.Mesh(new THREE.ConeGeometry(5.6, 2.6, 4), darkRed);
    houseRoof.rotation.y = Math.PI / 4;
    houseRoof.scale.set(1, 1, 0.78);
    houseRoof.position.set(6.5, 5.3, 0);

    // Tapered tower with painted stripes
    const tower = new THREE.Mesh(
      new THREE.CylinderGeometry(2.2, 3.4, H, 24),
      new THREE.MeshStandardMaterial({ map: makeStripeTexture(), roughness: 0.6 }),
    );
    tower.position.y = H / 2;

    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.0, 0.5, 24), metal);
    gallery.position.y = H + 0.25;
    const railing = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.07, 6, 32), metal);
    railing.rotation.x = Math.PI / 2;
    railing.position.y = H + 1.3;

    // Lantern room: emissive glass that looks lit from inside
    const lantern = new THREE.Mesh(
      new THREE.CylinderGeometry(1.8, 1.8, 2.6, 12),
      new THREE.MeshStandardMaterial({
        color: 0xfff2c0, emissive: 0xffd27a, emissiveIntensity: 2.5, transparent: true, opacity: 0.85,
      }),
    );
    lantern.position.y = H + 1.8;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.3, 2.2, 12), darkRed);
    roof.position.y = H + 4.2;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), metal);
    ball.position.y = H + 5.4;

    this.group.add(house, houseRoof, tower, gallery, railing, lantern, roof, ball);
    this.group.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });

    // Warm lamp light around the lantern
    const lampY = H + 1.8;
    const lamp = new THREE.PointLight(0xffcf80, 40, 40, 2);
    lamp.position.y = lampY;
    const glow = createGlowSprite(0xffd890, 18, 0.9);
    glow.position.y = lampY;
    this.group.add(lamp, glow);
    this.glow = glow;

    // ---- Rotating beam ----
    const pivot = (this.beamPivot = new THREE.Group());
    pivot.position.y = lampY;
    this.group.add(pivot);

    const spot = new THREE.SpotLight(0xfff0c8, 1200, 900, 0.13, 0.5, 1);
    const target = new THREE.Object3D();
    target.position.set(0, -7, -100); // slightly downward, so it sweeps the sea/islands
    pivot.add(spot, target);
    spot.target = target;
    this.spot = spot;

    // Visible light shaft: open cone, apex at the lamp, opening along -Z
    const len = 260;
    const beamGeo = new THREE.ConeGeometry(Math.tan(0.13) * len, len, 24, 1, true)
      .translate(0, -len / 2, 0) // apex to the origin
      .rotateX(Math.PI / 2); // point the cone along -Z
    const beamMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffe2a8) }, uIntensity: { value: 0.75 } },
      vertexShader: beamVert,
      fragmentShader: beamFrag,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.rotation.x = -Math.atan2(7, 100); // aim at the same point as the spotlight
    pivot.add(beam);
  }

  update(dt, time) {
    // ROTATION: the whole beam assembly spins around the tower's Y axis
    this.beamPivot.rotation.y += this.rotationSpeed * dt;
    // Subtle flicker of the lamp glow
    this.glow.material.opacity = 0.8 + Math.sin(time * 7) * 0.05 + Math.sin(time * 13) * 0.04;
  }
}
