import * as THREE from 'three';
import { SimHUD } from './SimHUD.js';
import { Wind } from './Wind.js';
import { Instruments, PANEL_W, PANEL_H } from './Instruments.js';
import { KT, PLANE } from './SimFlightModel.js';
import { clamp } from '../utils/math.js';

const FT = 3.28084;
const STEP = 1 / 120;
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const DEG = Math.PI / 180;
const fmtHdg = (deg) => String(Math.round((((deg % 360) + 360) % 360)) || 360).padStart(3, '0');

/**
 * Runs one simulator flight: places the aircraft for the chosen scenario,
 * steps the realistic flight model, grades the landing, handles crashes and
 * drives the instructor (the step-by-step lesson text).
 *
 * The flight model only needs a few questions answered about the world
 * (`this.world`): how high is the ground here, is it water, is it runway
 * (smooth asphalt vs. rough grass) and is there an obstacle.
 */
export class SimSession {
  constructor(game) {
    this.game = game;
    this.hud = new SimHUD(game.uiRoot);
    this.wind = new Wind({ seed: 7 });
    this.scenario = null;
    this.options = { weather: 'default', autoRudder: true, view: 'cockpit' };

    // Live texture for the 3D instrument panel in the cockpit
    this.panelCanvas = document.createElement('canvas');
    this.panelCanvas.width = PANEL_W;
    this.panelCanvas.height = PANEL_H;
    this.panelInstruments = new Instruments(this.panelCanvas);
    this.panelTexture = new THREE.CanvasTexture(this.panelCanvas);
    this.panelTexture.colorSpace = THREE.SRGBColorSpace;
    this.panelTexture.generateMipmaps = false; // re-uploaded often: skip mipmap generation
    this.panelTexture.minFilter = THREE.LinearFilter;
    this.panelTexture.anisotropy = 8;
    this.panelTimer = 0;

    this.world = {
      heightAt: (x, z) => {
        const L = this.game.landing;
        if (L && L.isOnRunway(x, z, 1)) return L.runway.center.y + 0.05;
        const r = this.game.route;
        const h = Math.max(r.groundAt(x, z), r.waterLevel ?? -Infinity);
        return Number.isFinite(h) ? h : -1000; // beyond the edge of the terrain
      },
      isWater: (x, z) => {
        const r = this.game.route;
        return r.waterLevel !== null && r.groundAt(x, z) < r.waterLevel;
      },
      isRunway: (x, z) => !!this.game.landing?.isOnRunway(x, z, 1),
      isSolid: (p) => {
        for (const o of this.game.route.obstacles) {
          const dx = p.x - o.x, dz = p.z - o.z;
          if (p.y < o.top && dx * dx + dz * dz < o.r * o.r) return true;
        }
        return false;
      },
      bounds: null,
    };
  }

  get flight() {
    return this.game.simFlight;
  }

  prepare(scenario, options) {
    this.scenario = scenario;
    Object.assign(this.options, options);
  }

  // ============================================================== start ==

