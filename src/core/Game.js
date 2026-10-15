import * as THREE from 'three';
import { Input } from './Input.js';
import { CameraRig } from './CameraRig.js';
import { AudioEngine } from './AudioEngine.js';
import { PostFX } from './PostFX.js';
import { ResolutionGovernor } from './Performance.js';
import { LandingController } from './Landing.js';
import { autopilot } from './DevAutopilot.js';
import { Environment } from '../world/Environment.js';
import { FlightModel } from '../aircraft/FlightModel.js';
import { AircraftModel, GEAR_CLEARANCE } from '../aircraft/AircraftModel.js';
import { NavLights } from '../aircraft/NavLights.js';
import { Trails } from '../aircraft/Trails.js';
import { HUD } from '../ui/HUD.js';
import { Caption } from '../ui/Caption.js';
import { Results } from '../ui/Results.js';
import { DebugPanel } from '../ui/DebugPanel.js';
import { TitleScreen, ControlsPanel, RouteSelect, SimSelect, PauseMenu, Loading } from '../ui/Menus.js';
import { SimFlightModel } from '../sim/SimFlightModel.js';
import { SimSession } from '../sim/SimSession.js';
import { SCENARIOS } from '../sim/Scenarios.js';
import { TestRoute } from '../routes/TestRoute.js';
import { SunsetRoute } from '../routes/SunsetRoute.js';
import { AuroraRoute } from '../routes/AuroraRoute.js';
import { CanyonRoute } from '../routes/CanyonRoute.js';
import { AirfieldRoute } from '../sim/AirfieldRoute.js';

const ROUTES = { test: TestRoute, sunset: SunsetRoute, aurora: AuroraRoute, canyon: CanyonRoute, airfield: AirfieldRoute };

const PHYSICS_STEP = 1 / 120; // fixed-size physics sub-steps for stable integration
const WATER_CLEARANCE = 3.2; // soft floor: aircraft origin never goes below waterLevel + this
const _probe = new THREE.Vector3();
const _prevPos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const FORWARD = new THREE.Vector3(0, 0, -1);
const params = new URLSearchParams(location.search);

/**
 * Owns the scene and all game objects, the screen flow (a small state
 * machine) and runs one frame of simulation. main.js owns the renderer and
 * the requestAnimationFrame loop.
 *
 * TWO MODES share the same world, aircraft model, camera and renderer:
 *   'arcade'  the scenic ring routes with the forgiving arcade FlightModel
 *   'sim'     the flight simulator: SimFlightModel (6-DOF aerodynamics,
 *             landing-gear physics) driven by a SimSession (scenario,
 *             instruments, instructor, landing grading)
 *
 * SCREEN STATES
 *   'title'   title screen (scene orbits behind it)
 *   'routes'  route / scenario selection cards
 *   'flying'  in flight (pointer locked)
 *   'paused'  pause menu (Esc / pointer lock lost)
 *   'results' route complete / landed card
 */
export class Game {
  constructor(renderer, uiRoot) {
    this.renderer = renderer;
    this.uiRoot = uiRoot;

    this.scene = new THREE.Scene();
    // Near plane 0.5 m (0.1 m in the cockpit), far plane 9 km (beyond the sky dome)
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.5, 9000);

    this.env = new Environment(this.scene);
    this.input = new Input(renderer.domElement);
    this.audio = new AudioEngine();

    // Aircraft = physics state (FlightModel) + visual scene graph (AircraftModel)
    this.flight = new FlightModel();
    this.arcadeFlight = this.flight;
    this.simFlight = new SimFlightModel();
    this.mode = 'arcade';
    this.aircraft = new AircraftModel();
    this.navLights = new NavLights(this.aircraft);
    this.scene.add(this.aircraft.root);
    this.trails = new Trails(this.aircraft);
    this.scene.add(this.trails.group);

    this.postfx = new PostFX(renderer, this.scene, this.camera);
    this.governor = new ResolutionGovernor(this.postfx);
    this.cameraRig = new CameraRig(this.camera);

    this.hud = new HUD(uiRoot);
    this.sim = new SimSession(this);
    this.caption = new Caption(uiRoot);
    this.debugPanel = new DebugPanel(uiRoot, this.aircraft);

