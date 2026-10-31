import { clamp } from './utils.js';

/** Tiny procedural audio kit — no asset downloads, all synthesised. */
export class AudioKit {
  constructor() {
    this.ready = false;
    this.enabled = true;
    this.volume = 0.7;      // 0…1, the player's master volume
    this.muted = false;
    this.ctx = null;
    this.master = null;
    this.engineGain = null;
    this.windGain = null;
    this.rumbleGain = null;
  }

  init() {
    if (this.ready) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch (err) {
      // a locked-down webview can refuse an AudioContext outright: the game
      // keeps playing, it is just silent
      console.warn('[audio] unavailable —', err?.message || err);
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterGain();
    this.master.connect(this.ctx.destination);

    // engine: two detuned saws through a lowpass
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.0;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    filter.Q.value = 4;
    this.engineFilter = filter;
    this.oscA = this.ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscA.frequency.value = 52;
    this.oscB = this.ctx.createOscillator();
    this.oscB.type = 'square';
    this.oscB.frequency.value = 78;
    const sub = this.ctx.createGain();
    sub.gain.value = 0.35;
    this.oscA.connect(filter);
    this.oscB.connect(sub).connect(filter);
    filter.connect(this.engineGain).connect(this.master);
    this.oscA.start(); this.oscB.start();

    // wind noise
    const noise = this.noiseSource(3);
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;
    const wf = this.ctx.createBiquadFilter();
    wf.type = 'bandpass'; wf.frequency.value = 700; wf.Q.value = 0.7;
    noise.connect(wf).connect(this.windGain).connect(this.master);

    // tornado rumble
    const noise2 = this.noiseSource(2.5);
    this.rumbleGain = this.ctx.createGain();
    this.rumbleGain.gain.value = 0;
    const rf = this.ctx.createBiquadFilter();
    rf.type = 'lowpass'; rf.frequency.value = 130;
    noise2.connect(rf).connect(this.rumbleGain).connect(this.master);

    this.ready = true;
  }

  /**
   * The gain the master node should have right now. 0.72 at full volume keeps
   * the mix where it was tuned (the old fixed value was 0.5), and muting is a
   * real zero rather than a flag the sound effects have to remember to check.
   */
  masterGain() {
    if (this.muted) return 0;
    return Math.max(0, Math.min(1, this.volume)) * 0.72;
  }

  /** Applies volume/mute to a live graph (safe to call before init()). */
  applyGain() {
    this.enabled = !this.muted && this.volume > 0;
    if (!this.ready || !this.master) return;
    try {
      this.master.gain.setTargetAtTime(this.masterGain(), this.ctx.currentTime, 0.05);
    } catch {
      this.master.gain.value = this.masterGain();
    }
  }

  setVolume(v) {
    const n = Number(v);
    this.volume = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : this.volume;
    this.applyGain();
    return this.volume;
  }

  setMuted(on) {
    this.muted = Boolean(on);
    this.applyGain();
    return this.muted;
  }

  noiseSource(seconds = 2) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true; src.start();
    return src;
  }

  setEngine(speedKmh, boosting = false) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const f = 46 + clamp(speedKmh, 0, 170) * 0.85;
    this.oscA.frequency.setTargetAtTime(f, t, 0.08);
    this.oscB.frequency.setTargetAtTime(f * 1.51, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(360 + speedKmh * 9, t, 0.1);
    this.engineGain.gain.setTargetAtTime(0.055 + clamp(speedKmh / 170, 0, 1) * 0.085 + (boosting ? 0.03 : 0), t, 0.15);
  }

  setAmbience(wind = 0, rumble = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(clamp(wind, 0, 1) * 0.22, t, 0.3);
    this.rumbleGain.gain.setTargetAtTime(clamp(rumble, 0, 1) * 0.5, t, 0.35);
  }

  blip(freq = 660, dur = 0.09, type = 'square', vol = 0.12) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.6), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  noiseBurst(dur = 0.18, freq = 900, vol = 0.22, type = 'highpass') {
    if (!this.ready) return;
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  hit() { this.noiseBurst(0.16, 220, 0.3, 'lowpass'); this.blip(120, 0.12, 'sawtooth', 0.09); }
  crash() { this.noiseBurst(0.42, 380, 0.34, 'lowpass'); this.blip(70, 0.3, 'sawtooth', 0.12); }
  swing() { this.noiseBurst(0.11, 1500, 0.12); }
  shot() { this.noiseBurst(0.13, 2400, 0.3); this.blip(240, 0.1, 'square', 0.1); }
  pickup() { this.blip(880, 0.08, 'triangle', 0.1); setTimeout(() => this.blip(1180, 0.08, 'triangle', 0.08), 60); }
  creak() { this.noiseBurst(0.4, 240, 0.07, 'lowpass'); this.blip(92, 0.26, 'sawtooth', 0.045); }
  craft() { [520, 700, 940].forEach((f, i) => setTimeout(() => this.blip(f, 0.12, 'triangle', 0.09), i * 90)); }
  alarm() { [0, 220, 440].forEach((d) => setTimeout(() => this.blip(420, 0.16, 'square', 0.08), d)); }
}
