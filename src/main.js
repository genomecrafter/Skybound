import * as THREE from 'three';
import './style.css';
import { CONFIG } from './config.js';
import { Game } from './core/Game.js';

/**
 * Entry point: creates the WebGL renderer and runs the game loop.
 *
 * RENDERER SETTINGS
 *  - antialias: MSAA smooths jagged polygon edges.
 *  - pixel ratio is capped (CONFIG.maxPixelRatio) so high-DPI laptop screens
 *    don't render 4x the pixels; the main performance safeguard.
 *  - ACES Filmic tone mapping compresses bright HDR lighting (sun glare,
 *    glowing rings) into the displayable range with a film-like curve.
 *  - Shadow maps enabled (PCF filtering = softened shadow edges).
 */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const game = new Game(renderer, document.getElementById('ui'));

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  game.resize(window.innerWidth, window.innerHeight);
});

// GAME LOOP: requestAnimationFrame syncs to the display refresh (usually 60 Hz).
// dt is clamped so that switching tabs doesn't produce one giant time step.
const timer = new THREE.Timer();
timer.connect(document); // pauses the timer while the tab is hidden
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.1);
  game.update(dt);
  game.render();
});
