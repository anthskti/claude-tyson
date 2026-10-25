// Claude Tyson — Web Audio engine.
// All music and SFX are synthesised (no external files).
//
// Fight music: dark trap-influenced beat at 110 BPM.
// Menu music:  slow tension loop at 72 BPM.
// SFX: hit thuds, dodge swoosh, wheel metallic clank, toast pings,
//      dialogue pop, victory arpeggio, defeat drop.

export class GameAudio {
  private ctx: AudioContext | null = null;
  private masterGain!: GainNode;
  private musicGain!: GainNode;
  private sfxGain!: GainNode;

  private beatStep = 0;
  private beatNextTime = 0;
  private beatHandle = 0;
  private beatMode: 'menu' | 'fight' | null = null;

  // ── AudioContext (lazy, only after user gesture) ──────────────────────

  private get ac(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.72;
      this.masterGain.connect(this.ctx.destination);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.48;
      this.musicGain.connect(this.masterGain);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.9;
      this.sfxGain.connect(this.masterGain);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  // ── Sound effects ─────────────────────────────────────────────────────

  /** Punch lands or player gets hit. */
  playHit(heavy = false) {
    const ctx = this.ac;
    const t = ctx.currentTime;

    // Body thud: sine sweep down
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(heavy ? 200 : 150, t);
    osc.frequency.exponentialRampToValueAtTime(heavy ? 38 : 55, t + 0.09);
    gain.gain.setValueAtTime(heavy ? 1.0 : 0.65, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + (heavy ? 0.2 : 0.13));
    osc.connect(gain); gain.connect(this.sfxGain);
    osc.start(t); osc.stop(t + 0.22);

    if (heavy) {
      // Extra high transient crack for heavy hits
      const buf = this.noiseBuffer(0.07);
      const src = ctx.createBufferSource();
      const filter = ctx.createBiquadFilter();
      const ng = ctx.createGain();
      filter.type = 'bandpass'; filter.frequency.value = 700; filter.Q.value = 1.2;
      ng.gain.setValueAtTime(0.5, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      src.buffer = buf; src.connect(filter); filter.connect(ng); ng.connect(this.sfxGain);
      src.start(t);
    }
  }

  /** Dodge or slip. */
  playDodge() {
    const ctx = this.ac;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(700, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.18);
    gain.gain.setValueAtTime(0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(gain); gain.connect(this.sfxGain);
    osc.start(t); osc.stop(t + 0.2);
  }

  /** Block lands. */
  playBlock() {
    const ctx = this.ac;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.06);
    gain.gain.setValueAtTime(0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain); gain.connect(this.sfxGain);
    osc.start(t); osc.stop(t + 0.1);
  }

  /** Maharagas wheel adaptation clank. */
  playWheelClank() {
    const ctx = this.ac;
    const t = ctx.currentTime;

    // Metallic ping: stacked detuned sawtoothes
    for (const [freq, delay, vol] of [[523, 0, 0.22], [698, 0.01, 0.16], [880, 0.02, 0.12]] as [number,number,number][]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 1.1);
      osc.connect(gain); gain.connect(this.sfxGain);
      osc.start(t + delay); osc.stop(t + delay + 1.2);
    }

    // Sharp metallic transient
    const tr = ctx.createOscillator();
    const tg = ctx.createGain();
    tr.type = 'square';
    tr.frequency.setValueAtTime(1800, t);
    tr.frequency.exponentialRampToValueAtTime(400, t + 0.04);
    tg.gain.setValueAtTime(0.6, t); tg.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    tr.connect(tg); tg.connect(this.sfxGain);
    tr.start(t); tr.stop(t + 0.06);
  }

  /** Toast notification ping. */
  playToast(kind: 'good' | 'bad' | 'info' = 'info') {
    const ctx = this.ac;
    const t = ctx.currentTime;
    const configs: Record<string, [number, number, OscillatorType]> = {
      good: [1047, 0.10, 'sine'],
      bad:  [196,  0.14, 'sawtooth'],
      info: [523,  0.08, 'sine'],
    };
    const [freq, dur, type] = configs[kind];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain); gain.connect(this.sfxGain);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  /** Claude Tyson dialogue bubble appears. */
  playDialogue() {
    const ctx = this.ac;
    const t = ctx.currentTime;
    for (const [f, d] of [[440, 0], [660, 0.06]] as [number,number][]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = f;
      gain.gain.setValueAtTime(0.12, t + d);
      gain.gain.exponentialRampToValueAtTime(0.001, t + d + 0.12);
      osc.connect(gain); gain.connect(this.sfxGain);
      osc.start(t + d); osc.stop(t + d + 0.15);
    }
  }

  /** Win! */
  playVictory() {
    const ctx = this.ac;
    const t = ctx.currentTime;
    // C major fanfare arpeggio, ascending + hold
    const seq: [number, number][] = [
      [523.25, 0],    // C5
      [659.25, 0.11], // E5
      [783.99, 0.22], // G5
      [1046.5, 0.33], // C6
      [783.99, 0.50], // G5
      [1046.5, 0.61], // C6 (held)
    ];
    seq.forEach(([freq, delay], i) => {
      const isLast = i === seq.length - 1;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.22, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + (isLast ? 0.65 : 0.14));
      osc.connect(gain); gain.connect(this.sfxGain);
      osc.start(t + delay); osc.stop(t + delay + (isLast ? 0.7 : 0.18));
    });
  }

