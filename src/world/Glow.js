import * as THREE from 'three';

/**
 * Soft glow sprite: a radial gradient painted on a canvas, drawn with
 * additive blending. A Sprite always faces the camera (billboarding), so the
 * glow looks the same from every direction. Used for lamps and lights.
 */
let glowTexture = null;

function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

export function createGlowSprite(color, size, opacity = 1) {
  const mat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color,
    opacity,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(size);
  return sprite;
}
