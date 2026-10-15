/**
 * Procedural sound with the Web Audio API - no audio files at all.
 *
 * Web Audio is a graph of nodes: sources (oscillators, noise buffers) flow
 * through processors (filters, gains) into the speakers. Parameters such as
 * frequency and gain are "AudioParams" that we can glide smoothly with
 * setTargetAtTime() (exponential approach), avoiding clicks.
 *
 *   ENGINE   sawtooth + square (one octave down) + sine harmonic
 *            -> low-pass filter (opens with throttle) -> "prop chop" tremolo
 *            Pitch follows throttle: f = 38 Hz + 55 Hz * throttle (+ boost).
 *   WIND     looping white noise -> band-pass filter. Volume ~ speed²,
 *            filter frequency rises with speed (higher "whoosh").
 *   AMBIENCE per route:  ocean   = low-passed noise swelling like waves
 *                        arctic  = soft detuned sine pad + thin wind
 *                        desert  = gusty band-passed wind
 *   ONE-SHOTS: ring chime (arpeggio), touchdown (thump + tyre squeal),
 *            crash (noise sweep + boom), gear motor, UI click, success jingle.
 *   SIMULATOR: engine pitch follows the real RPM; STALL HORN (a reed-like
 *            buzz: square wave through a band-pass filter, pulsing);
 *            tyre RUMBLE on the ground (low-passed noise, louder with
 *            speed); FLAP MOTOR whine while the flaps move.
 *
 * Browsers only allow audio after a user gesture (autoplay policy), so the
 * AudioContext is created in init(), called from the first click.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try {
      this.muted = localStorage.getItem('skybound.muted') === '1';
    } catch {
      /* storage unavailable: default unmuted */
    }
  }

  get ready() {
    return !!this.ctx;
  }

  /** Create the audio graph. Must be called from a user gesture (click / key). */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    // Master chain: gain -> compressor (evens out loud one-shots) -> speakers
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    // Shared 2-second white-noise buffer (random samples in [-1, 1])
    this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.buildEngine();
    this.buildWind();
    this.buildAmbience();
    this.buildSim();
  }

  buildSim() {
    const ctx = this.ctx;
    // Stall warning horn
    const horn = ctx.createOscillator();
    horn.type = 'square';
    horn.frequency.value = 410;
    const hornFilter = ctx.createBiquadFilter();
    hornFilter.type = 'bandpass';
    hornFilter.frequency.value = 820;
    hornFilter.Q.value = 2.5;
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    horn.connect(hornFilter).connect(this.hornGain).connect(this.master);
    horn.start();
    // Tyre rumble
    const rumble = this.noise();
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 120;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rumble.connect(this.rumbleFilter).connect(this.rumbleGain).connect(this.master);
    rumble.start();
    // Flap motor
    const motor = ctx.createOscillator();
    motor.type = 'sawtooth';
    motor.frequency.value = 160;
    const motorFilter = ctx.createBiquadFilter();
    motorFilter.type = 'lowpass';
    motorFilter.frequency.value = 700;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    motor.connect(motorFilter).connect(this.motorGain).connect(this.master);
    motor.start();
  }

  noise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    return src;
  }

  buildEngine() {
    const ctx = this.ctx;
    this.engOsc = [ctx.createOscillator(), ctx.createOscillator(), ctx.createOscillator()];
    this.engOsc[0].type = 'sawtooth';
    this.engOsc[1].type = 'square';
    this.engOsc[2].type = 'sine';
    const mix = [0.5, 0.35, 0.25].map((v) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    });
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 3;
    // Prop "chop": a low-frequency oscillator modulating the gain (tremolo)
    this.engChop = ctx.createGain();
    this.engChop.gain.value = 0.75;
    this.chopLfo = ctx.createOscillator();
    this.chopLfo.frequency.value = 20;
    const chopDepth = ctx.createGain();
    chopDepth.gain.value = 0.25;
    this.chopLfo.connect(chopDepth).connect(this.engChop.gain);
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engOsc.forEach((o, i) => o.connect(mix[i]).connect(this.engFilter));
    this.engFilter.connect(this.engChop).connect(this.engGain).connect(this.master);
    this.engOsc.forEach((o) => o.start());
    this.chopLfo.start();
  }

  buildWind() {
    const ctx = this.ctx;
    const src = this.noise();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 0.8;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();
  }

  buildAmbience() {
    const ctx = this.ctx;
    // Ocean: low rumble of noise whose volume swells slowly (waves)
    const sea = this.noise();
    const seaFilter = ctx.createBiquadFilter();
    seaFilter.type = 'lowpass';
    seaFilter.frequency.value = 480;
    this.seaSwell = ctx.createGain();
    this.seaSwell.gain.value = 0.5;
    const swellLfo = ctx.createOscillator();
    swellLfo.frequency.value = 0.11;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 0.45;
    swellLfo.connect(swellDepth).connect(this.seaSwell.gain);
    this.seaGain = ctx.createGain();
    this.seaGain.gain.value = 0;
    sea.connect(seaFilter).connect(this.seaSwell).connect(this.seaGain).connect(this.master);
    sea.start();
    swellLfo.start();

    // Arctic: soft A-minor pad of slightly detuned sines (gentle beating)
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;
    for (const f of [110, 110.6, 164.8, 220.4, 261.6]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.18;
      o.connect(g).connect(this.padGain);
      o.start();
    }
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 900;
    this.padGain.connect(padFilter).connect(this.master);

    // Desert: gusty wind = noise through a band-pass whose frequency wanders
    const dust = this.noise();
    this.gustFilter = ctx.createBiquadFilter();
    this.gustFilter.type = 'bandpass';
    this.gustFilter.frequency.value = 700;
    this.gustFilter.Q.value = 1.4;
    this.gustGain = ctx.createGain();
    this.gustGain.gain.value = 0;
    dust.connect(this.gustFilter).connect(this.gustGain).connect(this.master);
    dust.start();
    this.time = 0;
  }

  /**
   * Called every frame.
   * @param {object} s { active, throttle, speed, boosting, cockpit, altitude, ambience }
   */
  update(dt, s) {
    if (!this.ctx) return;
    this.time += dt;
    const t = this.ctx.currentTime;
    const glide = (param, value, tc = 0.12) => param.setTargetAtTime(value, t, tc);

    // ---- Engine (simulator: pitch from the engine RPM) ----
    const power = s.sim ? Math.max((s.sim.rpm - 600) / 2100, 0) : s.boosting ? 1.25 : s.throttle;
    const f0 = 38 + power * 55;
    glide(this.engOsc[0].frequency, f0);
    glide(this.engOsc[1].frequency, f0 * 0.5);
    glide(this.engOsc[2].frequency, f0 * 2);
    glide(this.chopLfo.frequency, f0 * 0.5);
    glide(this.engFilter.frequency, 250 + power * 1100);
    const engVol = s.active ? (0.16 + power * 0.14) * (s.cockpit ? 1.5 : 1) : s.idle ? 0.04 : 0;
    glide(this.engGain.gain, engVol, 0.2);

    // ---- Wind: louder and brighter with speed (muffled in the cockpit) ----
    const sp = Math.max(0, (s.speed - 15) / 70);
    glide(this.windFilter.frequency, 350 + s.speed * 14);
    glide(this.windGain.gain, s.active ? Math.min(0.5, sp * sp * 0.45) * (s.cockpit ? 0.45 : 1) : 0, 0.25);

    // ---- Route ambience ----
    const amb = s.ambience;
    const near = Math.max(0, Math.min(1, 1 - (s.altitude - 15) / 250)); // stronger when low
    glide(this.seaGain.gain, amb === 'ocean' ? 0.08 + near * 0.32 : 0, 0.6);
    glide(this.padGain.gain, amb === 'arctic' ? 0.05 : 0, 1.0);
    const gust = 0.5 + 0.5 * Math.sin(this.time * 0.37) * Math.sin(this.time * 0.13 + 1);
    glide(this.gustFilter.frequency, 500 + gust * 700, 0.5);
    glide(this.gustGain.gain, amb === 'desert' ? 0.03 + gust * 0.07 : amb === 'arctic' ? 0.03 : 0, 0.5);

    // ---- Simulator sounds ----
    const sim = s.sim;
    const pulse = 0.75 + 0.25 * Math.sin(this.time * 18);
    glide(this.hornGain.gain, sim?.stallWarning ? 0.09 * pulse : 0, 0.03);
    const roll = sim ? Math.min(sim.rolling / 30, 1) : 0;
    glide(this.rumbleFilter.frequency, 90 + roll * 260);
    glide(this.rumbleGain.gain, roll > 0.01 ? 0.08 + roll * 0.3 : 0, 0.08);
    glide(this.motorGain.gain, sim?.flapsMoving ? 0.025 : 0, 0.1);
    if (sim?.crashed) glide(this.engGain.gain, 0, 0.3);
  }

  // ---------------------------------------------------------- one-shots --

  /** Short enveloped oscillator note. */
  tone(freq, start, dur, { type = 'sine', vol = 0.3, attack = 0.005 } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(this.master);
    o.start(start);
    o.stop(start + dur + 0.05);
    return o;
  }

  /** Filtered noise burst. */
  burst(start, dur, { type = 'lowpass', freq = 1000, toFreq = null, q = 1, vol = 0.4 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, start);
    if (toFreq) f.frequency.exponentialRampToValueAtTime(toFreq, start + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(start);
    src.stop(start + dur + 0.05);
  }

  /** Ring passed: bright rising arpeggio C6-E6-G6-C7. */
  chime() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
      this.tone(f, t + i * 0.06, 0.7, { type: 'triangle', vol: 0.16 });
      this.tone(f * 2, t + i * 0.06, 0.35, { type: 'sine', vol: 0.04 });
    });
  }

  /** Touchdown: low thump + tyre squeal (louder for a firmer landing). */
  touchdown(sink = 1.5) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = Math.min(1, sink / 4);
    const o = this.tone(80, t, 0.35, { vol: 0.3 + k * 0.4 });
    o.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    this.burst(t, 0.35 + k * 0.3, { type: 'bandpass', freq: 2600, toFreq: 1800, q: 4, vol: 0.15 + k * 0.25 });
  }

  /** Crash: noise sweeping down + deep boom. */
  crash() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.burst(t, 1.2, { freq: 3000, toFreq: 80, vol: 0.8 });
    const o = this.tone(60, t, 1.0, { vol: 0.6 });
    o.frequency.exponentialRampToValueAtTime(25, t + 0.9);
  }

  /** Landing-gear hydraulic motor: rising whine then a clunk. */
  gear() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.tone(140, t, 1.7, { type: 'sawtooth', vol: 0.05, attack: 0.2 });
    o.frequency.linearRampToValueAtTime(220, t + 1.6);
    this.burst(t + 1.75, 0.12, { freq: 400, vol: 0.35 });
  }

  click() {
    if (!this.ctx) return;
    this.tone(880, this.ctx.currentTime, 0.08, { vol: 0.12 });
  }

  /** Route finished: major-key fanfare. */
  success() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => this.tone(f, t + i * 0.11, 0.9, { type: 'triangle', vol: 0.14 }));
    [261.63, 392].forEach((f) => this.tone(f, t + 0.44, 1.4, { vol: 0.1, attack: 0.05 }));
  }

  toggleMute() {
    this.muted = !this.muted;
    try {
      localStorage.setItem('skybound.muted', this.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }
}
