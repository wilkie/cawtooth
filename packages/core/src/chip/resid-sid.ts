import { type PerVoiceChip } from './types.js';
import { asReSidExports, type ReSidExports } from './resid-loader.js';

const INT16_TO_FLOAT = 1 / 32768;
const INITIAL_SCRATCH_SAMPLES = 1024;

/** MOS 6581 (original) vs MOS 8580 (later revision with bug-fixed filter). */
export type SidChipModel = 'MOS6581' | 'MOS8580';

/**
 * reSID sampling method. SAMPLE_FAST is cheapest but aliases; RESAMPLE is
 * bandlimited and tracks the chip's native rate faithfully.
 */
export type SidSamplingMethod = 'fast' | 'interpolate' | 'resample' | 'resample-fastmem';

/** PAL / NTSC C64 clock frequencies. */
export const SID_CLOCK_PAL = 985248;
export const SID_CLOCK_NTSC = 1022727;

/** Number of voices the SID produces. Fixed at 3. */
export const SID_VOICE_COUNT = 3;

export interface SidChipOptions {
  /** Output sample rate in Hz. Typical: 44100 or 48000. */
  sampleRate: number;
  /** Host clock frequency. Defaults to PAL C64 (985248 Hz). */
  clockFrequency?: number;
  /** Chip revision. Defaults to MOS6581. */
  model?: SidChipModel;
  /** reSID resampling quality. Defaults to 'resample'. */
  samplingMethod?: SidSamplingMethod;
}

const SAMPLING_METHOD_CODE: Record<SidSamplingMethod, number> = {
  fast: 0,
  interpolate: 1,
  resample: 2,
  'resample-fastmem': 3,
};

const MODEL_CODE: Record<SidChipModel, number> = {
  MOS6581: 0,
  MOS8580: 1,
};

/**
 * TypeScript adapter around the reSID wasm build.
 *
 * One instance owns one reSID SID (with its FIR tables) inside wasm linear
 * memory plus a scratch int16 buffer used to collect native samples before
 * converting to stereo Float32. SID is natively mono; we duplicate each
 * sample into both output channels to satisfy the common stereo interface.
 *
 * Multiple SidChip instances can share one wasm instance — each has its own
 * handle and scratch pointer.
 */
export class SidChip implements PerVoiceChip {
  readonly sampleRate: number;
  readonly voiceCount = SID_VOICE_COUNT;
  readonly clockFrequency: number;
  readonly model: SidChipModel;
  readonly samplingMethod: SidSamplingMethod;

  private readonly exports: ReSidExports;
  private readonly handlePtr: number;
  private scratchPtr: number;
  private channelsScratchPtr: number;
  private scratchSamples: number;
  private disposed = false;

  constructor(instance: WebAssembly.Instance, options: SidChipOptions) {
    this.exports = asReSidExports(instance);
    this.sampleRate = options.sampleRate;
    this.clockFrequency = options.clockFrequency ?? SID_CLOCK_PAL;
    this.model = options.model ?? 'MOS6581';
    this.samplingMethod = options.samplingMethod ?? 'resample';

    this.exports._initialize?.();

    const handle = this.exports.cawtooth_sid_create(
      this.clockFrequency,
      this.sampleRate,
      MODEL_CODE[this.model],
      SAMPLING_METHOD_CODE[this.samplingMethod],
    );
    if (!handle) {
      throw new Error('cawtooth: failed to allocate SID chip');
    }
    this.handlePtr = handle;

    this.scratchSamples = INITIAL_SCRATCH_SAMPLES;
    this.scratchPtr = this.exports.malloc(this.scratchSamples * 2);
    this.channelsScratchPtr = this.exports.malloc(this.scratchSamples * SID_VOICE_COUNT * 2);
    if (!this.scratchPtr || !this.channelsScratchPtr) {
      this.exports.cawtooth_sid_destroy(handle);
      throw new Error('cawtooth: failed to allocate SID sample scratch');
    }
  }

  writeRegister(reg: number, value: number): void {
    // SID has 0x20 register offsets; mask defensively to match the C wrapper
    // which accepts uint8_t.
    this.exports.cawtooth_sid_write(this.handlePtr, reg & 0xff, value & 0xff);
  }

  readRegister(reg: number): number {
    return this.exports.cawtooth_sid_read(this.handlePtr, reg & 0xff);
  }

