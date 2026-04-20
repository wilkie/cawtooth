import type { OplChip } from '../chip/types.js';
import type { RegisterEventStream, RegisterStreamTiming } from './types.js';

/**
 * Drives an OPL chip from a RegisterEventStream in sample-accurate time.
 *
 * The sequencer is pure and synchronous — it owns a chip, maintains a
 * playback cursor, and interleaves register writes with audio generation
 * whenever `generate()` is called. The same class runs inside the audio
 * worklet and from Node-side unit tests.
 *
 * Timing notes:
 *   - Each event's target sample offset from song start is precomputed at
 *     load time to avoid per-frame multiply and to keep long-running
 *     playback drift-free.
 *   - Target offsets are rounded to integer samples. Per-event error is at
 *     most half a sample (~10 microseconds at 48 kHz); rounding every
 *     target independently rather than accumulating means error does not
 *     compound across the stream.
 */
export class RegisterSequencer {
  private readonly chip: OplChip;

  private regs: Uint16Array = new Uint16Array(0);
  private values: Uint8Array = new Uint8Array(0);
  private targetSamples: Uint32Array = new Uint32Array(0);
  private eventCount = 0;

  private eventIndex = 0;
  private currentSample = 0;
  private loopSamples = 0;
  private playing = false;
  private loop = false;

  constructor(chip: OplChip) {
    this.chip = chip;
  }

  /** Replace the current event stream. Resets position; does not auto-play. */
  loadStream(stream: RegisterEventStream, timing: RegisterStreamTiming): void {
    const n = stream.regs.length;
    if (stream.values.length !== n || stream.delayTicks.length !== n) {
      throw new Error('cawtooth: RegisterEventStream parallel arrays must be the same length');
    }
    if (timing.tickRate <= 0) {
      throw new Error('cawtooth: tickRate must be positive');
    }

    this.regs = stream.regs;
    this.values = stream.values;
    this.targetSamples = new Uint32Array(n);

    const tickToSample = this.chip.sampleRate / timing.tickRate;
    let cumulativeTicks = 0;
    for (let i = 0; i < n; i++) {
      this.targetSamples[i] = Math.round(cumulativeTicks * tickToSample);
      cumulativeTicks += stream.delayTicks[i];
    }
    this.loopSamples = Math.round(cumulativeTicks * tickToSample);

    this.eventCount = n;
    this.eventIndex = 0;
    this.currentSample = 0;
    this.loop = timing.loop ?? false;
    this.playing = false;
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  /** Stop playback, rewind to the start, and reset the chip to silence. */
  stop(): void {
    this.playing = false;
    this.eventIndex = 0;
    this.currentSample = 0;
    this.chip.reset();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Current playback position in seconds from song start. */
  get currentTime(): number {
    return this.currentSample / this.chip.sampleRate;
  }

  /** Total song length in seconds, including the final event's trailing delay. */
  get duration(): number {
    return this.loopSamples / this.chip.sampleRate;
  }

  /** Fill `output` (stereo interleaved) with audio, firing events in sync. */
  generate(output: Float32Array): void {
    const totalFrames = output.length >>> 1;
    let produced = 0;

    while (produced < totalFrames) {
      // Loop rewind: if we've run out of events AND crossed the loop boundary.
      if (
        this.playing &&
        this.loop &&
        this.eventIndex >= this.eventCount &&
        this.currentSample >= this.loopSamples &&
        this.loopSamples > 0
      ) {
        this.eventIndex = 0;
        this.currentSample -= this.loopSamples;
      }

      // Fire any events whose time has arrived. Several may share the same
      // target sample (e.g. a whole patch programmed in one tick).
      while (
        this.playing &&
        this.eventIndex < this.eventCount &&
        this.targetSamples[this.eventIndex] <= this.currentSample
      ) {
        this.chip.writeRegister(this.regs[this.eventIndex], this.values[this.eventIndex]);
        this.eventIndex++;
      }

      // Determine the largest chunk we can safely generate without crossing
      // the next event boundary (or the loop boundary).
      const remaining = totalFrames - produced;
      let chunk = remaining;
      if (this.playing) {
        if (this.eventIndex < this.eventCount) {
          chunk = Math.min(chunk, this.targetSamples[this.eventIndex] - this.currentSample);
        } else if (this.loop && this.loopSamples > 0) {
          chunk = Math.min(chunk, this.loopSamples - this.currentSample);
        }
      }
      if (chunk < 1) chunk = 1;

      this.chip.generate(output.subarray(produced * 2, (produced + chunk) * 2));
      produced += chunk;
      if (this.playing) {
        this.currentSample += chunk;
      }
    }
  }
}