  /** (Re)start the current scenario. */
  restart() {
    const sc = this.scenario;
    if (!sc) return;
    const g = this.game, f = this.flight, route = g.route;
    const wx = this.options.weatherWind ?? sc.wind;
    this.wind.set(wx);
    f.wind = this.wind;
    f.autoRudder = this.options.autoRudder;
    // The simulator gets more room than the arcade route (traffic patterns, long finals)
    this.world.bounds = route.simBounds ?? { ...route.bounds, radius: route.bounds.radius + 600 };
    if (route.runwayObj) route.runwayObj.wind = { dir: this.wind.dir, speed: this.wind.speed };

    const L = g.landing;
    const rw = route.runway;
    const hdgOf = (dir) => Math.atan2(dir.x, -dir.z);
    if (sc.start === 'runway' && rw) {
      // Lined up on the centre-line, 15 m past the threshold
      const thr = L.threshold;
      g.aircraft.snapGear(true);
      f.gearDown = true;
      f.resetOnGround(thr.x + rw.dir.x * 15, thr.z + rw.dir.z * 15, hdgOf(rw.dir), rw.center.y + 0.05, { flaps: sc.flaps ?? 0 });
    } else if (sc.start === 'final' && rw) {
      // On the 3° glide path toward the aiming point 300 m past the threshold
      const d = sc.distance ?? 3000;
      const thr = L.threshold;
      const h = Math.tan(3 * DEG) * (d + 300);
      _p.set(thr.x - rw.dir.x * d, rw.center.y + h + 1.67, thr.z - rw.dir.z * d);
      g.aircraft.snapGear(true);
      f.gearDown = true;
      // Approach speed 70 kt, already descending at 3°, crabbed into any
      // crosswind (nose turned into the wind) so the track follows the centre-line
      const v = 70 / KT;
      const wind = this.wind.sample(h, _v);
      const side = wind.x * -rw.dir.z + wind.z * rw.dir.x; // wind blowing toward the right (m/s)
      const crab = Math.asin(clamp(side / v, -0.4, 0.4));
      const hdg = hdgOf(rw.dir) - crab;
      f.resetAirborne(_p, hdg, v, { flaps: sc.flaps ?? 2 / 3, gearDown: true });
      f.flaps = f.flapTarget;
      f.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -3 * DEG));
      f.syncCG();
      f.velocity.set(Math.sin(hdg) * Math.cos(3 * DEG), -Math.sin(3 * DEG), -Math.cos(hdg) * Math.cos(3 * DEG)).multiplyScalar(v).add(wind);
      f.throttle = Math.max(f.throttle - 0.2, 0.12);
    } else {
      // Cruising flight from the route's spawn point
      const sp = route.spawn;
      _v.set(0, 0, -1).applyQuaternion(sp.quaternion);
      _p.copy(sp.position);
      const ground = Math.max(route.groundAt(_p.x, _p.z), route.waterLevel ?? -Infinity);
      _p.y = Math.max(sc.altitude ?? _p.y, ground + 120);
      g.aircraft.snapGear(false);
      f.gearDown = false;
      f.resetAirborne(_p, Math.atan2(_v.x, -_v.z), sc.speed ?? 55, { flaps: 0, gearDown: false });
      f.velocity.add(_v.copy(this.wind.dir).multiplyScalar(this.wind.speed));
    }
    f.updateDerived();

    g.input.resetAxes();
    this.hud.reset(sc);
    this.panelInstruments.resetGMeter();
    this.flightTime = 0;
    this.maxG = 1;
    this.minG = 1;
    this.touchdown = null;
    this.stopTimer = 0;
    this.crashTimer = 0;
    this.ended = false;
    this.lessonStep = 0;
    this.lessonNote = '';
    this.lastStep = -1;
    this.flapsMoving = false;
    this.wasAirborne = sc.start !== 'runway';
  }

  // ============================================================ physics ==

  step(dt) {
    const g = this.game, f = this.flight, inp = g.input;
    if (this.ended) return;
    if (f.crashed) {
      this.crashTimer += dt;
      if (this.crashTimer > 1.1) this.finishCrash(f.crashed);
      return;
    }
    f.throttle = clamp(f.throttle + inp.consumeWheel(), 0, 1);
    f.trim = clamp(f.trim + inp.trimRate * 0.25 * dt, -1, 1);
    const prevFlaps = f.flaps;
    const steps = Math.ceil(dt / STEP);
    const h = dt / steps;
    for (let i = 0; i < steps && !f.crashed; i++) f.update(h, inp, this.world);
    this.flapsMoving = Math.abs(f.flaps - prevFlaps) > 1e-6;
    this.flightTime += dt;
    g.elapsed += dt;
    if (!f.onGround) this.wasAirborne = true;
    this.maxG = Math.max(this.maxG, f.gLoad);
    this.minG = Math.min(this.minG, f.gLoad);

    for (const ev of f.events.splice(0)) if (ev.type === 'touchdown') this.onTouchdown(ev);

    if (f.crashed) {
      g.audio.crash();
      g.caption.show('Crashed', f.crashed, 3);
      g.fadeEl.classList.add('crash');
      setTimeout(() => g.fadeEl.classList.remove('crash'), 900);
      return;
    }

    // Touch-and-go: airborne again after a touchdown
    if (this.touchdown && !f.onGround && f.airborneTime > 2) {
      this.touchdown = null;
      g.caption.show('Touch-and-go', 'Climb out and go around for another landing', 3);
    }
    // Stopped after landing (or simply parked after taxiing)?
    if (this.touchdown && f.onGround && f.groundSpeed < 0.6 && f.throttle < 0.25) {
      this.stopTimer += dt;
      if (this.stopTimer > 1.5) this.finishLanding();
    } else this.stopTimer = 0;

    this.updateLesson();
  }

  onTouchdown(ev) {
    const g = this.game, L = g.landing;
    const fpm = ev.sink * 196.85;
    const onRunway = !!L?.isOnRunway(ev.position.x, ev.position.z, 2);
    const loc = L ? L.local(ev.position.x, ev.position.z) : { along: 0, across: 0 };
    this.touchdown = { ...ev, fpm, onRunway, along: loc.along, across: loc.across };
    g.audio.touchdown(ev.sink);
    const grade = fpm < 150 ? 'Butter!' : fpm < 300 ? 'Smooth landing' : fpm < 500 ? 'Firm landing' : 'Hard landing';
    g.caption.show(grade, `Touchdown ${Math.round(fpm)} ft/min · ${Math.round(ev.ias * KT)} kt — idle and brake (Space)`, 3.5);
  }

  // ============================================================ results ==

  finishLanding() {
    const g = this.game, td = this.touchdown, L = g.landing;
    this.ended = true;
    const stats = [];
    let title = 'Landed';
    let badge = '';
    if (td.onRunway && L) {
      // Score: sink rate 40, centre-line 25, touchdown zone 20, speed 15
      const sinkScore = clamp(1 - (td.fpm - 120) / 600, 0, 1);
      const lineScore = clamp(1 - (Math.abs(td.across) - 1.5) / 10, 0, 1);
      const zoneScore = td.along < 0 ? 0 : clamp(1 - Math.max(0, Math.abs(td.along - 300) - 150) / 350, 0, 1);
      const kt = td.ias * KT;
      const speedScore = clamp(1 - Math.max(0, Math.abs(kt - 58) - 6) / 18, 0, 1);
      const score = Math.round(100 * (0.4 * sinkScore + 0.25 * lineScore + 0.2 * zoneScore + 0.15 * speedScore));
      badge = score >= 90 ? 'GRADE A · ' + score : score >= 75 ? 'GRADE B · ' + score : score >= 55 ? 'GRADE C · ' + score : 'GRADE D · ' + score;
      const remaining = L.runway.length - L.local(this.flight.position.x, this.flight.position.z).along;
      stats.push(
        ['Touchdown rate', `${Math.round(td.fpm)} ft/min`],
        ['Touchdown speed', `${Math.round(kt)} kt`],
        ['Centre-line', `${Math.abs(td.across).toFixed(1)} m ${td.across > 0 ? 'right' : 'left'}`],
        ['Touchdown point', `${Math.round(td.along)} m in`],
        ['Runway remaining', `${Math.max(0, Math.round(remaining))} m`],
      );
    } else {
      title = 'Off-airport landing';
      stats.push(['Touchdown rate', `${Math.round(td.fpm)} ft/min`], ['Touchdown speed', `${Math.round(td.ias * KT)} kt`]);
    }
    stats.push(['Max g', this.maxG.toFixed(1)], ['Flight time', g.formatTime(this.flightTime)]);
    g.showSimResults({ title, subtitle: `${this.scenario.name} · ${this.scenario.place}`, badge, stats, success: true });
  }

  finishCrash(reason) {
    const g = this.game;
    this.ended = true;
    g.showSimResults({
      title: 'Crashed',
      subtitle: reason,
      badge: '',
      stats: [
        ['Airspeed', `${Math.round(this.flight.ias * KT)} kt`],
        ['Max g', this.maxG.toFixed(1)],
        ['Flight time', g.formatTime(this.flightTime)],
      ],
      success: false,
    });
  }

  // ============================================================= lesson ==

  /**
   * The instructor. Each lesson is a small state machine that watches the
   * flight (position relative to the runway, height, speed, configuration)
   * and moves to the next step when the pilot has done the current one.
   */
  updateLesson() {
    const sc = this.scenario, f = this.flight, L = this.game.landing;
    const rw = this.game.route.runway;
    let step = '', target = '';
    const aglFt = (f.position.y - 1.67 - (rw ? rw.center.y : 0)) * FT;
    const kt = f.ias * KT;
    const rwHdg = rw ? Math.atan2(rw.dir.x, -rw.dir.z) / DEG : 0;
    const loc = L ? L.local(f.position.x, f.position.z) : null;
    const tgt = (hdg, alt, spd) =>
      [hdg !== null ? `HDG <b>${fmtHdg(hdg)}</b>` : '', alt !== null ? `ALT <b>${alt} FT</b>` : '', spd !== null ? `SPD <b>${spd} KT</b>` : '']
        .filter(Boolean)
        .join(' · ');

    if (this.touchdown) {
      step = f.groundSpeed > 1 ? 'Rollout: throttle to <b>idle</b>, hold <b>Space</b> to brake, keep straight with the rudder (Q/E).' : 'Stopped. Nice flying!';
    } else if (sc.lesson === 'circuit' && rw) {
      const s = this.lessonStep;
      if (s === 0) {
        step = f.parkingBrake ? 'Ready for departure. Release the <b>parking brake (P)</b>.' : 'Apply <b>full throttle</b> (mouse wheel up or hold Shift).';
        if (!f.parkingBrake && f.throttle > 0.9) this.lessonStep = 1;
      } else if (s === 1) {
        step = `Keep the centre-line with the rudder (Q/E). At <b>55 kt</b> gently pull back (↑) to lift off.`;
        target = tgt(rwHdg, null, 55);
        if (!f.onGround && aglFt > 15) this.lessonStep = 2;
      } else if (s === 2) {
        step = `Positive climb: <b>gear up (G)</b>. Hold <b>75 kt</b> by adjusting the pitch. Flaps up (V) above 300 ft.`;
        target = tgt(rwHdg, 1000, 75);
        if (aglFt > 600 && loc.along > rw.length + 300) this.lessonStep = 3;
      } else if (s === 3) {
        step = `Turn <b>left</b> onto the crosswind leg. Bank about 20°, watch the ball on the turn coordinator.`;
        target = tgt(rwHdg - 90, 1000, 80);
        if (loc.across < -650) this.lessonStep = 4;
      } else if (s === 4) {
        step = `Turn <b>left downwind</b>. Level off at <b>1000 ft</b>, reduce power to about <b>2300 RPM</b>, trim ([ ]) for level flight.`;
        target = tgt(rwHdg + 180, 1000, 90);
        if (loc.along < 100) this.lessonStep = 5;
      } else if (s === 5) {
        step = `Abeam the threshold: <b>gear down (G)</b>, <b>flaps 10 (F)</b>, power back to about 1700 RPM and start descending.`;
        target = tgt(rwHdg + 180, 800, 75);
        if (loc.along < -700) this.lessonStep = 6;
      } else if (s === 6) {
        step = `Turn <b>left base</b>. <b>Flaps 20</b>, descend at about 500 ft/min.`;
        target = tgt(rwHdg + 90, 600, 70);
        if (loc.across > -280) this.lessonStep = 7;
      } else {
        step = `Turn <b>final</b> and line up. <b>Full flaps</b>, 65 kt. Fly the PAPI (2 white, 2 red) and flare just above the runway.`;
        target = tgt(rwHdg, null, 65);
      }
    } else if ((sc.lesson === 'approach' || sc.lesson === 'canyon') && rw) {
      if (sc.lesson === 'canyon' && loc.along < -1700) {
        step = 'Follow the canyon north. The airstrip lies beyond the canyon mouth: arrive low and slow, gear down, full flaps.';
        target = tgt(null, null, 80);
      } else {
        const a = this.approachInfo();
        const gs = a ? (a.gsDev > 0.35 ? 'You are <b>high</b>: reduce power.' : a.gsDev < -0.35 ? 'You are <b>low</b>: add power.' : 'On the glide path.') : '';
        const lc = a ? (a.locDev > 0.5 ? 'Correct <b>right</b>.' : a.locDev < -0.5 ? 'Correct <b>left</b>.' : 'On the centre-line.') : '';
        step = `${!f.gearDown ? '<b>Gear down (G)!</b> ' : ''}Fly the approach at <b>65 kt</b>, full flaps (F). ${gs} ${lc} Flare at about 20 ft.`;
        target = tgt(rwHdg, null, 65);
      }
    } else if (!rw) {
      step = 'Free flight. Explore at your own pace: there is no airfield in this area.';
    } else {
      step = f.onGround && !this.wasAirborne ? 'Release the parking brake (P), full power and take off at 55 kt.' : 'Free flight. Land on the runway whenever you like.';
    }

    if (this.lessonStep !== this.lastStep) {
      if (this.lastStep >= 0) this.game.audio.click();
      this.lastStep = this.lessonStep;
    }
    this.lesson = { step, target, kt, aglFt };
  }

  /** Angles to the runway for the ILS needles (or null when not on approach). */
  approachInfo() {
    const L = this.game.landing;
    if (!L) return null;
    const f = this.flight;
    const { along, across } = L.local(f.position.x, f.position.z);
    if (f.onGround || along > -60 || along < -9000 || Math.abs(across) > 2500) return null;
    // Localiser antenna at the far end; glide-slope antenna at the aiming point (300 m)
    const toLoc = L.runway.length - along;
    const locDev = Math.atan2(-across, toLoc) / DEG;
    const h = f.position.y - 1.67 - L.runway.center.y;
    const gsDev = Math.atan2(h, 300 - along) / DEG - 3;
    return { locDev, gsDev, dist: Math.max(0, -along) };
  }

  // =============================================================== HUD ==

  warning() {
    const f = this.flight;
    const aglFt = (f.agl - 1.5) * FT;
    if (f.crashed) return { text: f.crashed.toUpperCase(), level: 'red' };
    if (f.stallWarning) return { text: 'STALL', level: 'red' };
    if (f.ias * KT > PLANE.vne) return { text: 'OVERSPEED', level: 'red' };
    if (!f.onGround && aglFt < 400 && f.velocity.y < -7 && !this.touchdown) return { text: 'SINK RATE — PULL UP', level: 'red' };
    if (!f.onGround && !f.gearDown && aglFt < 400 && f.throttle < 0.3 && !this.game.aircraft.gearMoving) return { text: 'GEAR UP — PRESS G', level: 'amber' };
    if (f.onGround && f.parkingBrake && f.throttle > 0.4) return { text: 'PARKING BRAKE SET — PRESS P', level: 'amber' };
    if (f.outOfBounds) return { text: 'LEAVING THE SCENERY — TURN BACK', level: 'amber' };
    if (f.gLoad > 4.5) return { text: `${f.gLoad.toFixed(1)} G`, level: 'amber' };
    return null;
  }

  updateHUD(dt) {
    const g = this.game, f = this.flight;
    const rw = g.route.runway ?? null;
    const extra = {
      night: g.route.id === 'aurora',
      autoRudder: f.autoRudder,
      windText: this.wind.describe(),
      lowAlt: !f.onGround && (f.agl - 1.5) * FT < 500 && !this.touchdown && f.velocity.y < -2,
      gearMoving: g.aircraft.gearMoving,
      oat: 15 - f.position.y * 0.0065 + (g.route.id === 'canyon' ? 18 : g.route.id === 'aurora' ? -24 : 0),
    };
    const cockpit = g.cameraRig.mode === 'cockpit';

    // 3D cockpit panel texture: 30 Hz when it can be seen up close, else 4 Hz
    this.panelTimer -= dt;
    if (this.panelTimer <= 0) {
      this.panelTimer = cockpit ? 1 / 30 : 1 / 4;
      this.panelInstruments.draw(f, extra);
      this.panelTexture.needsUpdate = true;
    }

    this.hud.update(dt, {
      flight: f,
      lesson: this.lesson,
      warning: this.warning(),
      runway: rw,
      showPattern: this.scenario?.lesson === 'circuit',
      approach: this.approachInfo(),
      wind: { dir: this.wind.dir, speed: this.wind.speed },
      yoke: g.input.yokeEnabled ? g.input.yoke : null,
      gamepad: g.input.padConnected,
      cockpit,
      muted: g.audio.muted,
      resScale: g.governor.scale,
      instruments: extra,
    });
  }
}