  /** Lose. */
  playDefeat() {
    const ctx = this.ac;
    const t = ctx.currentTime;
    const seq: [number, number][] = [
      [392,   0],
      [349.23, 0.20],
      [311.13, 0.40],
      [261.63, 0.60],
    ];
    seq.forEach(([freq, delay], i) => {
      const isLast = i === seq.length - 1;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + (isLast ? 0.9 : 0.22));
      osc.connect(gain); gain.connect(this.sfxGain);
      osc.start(t + delay); osc.stop(t + delay + (isLast ? 0.95 : 0.26));
    });
  }

  // ── Music ─────────────────────────────────────────────────────────────

  startFightMusic() {
    if (this.beatMode === 'fight') return;
    this.startBeat('fight');
  }

  startMenuMusic() {
    if (this.beatMode === 'menu') return;
    this.startBeat('menu');
  }

  stopMusic(fadeMs = 800) {
    clearTimeout(this.beatHandle);
    this.beatMode = null;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.musicGain.gain.setTargetAtTime(0, t, fadeMs / 1000 / 3);
    setTimeout(() => { if (!this.beatMode) this.musicGain.gain.value = 0.48; }, fadeMs + 200);
  }

  private startBeat(mode: 'menu' | 'fight') {
    clearTimeout(this.beatHandle);
    this.beatMode = mode;
    this.beatStep = 0;
    this.beatNextTime = this.ac.currentTime + 0.08;
    // Fade music gain back in
    this.musicGain.gain.cancelScheduledValues(this.ac.currentTime);
    this.musicGain.gain.setTargetAtTime(0.48, this.ac.currentTime, 0.1);
    this.tick();
  }

  private tick() {
    if (!this.beatMode) return;
    const AHEAD = 0.25;
    const BPM = this.beatMode === 'fight' ? 110 : 72;
    const step16 = 60 / BPM / 4;

    while (this.beatNextTime < this.ac.currentTime + AHEAD) {
      this.scheduleStep(this.beatStep, this.beatNextTime, step16);
      this.beatStep = (this.beatStep + 1) % 32;
      this.beatNextTime += step16;
    }
    this.beatHandle = window.setTimeout(() => this.tick(), 80);
  }

  private scheduleStep(step: number, t: number, dur: number) {
    if (this.beatMode === 'fight') this.fightStep(step, t, dur);
    else                           this.menuStep(step, t, dur);
  }

  // ── Fight beat (110 BPM, 2-bar trap-inspired) ─────────────────────────
  // Steps 0-31 = 32 sixteenth-notes
  //   Kick:  0, 8, 14, 16, 24, 30
  //   Snare: 8, 24
  //   Hat:   every even step (8th notes)
  //   Bass:  A1(0,16), E2(6,22), G1(10,26)
  private fightStep(step: number, t: number, dur: number) {
    const KICK  = new Set([0, 8, 14, 16, 24, 30]);
    const SNARE = new Set([8, 24]);
    const HAT   = step % 2 === 0;
    const OPEN  = step === 6 || step === 22;

    if (KICK.has(step))  this.kick(t, SNARE.has(step) ? 0.55 : 1.0);
    if (SNARE.has(step)) this.snare(t);
    if (OPEN)            this.openHat(t);
    else if (HAT)        this.closedHat(t, step % 8 === 0 ? 0.65 : 0.35);

    const BASS: Record<number, number> = {
      0: 55, 6: 65.41, 10: 49, 16: 55, 22: 65.41, 26: 49,
    };
    if (BASS[step] !== undefined) this.bass(t, BASS[step], dur * 5.5);
  }

  // ── Menu ambient beat (72 BPM, slow + tense) ─────────────────────────
  private menuStep(step: number, t: number, dur: number) {
    if (step === 0 || step === 16) this.kick(t, 0.55);
    if (step === 8 || step === 24) this.snare(t, 0.45);
    if (step % 4 === 0) this.closedHat(t, 0.18);
    if (step === 0)  this.bass(t, 41.2, dur * 7);  // E1
    if (step === 14) this.bass(t, 36.7, dur * 3);  // D1
    if (step === 16) this.bass(t, 43.65, dur * 6); // F1
  }

  // ── Drum primitives ───────────────────────────────────────────────────

  private kick(t: number, vol = 1.0) {
    const ctx = this.ac;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.10);
    gain.gain.setValueAtTime(vol * 0.85, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(gain); gain.connect(this.musicGain);
    osc.start(t); osc.stop(t + 0.16);
  }

  private snare(t: number, vol = 1.0) {
    const ctx = this.ac;
    // Tonal body
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = 'triangle'; osc.frequency.value = 185;
    og.gain.setValueAtTime(vol * 0.28, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(og); og.connect(this.musicGain);
    osc.start(t); osc.stop(t + 0.11);
    // Noise snap
    const buf = this.noiseBuffer(0.13);
    const src = ctx.createBufferSource();
    const hp  = ctx.createBiquadFilter();
    const ng  = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 2200;
    ng.gain.setValueAtTime(vol * 0.38, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    src.buffer = buf; src.connect(hp); hp.connect(ng); ng.connect(this.musicGain);
    src.start(t);
  }

  private closedHat(t: number, vol = 0.3) {
    const ctx = this.ac;
    const buf = this.noiseBuffer(0.04);
    const src = ctx.createBufferSource();
    const hp  = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 9000;
    gain.gain.setValueAtTime(vol * 0.5, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    src.buffer = buf; src.connect(hp); hp.connect(gain); gain.connect(this.musicGain);
    src.start(t);
  }

  private openHat(t: number) {
    const ctx = this.ac;
    const buf = this.noiseBuffer(0.18);
    const src = ctx.createBufferSource();
    const hp  = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 7000;
    gain.gain.setValueAtTime(0.3, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.buffer = buf; src.connect(hp); hp.connect(gain); gain.connect(this.musicGain);
    src.start(t);
  }

  private bass(t: number, freq: number, dur: number) {
    const ctx = this.ac;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth'; osc.frequency.value = freq;
    filter.type = 'lowpass'; filter.frequency.value = 380; filter.Q.value = 3;
    gain.gain.setValueAtTime(0.55, t);
    gain.gain.setValueAtTime(0.55, t + dur * 0.72);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(filter); filter.connect(gain); gain.connect(this.musicGain);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  // ── Utility ───────────────────────────────────────────────────────────

  private noiseBuffer(durationSecs: number): AudioBuffer {
    const ctx = this.ac;
    const len = Math.ceil(ctx.sampleRate * durationSecs);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  dispose() {
    this.stopMusic(200);
    setTimeout(() => this.ctx?.close(), 600);
  }
}
