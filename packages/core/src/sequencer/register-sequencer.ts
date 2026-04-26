import { OPL_CHANNEL_COUNT, type OplChip } from '../chip/types.js';
import type { RegisterEventStream, RegisterStreamTiming } from './types.js';

type RenderChunk = (startFrame: number, frameCount: number) => void;

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

  /**
   * True once we've consumed every event and rendered past the stream's
   * natural endpoint, for non-looping streams. Always false when `loop`
   * is enabled (the stream never "ends" in that mode). Edge-triggers
   * exactly when the render loop crosses the boundary; consumers that
   * care about the moment should latch it themselves.
   */
  get isFinished(): boolean {
    return (
      !this.loop && this.eventIndex >= this.eventCount && this.currentSample >= this.loopSamples
    );
  }

  /** Fill `output` (stereo interleaved) with audio, firing events in sync. */
  generate(output: Float32Array): void {
    this.render(output.length >>> 1, (start, frames) => {
      this.chip.generate(output.subarray(start * 2, (start + frames) * 2));
    });
  }

  /**
   * Like `generate()`, but also fills a per-voice buffer in one pass.
   *
   * `channelsOutput` layout: frame-interleaved, total length
   * `numFrames * OPL_CHANNEL_COUNT`. See `OplChip.generateWithChannels` for
   * the per-voice semantics (pre-pan, not routed through the mix mask).
   */
  generateWithChannels(stereoOutput: Float32Array, channelsOutput: Float32Array): void {
    const totalFrames = stereoOutput.length >>> 1;
    if (channelsOutput.length < totalFrames * OPL_CHANNEL_COUNT) {
      throw new Error(
        `cawtooth: channelsOutput must hold numFrames * ${OPL_CHANNEL_COUNT} samples`,
      );
    }
    this.render(totalFrames, (start, frames) => {
      this.chip.generateWithChannels(
        stereoOutput.subarray(start * 2, (start + frames) * 2),
        channelsOutput.subarray(start * OPL_CHANNEL_COUNT, (start + frames) * OPL_CHANNEL_COUNT),
      );
    });
  }

  /**
   * Shared render loop. Handles loop-point rewind, event dispatch, and
   * chunking up to the next event boundary. Delegates actual sample
   * production to `renderChunk`, which knows whether per-voice output is
   * wanted and sources the appropriate sub-views.
   */
  private render(totalFrames: number, renderChunk: RenderChunk): void {
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

      renderChunk(produced, chunk);
      produced += chunk;
      if (this.playing) {
        this.currentSample += chunk;
      }
    }
  }
}