  /**
   * Fill `output` with stereo-interleaved samples in [-1, 1].
   *
   * SID is mono — the same sample is duplicated into L and R. Consumers that
   * want mono can read every other element.
   */
  generate(output: Float32Array): void {
    const numFrames = output.length >>> 1;
    if (numFrames === 0) return;

    this.growScratch(numFrames);
    this.exports.cawtooth_sid_generate(this.handlePtr, this.scratchPtr, numFrames);

    // Re-acquire the view: ALLOW_MEMORY_GROWTH can detach prior buffers.
    const view = new Int16Array(this.exports.memory.buffer, this.scratchPtr, numFrames);
    for (let i = 0; i < numFrames; i++) {
      const s = view[i] * INT16_TO_FLOAT;
      output[i * 2] = s;
      output[i * 2 + 1] = s;
    }
  }

  /**
   * Fill both a stereo output buffer AND a per-voice buffer in one pass.
   *
   * `channelsOutput` is frame-interleaved per voice:
   * `[f0_v0, f0_v1, f0_v2, f1_v0, ...]`, total length
   * `numFrames * 3`. Values are amplitude-modulated voice outputs scaled
   * to roughly [-1, 1] via the >>5 shift the wrapper applies (20-bit
   * reSID voice output → int16 → Float32).
   *
   * Scope view specifically: single SID voices typically peak well below
   * ±1, because the SID's master-volume DAC attenuates the mix — expect
   * to apply your own auto-scale per voice, same as the OPL scope.
   */
  generateWithChannels(stereoOutput: Float32Array, channelsOutput: Float32Array): void {
    const numFrames = stereoOutput.length >>> 1;
    if (numFrames === 0) return;
    if (channelsOutput.length < numFrames * SID_VOICE_COUNT) {
      throw new Error(
        `cawtooth: channelsOutput must hold numFrames * ${SID_VOICE_COUNT} samples ` +
          `(got ${channelsOutput.length}, need ${numFrames * SID_VOICE_COUNT})`,
      );
    }

    this.growScratch(numFrames);
    this.exports.cawtooth_sid_generate_channels(
      this.handlePtr,
      this.scratchPtr,
      this.channelsScratchPtr,
      numFrames,
    );

    const mem = this.exports.memory.buffer;
    const stereoView = new Int16Array(mem, this.scratchPtr, numFrames);
    for (let i = 0; i < numFrames; i++) {
      const s = stereoView[i] * INT16_TO_FLOAT;
      stereoOutput[i * 2] = s;
      stereoOutput[i * 2 + 1] = s;
    }

    const chView = new Int16Array(mem, this.channelsScratchPtr, numFrames * SID_VOICE_COUNT);
    for (let i = 0; i < chView.length; i++) {
      channelsOutput[i] = chView[i] * INT16_TO_FLOAT;
    }
  }

  /**
   * Generate mono samples directly — avoids the L/R duplication that
   * `generate()` does for the stereo-interleaved Chip interface. Useful for
   * tests and for analysis paths that don't need stereo.
   */
  generateMono(output: Float32Array): void {
    const numSamples = output.length;
    if (numSamples === 0) return;

    this.growScratch(numSamples);
    this.exports.cawtooth_sid_generate(this.handlePtr, this.scratchPtr, numSamples);

    const view = new Int16Array(this.exports.memory.buffer, this.scratchPtr, numSamples);
    for (let i = 0; i < numSamples; i++) {
      output[i] = view[i] * INT16_TO_FLOAT;
    }
  }

  reset(): void {
    this.exports.cawtooth_sid_reset(this.handlePtr);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exports.free(this.scratchPtr);
    this.exports.free(this.channelsScratchPtr);
    this.exports.cawtooth_sid_destroy(this.handlePtr);
  }

  private growScratch(numSamples: number): void {
    if (numSamples <= this.scratchSamples) return;
    this.exports.free(this.scratchPtr);
    this.exports.free(this.channelsScratchPtr);
    this.scratchSamples = numSamples;
    this.scratchPtr = this.exports.malloc(numSamples * 2);
    this.channelsScratchPtr = this.exports.malloc(numSamples * SID_VOICE_COUNT * 2);
    if (!this.scratchPtr || !this.channelsScratchPtr) {
      throw new Error('cawtooth: failed to grow SID sample scratch');
    }
  }
}
