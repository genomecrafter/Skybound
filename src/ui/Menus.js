import { CONFIG } from '../config.js';
import { SCENARIOS, WEATHER } from '../sim/Scenarios.js';

/**
 * Menu screens (plain HTML/CSS over the live 3D scene).
 *
 *  TitleScreen   : project name, team, Start / Controls / graphics quality
 *  ControlsPanel : full list of controls
 *  RouteSelect   : one card per route
 *  SimSelect     : flight-simulator scenarios + weather / assist options
 *  PauseMenu     : shown when the pointer lock is released (Esc)
 *  Loading       : brief overlay while a route's geometry is generated
 *
 * Card "previews" are CSS gradients, so no image files are needed.
 */

// Edit these for your report / demo

export const ROUTE_CARDS = [
  {
    id: 'aurora',
    name: 'Aurora Flyover',
    blurb: 'A moonlit arctic valley beneath the northern lights',
    preview: 'radial-gradient(ellipse at 50% 120%, #dfe8f5 0%, #0c2a4a 35%, transparent 60%), linear-gradient(180deg, #050a1f 0%, #0d3b4a 35%, #2affb0 48%, #1b2f6a 62%, #0c2a4a 100%)',
  },
  {
    id: 'sunset',
    name: 'Sunset Ocean Skim',
    blurb: 'Skim the waves toward a setting sun, past a lighthouse',
    preview: 'linear-gradient(180deg, #26305e 0%, #b8607a 40%, #f2925a 58%, #ffcf8a 62%, #1a2a48 100%)',
  },
  {
    id: 'canyon',
    name: 'Canyon Landing',
    blurb: 'Thread a red-rock canyon and land on the desert airstrip',
    preview: 'linear-gradient(180deg, #7fb6e6 0%, #e8c9a0 45%, #b5532e 60%, #6e2e1a 100%)',
  },
  {
    id: 'test',
    name: 'Free Flight Valley',
    blurb: 'Daytime sandbox valley: no rings, just fly',
    preview: 'linear-gradient(180deg, #2f6fc0 0%, #c4dcf0 50%, #7a8a6a 62%, #4d7a33 100%)',
    tag: 'SANDBOX',
  },
];

const CONTROLS = [
  ['↑ / ↓  (W / S)', 'Climb / dive'],
  ['← / →  (A / D)', 'Bank & turn'],
  ['Q / E', 'Rudder (fine yaw)'],
  ['Mouse wheel  (Shift / Ctrl)', 'Throttle up / down'],
  ['Mouse move', 'Look around'],
  ['Hold left click', 'Boost'],
  ['Right click  /  G', 'Landing gear up / down'],
  ['C', 'Chase / cockpit camera'],
  ['T', 'Transform debug panel'],
  ['M', 'Mute sound'],
  ['Esc', 'Pause menu'],
];

const SIM_CONTROLS = [
  ['↑ ↓ ← →  (W A S D)', 'Elevator + ailerons'],
  ['Q / E', 'Rudder + nose-wheel steering'],
  ['Mouse wheel  (Shift / Ctrl)', 'Throttle'],
  ['F / V', 'Flaps down / up (0-10-20-30°)'],
  ['[  /  ]', 'Elevator trim nose down / up'],
  ['Space  (B)', 'Wheel brakes (hold)'],
  ['P', 'Parking brake'],
  ['G', 'Landing gear'],
  ['Y', 'Mouse yoke on / off (middle click = centre)'],
  ['H', 'Instrument panel overlay'],
  ['Gamepad', 'Sticks fly, triggers = throttle'],
];

class Screen {
  constructor(root, className, html) {
    this.el = document.createElement('div');
    this.el.className = `menu ${className} hidden`;
    this.el.innerHTML = html;
    root.append(this.el);
  }