    this.state = 'title';
    this.paused = true;
    this.menuOrbit = 0; // camera angle for the slow orbit behind the menus
    this.respawning = false;
    this.elapsed = 0;
    this.finished = false;
    this.onWaterFloor = false;
    this.lastGearTarget = 1;
    this.buildScreens();

    this.input.onPress((code) => this.onKey(code));
    // If the browser refuses the pointer lock, show the pause menu so the
    // player can simply click Resume again.
    this.input.onLockError = () => {
      if (this.state === 'flying' || this.state === 'paused') this.pauseMenu.show();
    };
    // Browsers only allow sound after a user gesture: start audio on the first click/key
    const unlock = () => this.audio.init();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    // ---- Dev / testing shortcuts (ignored in production builds) ----
    this.devAutopilot = import.meta.env.DEV && params.has('autopilot');
    if (import.meta.env.DEV && params.get('look')) {
      this.input.look.yaw = (Number(params.get('look')) * Math.PI) / 180;
      this.input.lookIdle = -1e9; // hold the free-look angle (screenshots)
    }

    // The title screen shows the Sunset route as a live backdrop.
    // Dev shortcut: ?route=aurora|sunset|canyon|test skips the menus,
    // ?sim=<scenario id> starts a simulator scenario.
    const id = params.get('route');
    const simId = import.meta.env.DEV ? params.get('sim') : null;
    const sc = simId ? SCENARIOS.find((x) => x.id === simId) : null;
    if (sc) {
      this.setMode('sim');
      this.sim.prepare(sc, { view: params.has('chase') ? 'chase' : 'cockpit' });
      this.loadRoute(ROUTES[sc.route]);
      this.beginFlight();
    } else {
      this.loadRoute(ROUTES[id] ?? SunsetRoute);
      if (id && ROUTES[id]) this.beginFlight();
      else this.showTitle();
    }
  }

  // ============================================================ screens ==

  buildScreens() {
    this.fadeEl = document.createElement('div');
    this.fadeEl.className = 'fade';
    this.uiRoot.append(this.fadeEl);

    const click = () => this.audio.click();
    this.title = new TitleScreen(this.uiRoot, {
      click,
      start: () => this.showRoutes('arcade'),
      sim: () => this.showRoutes('sim'),
      controls: () => {
        this.title.hide();
        this.controls.show();
      },
    });
    this.controls = new ControlsPanel(this.uiRoot, {
      click,
      back: () => {
        this.controls.hide();
        this.title.show();
      },
    });
    this.routeSelect = new RouteSelect(this.uiRoot, (id) => this.startRoute(id), {
      click,
      back: () => this.showTitle(),
    });
    this.simSelect = new SimSelect(this.uiRoot, (sc, opts) => this.startSim(sc, opts), {
      click,
      back: () => this.showTitle(),
    });
    this.pauseMenu = new PauseMenu(this.uiRoot, {
      click,
      resume: () => this.input.requestPointerLock(),
      restart: () => {
        this.restartRoute();
        this.input.requestPointerLock();
      },
      routes: () => this.showRoutes(),
      title: () => this.showTitle(),
    });
    this.results = new Results(this.uiRoot, {
      again: () => {
        click();
        this.restartRoute();
        this.input.requestPointerLock(); // unpauses via pointerlockchange
      },
      routes: () => {
        click();
        this.showRoutes();
      },
    });
    this.loading = new Loading(this.uiRoot);

    // Flying requires pointer lock; losing it (Esc) pauses the game.
    document.addEventListener('pointerlockchange', () => {
      if (this.state !== 'flying' && this.state !== 'paused') return;
      this.setPaused(!this.input.pointerLocked);
    });
  }

  hideAllScreens() {
    for (const s of [this.title, this.controls, this.routeSelect, this.simSelect, this.pauseMenu, this.results]) s.hide();
  }

  /** Common setup for the menu screens: no flying, HUD hidden, camera orbits. */
  enterMenuState(state) {
    this.state = state;
    this.paused = true;
    this.input.capture = false;
    this.hideAllScreens();
    this.caption.hide();
    this.hud.setVisible(false);
    this.sim.hud.setVisible(false);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  showTitle() {
    this.enterMenuState('title');
    this.title.show();
  }

  /** Route cards (arcade) or scenario cards (simulator). */
  showRoutes(kind = this.mode) {
    this.enterMenuState('routes');
    if (kind === 'sim') this.simSelect.show();
    else this.routeSelect.show();
  }

  /**
   * Switch between the arcade and the simulator flight model. Both share the
   * aircraft's scene graph; only the physics object and the HUD change.
   */
  setMode(mode) {
    this.mode = mode;
    const sim = mode === 'sim';
    this.flight = sim ? this.simFlight : this.arcadeFlight;
    this.input.simMode = sim;
    this.cameraRig.sim = sim;
    this.aircraft.setPanelTexture(sim ? this.sim.panelTexture : null);
    this.hud.setVisible(false);
    this.sim.hud.setVisible(false);
    this.results.setLabels('Fly again', sim ? 'Choose another scenario' : 'Choose another route');
    if (this.route) this.applyModeToRoute();
  }

  /** Rings are part of the arcade game only; the windsock shows the real wind only in the simulator. */
  applyModeToRoute() {
    const sim = this.mode === 'sim';
    if (this.route.rings) this.route.rings.group.visible = !sim;
    if (this.route.runwayObj && !sim) this.route.runwayObj.wind = null;
  }

  /** Called from a scenario card: load its world if needed, then start the flight. */
  startSim(scenario, options) {
    const RouteClass = ROUTES[scenario.route];
    if (!RouteClass) return;
    this.audio.init();
    this.input.requestPointerLock();
    this.setMode('sim');
    this.sim.prepare(scenario, options);
    if (this.route?.id === scenario.route) {
      this.restartRoute();
      this.beginFlight();
      return;
    }
    this.simSelect.hide();
    this.loading.showFor(new RouteClass({}).name);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        this.loadRoute(RouteClass);
        this.loading.hide();
        this.beginFlight();
      }),
    );
  }

  /** Called from a route card: build the route (behind a loading screen) and take off. */
  startRoute(id) {
    const RouteClass = ROUTES[id];
    if (!RouteClass) return;
    this.audio.init();
    this.input.requestPointerLock(); // must happen inside the click (user gesture)
    if (this.mode !== 'arcade') this.setMode('arcade');
    if (this.route?.id === id) {
      this.restartRoute();
      this.beginFlight();
      return;
    }
    this.routeSelect.hide();
    this.loading.showFor(new RouteClass({}).name);
    // Wait two frames so the loading screen is actually painted before the
    // (blocking) terrain generation starts
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        this.loadRoute(RouteClass);
        this.loading.hide();
        this.beginFlight();
      }),
    );
  }

  beginFlight() {
    this.state = 'flying';
    this.hideAllScreens();
    const sim = this.mode === 'sim';
    this.hud.setVisible(!sim);
    this.sim.hud.setVisible(sim);
    if (sim) {
      // Simulator: start in the chosen view
      const want = this.sim.options.view === 'chase' ? 'chase' : 'cockpit';
      if (this.cameraRig.mode !== want) this.toggleCockpit();
      this.sim.hud.setPanelVisible(want === 'chase', want === 'chase');
    }
    this.showIntroCaption();
    if (params.has('autofly')) this.setPaused(false); // dev: fly without pointer lock
    else this.setPaused(!this.input.pointerLocked);
    // Dev shortcuts for screenshots: ?cockpit, ?debug
    if (import.meta.env.DEV && params.has('cockpit') && this.cameraRig.mode !== 'cockpit') this.toggleCockpit();
    if (import.meta.env.DEV && params.has('debug') && !this.debugPanel.visible) this.debugPanel.toggle();
  }

  showIntroCaption() {
    if (this.mode === 'sim') {
      const sc = this.sim.scenario;
      this.caption.show(sc.name, `${sc.place} — wind ${this.sim.wind.describe()}`, 5);
      return;
    }
    const hint = this.route.rings ? 'Fly through the gold ring ahead' : 'Free flight: explore the valley';
    this.caption.show(this.route.name, `${this.route.subtitle ?? ''} — ${hint}`, 5);
  }

  setPaused(paused) {
    if (this.state === 'results') return;
    this.state = paused ? 'paused' : 'flying';
    this.paused = paused;
    this.input.capture = !paused;
    // While a pointer-lock request is pending, wait instead of flashing the menu
    if (paused && !this.input.lockPending) this.pauseMenu.show();
    else this.pauseMenu.hide();
  }

  onKey(code) {
    if (code === 'KeyM') {
      this.audio.init();
      this.audio.toggleMute();
    }
    if (this.paused) return;
    if (code === 'KeyG' || code === 'MouseRight') this.toggleGear();
    if (code === 'KeyC') this.toggleCockpit();
    if (code === 'KeyT') this.debugPanel.toggle();
    if (this.mode === 'sim') this.onSimKey(code);
  }

  toggleGear() {
    // Simulator: a "squat switch" stops the gear retracting with weight on the wheels
    if (this.mode === 'sim' && this.simFlight.onGround && this.aircraft.gearTarget === 1) {
      this.caption.show('Gear locked', 'The gear cannot retract with weight on the wheels', 2);
      return;
    }
    this.aircraft.setGear(this.aircraft.gearTarget === 0);
  }

  /** Simulator-only keys: flaps, parking brake, mouse yoke, panel overlay. */
  onSimKey(code) {
    const f = this.simFlight;
    if (code === 'KeyF') f.flapTarget = Math.min(1, Math.round(f.flapTarget * 3 + 1) / 3);
    if (code === 'KeyV') f.flapTarget = Math.max(0, Math.round(f.flapTarget * 3 - 1) / 3);
    if (code === 'KeyF' || code === 'KeyV') this.audio.click();
    if (code === 'KeyP') {
      f.parkingBrake = !f.parkingBrake;
      this.audio.click();
    }
    if (code === 'KeyY') {
      this.input.yokeEnabled = !this.input.yokeEnabled;
      this.input.yoke.x = this.input.yoke.y = 0;
      this.input.look.yaw = this.input.look.pitch = 0;
      this.caption.show(this.input.yokeEnabled ? 'Mouse yoke ON' : 'Mouse yoke OFF', this.input.yokeEnabled ? 'Move the mouse to fly · middle click centres the controls' : 'Mouse looks around again', 2);
    }
    if (code === 'KeyH') this.sim.hud.setPanelVisible(!this.sim.hud.panelVisible, this.cameraRig.mode !== 'cockpit');
  }

  toggleCockpit() {
    const cockpit = this.cameraRig.mode !== 'cockpit';
    this.cameraRig.setMode(cockpit ? 'cockpit' : 'chase');
    this.aircraft.setCockpitView(cockpit);
    if (!cockpit) this.cameraRig.snap(this.flight);
    // Simulator: the 3D panel replaces the overlay in the cockpit (H brings it back)
    if (this.mode === 'sim') this.sim.hud.setPanelVisible(!cockpit, !cockpit);
  }

  // ============================================================= routes ==

  loadRoute(RouteClass) {
    if (this.route) this.route.dispose();
    this.route = new RouteClass({ scene: this.scene, renderer: this.renderer, env: this.env });
    this.route.build();
    this.scene.add(this.route.group);
    this.applyModeToRoute();
    this.env.apply(this.route.atmosphere, this.renderer, this.route.envExtras);
    this.navLights.strength = this.route.navLightStrength;
    this.postfx.apply(this.route.post);
    this.trails.humidity = this.route.humidity ?? 1;
    this.cameraRig.groundAt = (x, z) => Math.max(this.route.groundAt(x, z), this.route.waterLevel ?? -Infinity);
    this.landing = this.route.runway ? new LandingController(this.route.runway, GEAR_CLEARANCE) : null;
    if (import.meta.env.DEV) this.validateRings();
    // Compile all shaders for the new route now (in parallel where the browser
    // supports it) instead of stuttering when objects first come into view.
    this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
    this.restartRoute();
  }

  restartRoute() {
    this.results.hide();
    this.elapsed = 0;
    this.finished = false;
    if (this.mode === 'sim') {
      this.landing?.reset();
      this.sim.restart();
      this.aircraft.update(0, this.flight);
      this.trails.reset();
      this.cameraRig.snap(this.flight);
      this.lastGearTarget = this.aircraft.gearTarget;
      if (this.state === 'flying' || this.state === 'paused' || this.state === 'results') {
        this.state = 'paused';
        this.paused = true;
        this.showIntroCaption();
      }
      return;
    }
    this.route.rings?.reset();
    this.route.onRestart?.();
    this.landing?.reset();
    this.checkpoint = this.route.spawn;
    // Dev shortcut: ?spawn=x,y,z,headingDeg starts the plane anywhere (for screenshots)
    const sp = params.get('spawn');
    if (import.meta.env.DEV && sp) {
      const [x, y, z, hdg = 0] = sp.split(',').map(Number);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-hdg * Math.PI) / 180);
      this.checkpoint = { position: new THREE.Vector3(x, y, z), quaternion: q, speed: 42 };
    }
    this.placeAtCheckpoint();
    this.aircraft.setGear(true);
    this.lastGearTarget = 1;
    if (this.state === 'flying' || this.state === 'paused' || this.state === 'results') {
      this.state = 'paused';
      this.paused = true;
      this.showIntroCaption();
    }
  }

  /** Dev helper: warn if a ring was placed inside terrain or an obstacle. */
  validateRings() {
    const rc = this.route.rings;
    if (!rc) return;
    rc.rings.forEach((r, i) => {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        _probe.set(Math.cos(a) * rc.radius, Math.sin(a) * rc.radius, 0).applyQuaternion(r.mesh.quaternion).add(r.center);
        if (this.route.isSolidAt(_probe)) {
          console.warn(`Ring ${i} intersects solid geometry at`, _probe.toArray().map((v) => v.toFixed(0)));
          break;
        }
      }
    });
  }

  placeAtCheckpoint() {
    const cp = this.checkpoint;
    this.flight.reset(cp.position, cp.quaternion, cp.speed);
    this.flight.throttle = 0.6;
    this.landing?.reset();
    this.aircraft.update(0, this.flight);
    this.trails.reset();
    this.cameraRig.snap(this.flight);
  }

  /** After passing ring i, respawns happen at that ring, facing the next one. */
  setCheckpointAtRing(i) {
    const rings = this.route.rings.rings;
    const here = rings[i].center;
    const next = rings[i + 1]?.center;
    if (next) _dir.subVectors(next, here);
    else _dir.copy(rings[i].normal);
    _dir.y = 0;
    _dir.normalize();
    this.checkpoint = {
      position: here.clone(),
      quaternion: new THREE.Quaternion().setFromUnitVectors(FORWARD, _dir),
      speed: 42,
    };
  }

  /** Crash: sound, fade to black, move back to the last checkpoint, fade back in. */
  respawn(reason = 'Crashed!') {
    if (this.respawning) return;
    if (import.meta.env.DEV) console.log('crash at', this.flight.position.toArray().map((v) => v.toFixed(0)).join(','));
    const short = reason.length < 14;
    this.caption.show(short ? reason : 'Crashed!', short ? 'Back to the last checkpoint' : reason, 3.5);
    this.audio.crash();
    this.respawning = true;
    this.fadeEl.classList.add('on');
    setTimeout(() => {
      this.placeAtCheckpoint();
      this.fadeEl.classList.remove('on');
      this.respawning = false;
    }, 600);
  }

  /** Has the belly or a wing tip entered terrain or an obstacle? */
  checkCollision() {
    const f = this.flight;
    const { up, right } = f.getAxes();
    const probes = [
      [up, -GEAR_CLEARANCE * (f.gearDown ? 1 : 0.45)],
      [right, 4.9],
      [right, -4.9],
      [up, 0],
    ];
    for (const [axis, d] of probes) {
      _probe.copy(f.position).addScaledVector(axis, d);
      if (this.route.isSolidAt(_probe)) return true;
    }
    return false;
  }

  /** Soft water floor: the ocean gently holds the plane up instead of crashing it. */
  applyWaterFloor() {
    const wl = this.route.waterLevel;
    if (wl === null) return false;
    const floor = wl + WATER_CLEARANCE;
    const f = this.flight;
    if (f.position.y >= floor) return false;
    f.position.y = floor;
    if (f.velocity.y < 0) f.velocity.y = 0;
    return true;
  }

  onRingPassed(i) {
    if (import.meta.env.DEV) console.log(`ring ${i} passed at t=${this.elapsed.toFixed(1)}s`);
    this.audio.chime();
    this.setCheckpointAtRing(i);
    this.route.onRingPassed?.(i, this);
    const moment = this.route.moments[i];
    if (moment) this.caption.show(moment.title, moment.text, 5);
    // Routes with a runway finish on landing, the others after the last ring
    if (this.route.rings.finished && !this.landing) this.finishRoute();
  }

  formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /** Simulator flight over (landed or crashed): pause and show the debrief card. */
  showSimResults({ title, subtitle, badge, stats, success }) {
    this.finished = true;
    this.state = 'results';
    this.paused = true;
    this.input.capture = false;
    this.pauseMenu.hide();
    if (success) this.audio.success();
    this.results.show({ title, subtitle, badge, stats });
  }

  /** Show the results card. `landing` holds touchdown data for the canyon route. */
  finishRoute(landing = null) {
    if (this.finished) return;
    this.finished = true;
    const rc = this.route.rings;
    const stats = [
      ['Time', this.formatTime(this.elapsed)],
      ['Rings collected', rc ? `${rc.collected} / ${rc.total}` : '-'],
    ];
    if (landing) {
      stats.push(['Touchdown rate', `${landing.sink.toFixed(1)} m/s`]);
      stats.push(['Touchdown speed', `${Math.round(landing.speed * 3.6)} km/h`]);
      stats.push(['Runway remaining', `${Math.max(0, Math.round(landing.remaining))} m`]);
    }
    // Pause the simulation (the scene keeps animating) and show the card
    this.state = 'results';
    this.paused = true;
    this.input.capture = false;
    this.pauseMenu.hide();
    this.audio.success();
    this.results.show({
      title: landing ? 'Landed!' : 'Route Complete',
      subtitle: this.route.name,
      badge: landing ? landing.grade : rc && rc.collected === rc.total ? 'ALL RINGS' : '',
      stats,
    });
  }

  onTouchdown(td) {
    this.audio.touchdown(td.sink);
    this.caption.show(td.grade, `Touchdown at ${td.sink.toFixed(1)} m/s — throttle to idle to brake`, 3.5);
  }

  // ============================================================== frame ==

  update(dt) {
    this.input.update(dt);
    this.governor.update(dt);
    const f = this.flight;
    const sim = this.mode === 'sim';
    if (this.devAutopilot && !sim) autopilot(this.input, f, this.route.rings, this.landing, GEAR_CLEARANCE);

    if (!this.paused && !this.respawning) {
      if (sim) this.sim.step(dt);
      else this.stepPhysics(dt);
    }

    // Gear motor sound whenever the gear starts moving
    if (this.aircraft.gearTarget !== this.lastGearTarget) {
      this.lastGearTarget = this.aircraft.gearTarget;
      this.audio.gear();
    }

    const inMenu = this.state === 'title' || this.state === 'routes';
    this.aircraft.update(this.paused && !inMenu ? 0 : dt, f); // propeller keeps idling behind menus
    this.navLights.update(dt);
    if (!this.paused) this.trails.update(dt, f);
    this.route.update(dt, (this.route.time += dt), this);
    if (inMenu) this.orbitCamera(dt);
    else this.cameraRig.update(dt, f, this.input.look);
    this.env.update(this.camera, f.position);
    this.postfx.updateSun(this.camera, this.env.sunDir, this.route.time);
    this.debugPanel.update(dt, this.route.rings);

    const ground = Math.max(this.route.groundAt(f.position.x, f.position.z), this.route.waterLevel ?? -Infinity);
    const agl = f.position.y - ground;

    const simAudio = sim && !inMenu ? {
      rpm: f.rpm,
      stallWarning: f.stallWarning && !this.paused,
      rolling: f.onGround && !this.paused ? f.groundSpeed : 0,
      flapsMoving: this.sim.flapsMoving && !this.paused,
      crashed: !!f.crashed,
    } : null;
    this.audio.update(dt, {
      active: !this.paused && this.state === 'flying' && !(sim && f.crashed),
      idle: inMenu,
      throttle: f.throttle,
      speed: this.paused ? 0 : sim ? f.tas : f.speed,
      boosting: f.boosting,
      cockpit: this.cameraRig.mode === 'cockpit',
      altitude: agl,
      ambience: this.route.ambience,
      sim: simAudio,
    });

    if (sim) {
      if (!inMenu) this.sim.updateHUD(dt);
      return;
    }

    let warning = null;
    const approach = this.approachInfo();
    if (f.outOfBounds) warning = 'LEAVING THE AREA — TURNING BACK';
    else if (agl < 25 && f.velocity.y < -8 && !approach) warning = 'PULL UP';
    else if (this.onWaterFloor) warning = 'TOO LOW';
    else if (approach && !approach.rolling && !f.gearDown && !this.aircraft.gearMoving && approach.dist < 1500) {
      warning = 'GEAR UP — PRESS G';
    }

    this.hud.update(dt, {
      flight: f,
      agl,
      gearMoving: this.aircraft.gearMoving,
      routeName: this.route.name,
      rings: this.route.rings,
      elapsed: this.elapsed,
      camera: this.camera,
      warning,
      resScale: this.governor.scale,
      boost: f.boostEnergy,
      boosting: f.boosting,
      approach,
      muted: this.audio.muted,
      cockpit: this.cameraRig.mode === 'cockpit',
    });
  }

  /** Fixed-step physics, touchdown/rollout, rings and collisions. */
  stepPhysics(dt) {
    const f = this.flight;
    f.throttle = THREE.MathUtils.clamp(f.throttle + this.input.consumeWheel(), 0, 1);
    _prevPos.copy(f.position);
    // Fixed-step sub-stepping: physics stays stable even if a frame is slow
    const steps = Math.ceil(dt / PHYSICS_STEP);
    const h = dt / steps;
    this.onWaterFloor = false;
    let crash = null;
    const runwayY = this.landing?.runway.center.y;
    for (let i = 0; i < steps && !crash; i++) {
      if (f.grounded) {
        f.updateGround(h, this.input, runwayY, GEAR_CLEARANCE);
        continue;
      }
      f.update(h, this.input, { bounds: this.route.bounds });
      if (this.applyWaterFloor()) this.onWaterFloor = true;
      // Touchdown test runs BEFORE collision, so the runway counts as a landing
      const td = this.landing?.checkTouchdown(f);
      if (td) {
        if (td.ok) {
          f.setGrounded(runwayY, GEAR_CLEARANCE);
          this.onTouchdown(td);
        } else crash = td.reason;
      }
    }
    if (!this.finished) this.elapsed += dt;

    const rc = this.route.rings;
    if (rc && !f.grounded) {
      const passed = rc.checkPass(_prevPos, f.position);
      if (passed >= 0) this.onRingPassed(passed);
    }

    const roll = this.landing?.checkRollout(f);
    if (roll?.event === 'stopped') this.finishRoute({ ...this.landing.touchdown, remaining: roll.remaining });
    else if (roll?.event === 'overrun') crash = 'Ran off the runway';
    else if (roll?.event === 'takeoff') this.caption.show('Touch-and-go!', 'Climb out and try another landing', 3);

    if (!crash && !f.grounded && this.checkCollision()) crash = 'Crashed!';
    if (crash) this.respawn(crash);
  }

  /** Distance/height info for the HUD while approaching the runway. */
  approachInfo() {
    const L = this.landing;
    if (!L || L.state === 'stopped') return null;
    const f = this.flight;
    if (L.state === 'rolling') return { rolling: true, speed: f.speed };
    const { along, across } = L.local(f.position.x, f.position.z);
    // Only when in front of the runway and roughly lined up
    if (along > 0 || along < -3000 || Math.abs(across) > 600) return null;
    const dist = -along;
    const height = f.position.y - GEAR_CLEARANCE - L.runway.center.y;
    // Glide-slope angle seen from the touchdown aim point (300 m past the threshold)
    const angle = (Math.atan2(height, dist + 300) * 180) / Math.PI;
    return { dist, height, angle, across, gearDown: f.gearDown, name: L.runway.numbers?.[0] };
  }

  /** Slow cinematic orbit around the parked aircraft behind the menus. */
  orbitCamera(dt) {
    this.menuOrbit += dt * 0.12;
    const p = this.flight.position;
    const a = this.menuOrbit;
    this.camera.position.set(p.x + Math.sin(a) * 22, p.y + 5, p.z + Math.cos(a) * 22);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(p.x, p.y + 1, p.z);
  }

  render() {
    this.postfx.render(this.scene, this.camera);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.postfx.setSize(w, h);
  }
}
