import { OPL_CHANNEL_COUNT, type OplChip } from './types.js';
import { asNukedOpl3Exports, type NukedOpl3Exports } from './loader.js';

const INT16_TO_FLOAT = 1 / 32768;
const INITIAL_SCRATCH_FRAMES = 1024;

/**
 * TypeScript adapter around the Nuked-OPL3 wasm build.
 *
 * One instance owns one chip struct inside the wasm linear memory plus a
 * scratch int16 buffer used to collect native samples before converting to
 * Float32. Multiple chips can share one wasm instance safely — each has its
 * own chipPtr and scratchPtr.
 */
export class NukedOpl3Chip implements OplChip {
  readonly sampleRate: number;
  readonly voiceCount = OPL_CHANNEL_COUNT;

  private readonly exports: NukedOpl3Exports;
  private readonly chipPtr: number;
  private stereoPtr: number;
  private channelsPtr: number;
  private scratchFrames: number;
  private disposed = false;

  constructor(instance: WebAssembly.Instance, sampleRate: number) {
    this.exports = asNukedOpl3Exports(instance);
    this.sampleRate = sampleRate;

    // Standalone wasm modules expose _initialize() for one-time static init.
    this.exports._initialize?.();

    const chipPtr = this.exports.cawtooth_opl_create(sampleRate);
    if (!chipPtr) {
      throw new Error('cawtooth: failed to allocate OPL3 chip');
    }
    this.chipPtr = chipPtr;

    this.scratchFrames = INITIAL_SCRATCH_FRAMES;
    this.stereoPtr = this.exports.malloc(this.scratchFrames * 2 * 2);
    this.channelsPtr = this.exports.malloc(this.scratchFrames * OPL_CHANNEL_COUNT * 2);
    if (!this.stereoPtr || !this.channelsPtr) {
      this.exports.cawtooth_opl_destroy(chipPtr);
      throw new Error('cawtooth: failed to allocate sample scratch buffers');
    }
  }

  writeRegister(reg: number, value: number): void {
    this.exports.cawtooth_opl_write(this.chipPtr, reg, value);
  }

  generate(output: Float32Array): void {
    const numFrames = output.length >>> 1;
    if (numFrames === 0) return;

    this.growScratch(numFrames);
    this.exports.cawtooth_opl_generate(this.chipPtr, this.stereoPtr, numFrames);

    // Re-acquire the view each call: wasm memory may have been detached
    // and replaced if anything triggered a grow between calls.
    const view = new Int16Array(this.exports.memory.buffer, this.stereoPtr, numFrames * 2);
    for (let i = 0; i < view.length; i++) {
      output[i] = view[i] * INT16_TO_FLOAT;
    }
  }

  /**
   * Fill both a stereo output buffer and a per-voice buffer in one pass.
   *
   * `channelsOutput` layout is frame-interleaved: `[f0_ch0, f0_ch1, ...,
   * f0_ch17, f1_ch0, ...]`. Its length must be `numFrames * 18`, where
   * `numFrames = stereoOutput.length / 2`.
   *
   * Per-channel values are the pre-pan operator sum for each voice, snapshotted
   * at the native OPL rate inside the mix loop (see the cawtooth Nuked patch).
   * They lag the stereo mix by at most one native sample and ignore the
   * per-channel CHA-CHD routing bits, so visualizers see voices independent of
   * whether they're routed to the main output.
   */
  generateWithChannels(stereoOutput: Float32Array, channelsOutput: Float32Array): void {
    const numFrames = stereoOutput.length >>> 1;
    if (numFrames === 0) return;
    if (channelsOutput.length < numFrames * OPL_CHANNEL_COUNT) {
      throw new Error(
        `cawtooth: channelsOutput must hold numFrames * ${OPL_CHANNEL_COUNT} samples ` +
          `(got ${channelsOutput.length}, need ${numFrames * OPL_CHANNEL_COUNT})`,
      );
    }

    this.growScratch(numFrames);
    this.exports.cawtooth_opl_generate_channels(
      this.chipPtr,
      this.stereoPtr,
      this.channelsPtr,
      numFrames,
    );

    const mem = this.exports.memory.buffer;
    const stereoView = new Int16Array(mem, this.stereoPtr, numFrames * 2);
    for (let i = 0; i < stereoView.length; i++) {
      stereoOutput[i] = stereoView[i] * INT16_TO_FLOAT;
    }

    const chView = new Int16Array(mem, this.channelsPtr, numFrames * OPL_CHANNEL_COUNT);
    for (let i = 0; i < chView.length; i++) {
      channelsOutput[i] = chView[i] * INT16_TO_FLOAT;
    }
  }

  reset(): void {
    this.exports.cawtooth_opl_reset(this.chipPtr, this.sampleRate);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exports.free(this.stereoPtr);
    this.exports.free(this.channelsPtr);
    this.exports.cawtooth_opl_destroy(this.chipPtr);
  }

  private growScratch(numFrames: number): void {
    if (numFrames <= this.scratchFrames) return;
    this.exports.free(this.stereoPtr);
    this.exports.free(this.channelsPtr);
    this.scratchFrames = numFrames;
    this.stereoPtr = this.exports.malloc(numFrames * 2 * 2);
    this.channelsPtr = this.exports.malloc(numFrames * OPL_CHANNEL_COUNT * 2);
    if (!this.stereoPtr || !this.channelsPtr) {
      throw new Error('cawtooth: failed to grow sample scratch buffers');
    }
  }
}
