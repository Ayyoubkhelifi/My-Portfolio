/**
 * sound.ts — Web Audio synthesis engine for the Swarm Rebuild intro.
 *
 * All sounds are synthesized via the Web Audio API — zero audio files,
 * zero autoplay policy concerns (AudioContext created only on user gesture).
 *
 * Sound design per §4.8:
 *   - D-pentatonic-minor scale, own partials/voice graph (not the reference's E-major)
 *   - cursor launch: 40–80 Hz sine sweep (−30 dBFS)
 *   - grab: 1.2 kHz short triangle tick (−34 dBFS)
 *   - type: per-line typing noise burst band-limited (−38 dBFS)
 *   - element resolve: gentle pop (noise + sine, −28 dBFS)
 *   - completion: tiny two-note motif (−26 dBFS)
 *   - Master limiter keeps output below −20 dBFS
 */

// ─── dBFS conversion ──────────────────────────────────────────────────────────

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

// ─── SoundEngine class ────────────────────────────────────────────────────────

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private enabled = false;

  /** Must be called inside a user gesture to create the AudioContext. */
  enable(): void {
    if (this.ctx) return;

    try {
      this.ctx = new AudioContext();
      // Master gain (−20 dBFS ceiling)
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = dbToGain(-20);

      // Brick-wall limiter
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -6; // dBFS
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.001;
      this.limiter.release.value = 0.1;

      this.masterGain.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
      this.enabled = true;
    } catch {
      // Web Audio not available — degrade silently
      this.enabled = false;
    }
  }

  disable(): void {
    if (!this.ctx) return;
    try {
      this.ctx.close();
    } catch { /* ignore */ }
    this.ctx = null;
    this.masterGain = null;
    this.limiter = null;
    this.enabled = false;
  }

  get isEnabled(): boolean {
    return this.enabled && this.ctx !== null;
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  private connect(node: AudioNode): void {
    if (this.masterGain) node.connect(this.masterGain);
  }

  private createOsc(
    type: OscillatorType,
    freq: number,
    gain: number,
    startTime: number,
    duration: number
  ): void {
    if (!this.ctx || !this.masterGain) return;
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gainNode.gain.setValueAtTime(gain, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gainNode);
    this.connect(gainNode);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
  }

  private createNoiseBurst(
    gain: number,
    startTime: number,
    duration: number,
    lowFreq: number,
    highFreq: number
  ): void {
    if (!this.ctx || !this.masterGain) return;

    // Buffer of white noise
    const bufferSize = Math.ceil(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    // Band-pass filter
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = (lowFreq + highFreq) / 2;
    filter.Q.value = (lowFreq + highFreq) / (2 * (highFreq - lowFreq));

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(gain, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    source.connect(filter);
    filter.connect(gainNode);
    this.connect(gainNode);
    source.start(startTime);
    source.stop(startTime + duration + 0.01);
  }

  // ─── Public sound events ────────────────────────────────────────────────────

  /** Soft 40–80 Hz sine sweep for cursor launch (−30 dBFS) */
  playCursorLaunch(): void {
    if (!this.isEnabled || !this.ctx) return;
    const t = this.now;
    const gain = dbToGain(-30);
    if (!this.ctx || !this.masterGain) return;
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(40, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.15);
    gainNode.gain.setValueAtTime(gain, t);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gainNode);
    this.connect(gainNode);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  /** 1.2 kHz short triangle tick for grab (−34 dBFS) */
  playGrab(): void {
    if (!this.isEnabled) return;
    this.createOsc("triangle", 1200, dbToGain(-34), this.now, 0.04);
  }

  /** Per-line typing noise burst (−38 dBFS) */
  playTyping(): void {
    if (!this.isEnabled) return;
    // Band-limited noise clack between 1–4 kHz
    this.createNoiseBurst(dbToGain(-38), this.now, 0.025, 1000, 4000);
  }

  /** Gentle pop for element resolve: noise + sine (−28 dBFS) */
  playElementResolve(): void {
    if (!this.isEnabled || !this.ctx) return;
    const t = this.now;
    // Brief sine component (D4 = 293 Hz, D-pent-minor root)
    this.createOsc("sine", 293, dbToGain(-30), t, 0.08);
    // Noise transient
    this.createNoiseBurst(dbToGain(-28), t, 0.03, 200, 2000);
  }

  /**
   * Completion motif: tiny two-note gesture (D4 → A4, D-pent-minor).
   * (−26 dBFS)
   */
  playCompletion(): void {
    if (!this.isEnabled || !this.ctx) return;
    const t = this.now;
    // D4 = 293.66 Hz, A4 = 440 Hz
    this.createOsc("sine", 293.66, dbToGain(-26), t, 0.12);
    this.createOsc("sine", 440, dbToGain(-28), t + 0.1, 0.18);
  }
}