  show() {
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  /** Wire every [data-a] button to actions[name]. */
  bind(actions) {
    this.el.querySelectorAll('[data-a]').forEach((b) =>
      b.addEventListener('click', () => {
        actions.click?.();
        actions[b.dataset.a]?.();
      }),
    );
  }
}

export class TitleScreen extends Screen {
  /** @param {{ start: Function, controls: Function, click?: Function }} actions */
  constructor(root, actions) {
    const low = CONFIG.quality === 'low';
    super(
      root,
      'title-screen',
      `<div class="title-block">
        <h1 class="menu-title big">SKYBOUND</h1>
        <p class="menu-sub">A Scenic Flight Experience</p>
      </div>
      <div class="menu-buttons">
        <button data-a="start" class="primary">Start</button>
        <button data-a="sim" class="primary">Flight Simulator</button>
        <button data-a="controls">Controls</button>
        <button data-a="quality">Graphics: ${low ? 'Low (faster)' : 'High'}</button>
      </div>
      <p class="menu-hint"></p>`,
    );
    this.bind({
      ...actions,
      quality: () => {
        // Quality is read at start-up, so switch by reloading with a URL flag
        const url = new URL(location.href);
        if (low) url.searchParams.delete('quality');
        else url.searchParams.set('quality', 'low');
        location.href = url.toString();
      },
    });
  }
}

export class ControlsPanel extends Screen {
  constructor(root, actions) {
    super(
      root,
      'controls-panel',
      `<div class="results-card">
        <h2 class="menu-title small">CONTROLS</h2>
        <div class="controls-cols">
          <div class="results-stats">
            <div class="controls-head">Scenic flight</div>
            ${CONTROLS.map(([k, v]) => `<div class="results-row"><span>${v}</span><b>${k}</b></div>`).join('')}
          </div>
          <div class="results-stats">
            <div class="controls-head">Flight simulator (also: C, M, Esc)</div>
            ${SIM_CONTROLS.map(([k, v]) => `<div class="results-row"><span>${v}</span><b>${k}</b></div>`).join('')}
          </div>
        </div>
        <p class="results-sub">Scenic flight: fly through the glowing rings in order. Flight simulator: a realistic flight model; take off, fly and land like a real pilot.</p>
        <div class="menu-buttons"><button data-a="back" class="primary">Back</button></div>
      </div>`,
    );
    this.bind(actions);
  }
}

export class RouteSelect extends Screen {
  /** @param {(id: string) => void} onSelect */
  constructor(root, onSelect, actions) {
    super(
      root,
      'route-select',
      `<h1 class="menu-title">SKYBOUND</h1>
      <p class="menu-sub">Choose your flight</p>
      <div class="cards"></div>
      <div class="menu-buttons row"><button data-a="back">◀ Back</button></div>
      <p class="menu-hint">Arrow keys fly · mouse looks around · wheel = throttle · hold left-click = boost · right-click = gear · C = cockpit · Esc = pause</p>`,
    );
    const cards = this.el.querySelector('.cards');
    for (const r of ROUTE_CARDS) {
      const card = document.createElement('button');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-preview" style="background:${r.preview}">
          ${r.tag ? `<span class="card-tag">${r.tag}</span>` : ''}
        </div>
        <div class="card-body">
          <div class="card-name">${r.name}</div>
          <div class="card-blurb">${r.blurb}</div>
        </div>`;
      card.addEventListener('click', () => {
        actions.click?.();
        onSelect(r.id);
      });
      cards.append(card);
    }
    this.bind(actions);
  }
}

export class SimSelect extends Screen {
  /**
   * @param {(scenario: object, options: object) => void} onSelect
   */
  constructor(root, onSelect, actions) {
    super(
      root,
      'route-select sim-select',
      `<h1 class="menu-title">FLIGHT SIMULATOR</h1>
      <p class="menu-sub">Realistic flight model · choose a scenario</p>
      <div class="sim-options">
        <label>Weather <select data-o="weather">${WEATHER.map((w) => `<option value="${w.id}">${w.label}</option>`).join('')}</select></label>
        <label>Start view <select data-o="view"><option value="cockpit">Cockpit</option><option value="chase">Chase</option></select></label>
        <label><input type="checkbox" data-o="autoRudder" checked /> Auto-rudder assist</label>
      </div>
      <div class="cards"></div>
      <div class="menu-buttons row"><button data-a="back">◀ Back</button></div>
      <p class="menu-hint">F/V flaps · [ ] trim · Space brakes · P parking brake · Y mouse yoke · H instrument panel · gamepads supported</p>`,
    );
    const opt = (name) => this.el.querySelector(`[data-o="${name}"]`);
    const cards = this.el.querySelector('.cards');
    for (const sc of SCENARIOS) {
      const card = document.createElement('button');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-preview" style="background:${sc.preview}">
          ${sc.tag ? `<span class="card-tag">${sc.tag}</span>` : ''}
        </div>
        <div class="card-body">
          <div class="card-name">${sc.name}</div>
          <div class="card-place">${sc.place}</div>
          <div class="card-blurb">${sc.blurb}</div>
        </div>`;
      card.addEventListener('click', () => {
        actions.click?.();
        const weather = WEATHER.find((w) => w.id === opt('weather').value);
        onSelect(sc, { weatherWind: weather?.wind ?? null, autoRudder: opt('autoRudder').checked, view: opt('view').value });
      });
      cards.append(card);
    }
    this.bind(actions);
  }
}

export class PauseMenu extends Screen {
  /** @param {{ resume, restart, routes, title }} actions */
  constructor(root, actions) {
    super(
      root,
      'pause',
      `<h2 class="menu-title small">PAUSED</h2>
      <div class="menu-buttons">
        <button data-a="resume" class="primary">Resume</button>
        <button data-a="restart">Restart route</button>
        <button data-a="routes">Choose another flight</button>
        <button data-a="title">Main menu</button>
      </div>`,
    );
    this.bind(actions);
  }
}

export class Loading extends Screen {
  constructor(root) {
    super(root, 'loading', `<div class="spinner"></div><p class="loading-text">Generating terrain…</p>`);
  }

  showFor(name) {
    this.el.querySelector('.loading-text').textContent = `Generating ${name}…`;
    this.show();
  }
}
