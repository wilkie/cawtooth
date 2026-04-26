import { type PerVoiceChip } from './types.js';
import { asAyumiExports, type AyumiExports } from './ayumi-loader.js';

const INT16_TO_FLOAT = 1 / 32768;
const INITIAL_SCRATCH_FRAMES = 1024;

/** AY-3-8910 (General Instrument) vs YM2149 (Yamaha second-source). */
export type AyChipModel = 'AY-3-8910' | 'YM2149';

/** Number of tone channels the AY produces. Fixed at 3. */
export const AY_VOICE_COUNT = 3;

/** Common host clocks for the AY-3-8910 family. */
export const AY_CLOCK_ZX = 1773400; // ZX Spectrum (3.5 MHz / 2)
export const AY_CLOCK_ATARI_ST = 2000000; // Atari ST
export const AY_CLOCK_AMSTRAD_CPC = 1000000; // Amstrad CPC
export const AY_CLOCK_MSX = 1789773; // MSX (3.579545 MHz / 2)

export interface AyChipOptions {
  /** Output sample rate in Hz. Typical: 44100 or 48000. */
  sampleRate: number;
  /** Host clock frequency. Defaults to ZX Spectrum (1.7734 MHz). */
  clockFrequency?: number;
  /** Chip variant. Defaults to AY-3-8910. */
  model?: AyChipModel;
  /**
   * Per-channel pan position in [0, 1]. 0 = full left, 1 = full right,
   * 0.5 = center. Defaults to ABC stereo (A=L, B=center, C=R), the
   * standard ZX Spectrum convention. Pass an alternate triple to switch
   * to ACB stereo (A=L, B=R, C=center) used by some Atari ST trackers,
   * or [0.5, 0.5, 0.5] for mono mixdown.
   */
  pan?: readonly [number, number, number];
}

const MODEL_CODE: Record<AyChipModel, number> = {
  'AY-3-8910': 0,
  YM2149: 1,
};

/**
 * TypeScript adapter around the Ayumi wasm build.
 *
 * One instance owns one Ayumi struct (with its FIR delay lines and DC
 * filters) inside wasm linear memory plus int16 scratch buffers used to
 * collect native samples before converting to stereo Float32. Multiple
 * chip instances can share one wasm instance — each has its own handle
 * and scratch pointers.
 *
 * The chip exposes the AY-3-8910's 16-byte register file directly via
 * `writeRegister(reg, value)` / `readRegister(reg)`, matching every
 * wild-corpus AY format (.vtx, .ym, .psg, register-dump VGM). The
 * higher-level Ayumi setters (set_tone, set_envelope, etc.) are not
 * exposed — register writes route through the wrapper's internal
 * decoder, so all code paths agree on hardware semantics.
 */
export class AyumiChip implements PerVoiceChip {
  readonly sampleRate: number;
  readonly voiceCount = AY_VOICE_COUNT;
  readonly clockFrequency: number;
  readonly model: AyChipModel;

  private readonly exports: AyumiExports;
  private readonly handlePtr: number;
  private scratchPtr: number;
  private channelsScratchPtr: number;
  private scratchFrames: number;
  private disposed = false;

  constructor(instance: WebAssembly.Instance, options: AyChipOptions) {
    this.exports = asAyumiExports(instance);
    this.sampleRate = options.sampleRate;
    this.clockFrequency = options.clockFrequency ?? AY_CLOCK_ZX;
    this.model = options.model ?? 'AY-3-8910';

    this.exports._initialize?.();

    const handle = this.exports.cawtooth_ay_create(
      MODEL_CODE[this.model],
      this.clockFrequency,
      this.sampleRate,
    );
    if (!handle) {
      // ayumi_configure fails when sample_rate is too high relative to
      // clock_rate (its internal step exceeds 1.0). The check is
      // `clock_rate / (sample_rate * 8 * 24) < 1` — at our typical
      // 1.77 MHz / 48 kHz that's 0.19, so this should never trigger
      // unless someone passes pathological numbers.
      throw new Error(
        `cawtooth: failed to allocate AY chip ` +
          `(clock=${this.clockFrequency}, sampleRate=${this.sampleRate}). ` +
          `Sample rate must be low enough that clock/(sampleRate*192) < 1.`,
      );
    }
    this.handlePtr = handle;

    // Apply caller's pan triple if given. Default ABC stereo is set by
    // the C wrapper at create time so we only need to override.
    if (options.pan) {
      for (let i = 0; i < 3; i++) {
        this.exports.cawtooth_ay_set_pan(handle, i, options.pan[i], 1);
      }
    }

    this.scratchFrames = INITIAL_SCRATCH_FRAMES;
    this.scratchPtr = this.exports.malloc(this.scratchFrames * 2 * 2); // stereo int16
    this.channelsScratchPtr = this.exports.malloc(this.scratchFrames * AY_VOICE_COUNT * 2);
    if (!this.scratchPtr || !this.channelsScratchPtr) {
      this.exports.cawtooth_ay_destroy(handle);
      throw new Error('cawtooth: failed to allocate AY sample scratch');
    }
  }

  /**
   * Write an AY register (0–15). Out-of-range registers are silently
   * ignored by the wasm wrapper. Only the low 8 bits of `value` are
   * used; the AY's data bus is 8-bit.
   */
  writeRegister(reg: number, value: number): void {
    this.exports.cawtooth_ay_write(this.handlePtr, reg & 0x0f, value & 0xff);
  }

  readRegister(reg: number): number {
    return this.exports.cawtooth_ay_read(this.handlePtr, reg & 0x0f);
  }

  /**
   * Update per-channel pan. `pan` ∈ [0, 1]; 0 = L, 1 = R, 0.5 = center.
   * Equal-power panning is used (`sqrt`-based) — standard for music apps.
   */
  setPan(channel: number, pan: number): void {
    if (channel < 0 || channel > 2) return;
    this.exports.cawtooth_ay_set_pan(this.handlePtr, channel, pan, 1);
  }

  /**
   * Fill `output` with stereo-interleaved Float32 samples in [-1, 1].
   * Ayumi's internal pan + 8× FIR oversample means the output is already
   * stereo at the chip level — we don't duplicate samples like the SID
   * wrapper does for mono-to-stereo.
   */
  generate(output: Float32Array): void {
    const numFrames = output.length >>> 1;
    if (numFrames === 0) return;

    this.growScratch(numFrames);
    this.exports.cawtooth_ay_generate(this.handlePtr, this.scratchPtr, numFrames);

    // Re-acquire the view: ALLOW_MEMORY_GROWTH can detach prior buffers.
    const view = new Int16Array(this.exports.memory.buffer, this.scratchPtr, numFrames * 2);
    for (let i = 0; i < numFrames * 2; i++) {
      output[i] = view[i] * INT16_TO_FLOAT;
    }
  }

  /**
   * Fill both a stereo output buffer AND a per-voice buffer in one pass.
   *
   * `channelsOutput` is frame-interleaved per voice:
   * `[f0_v0, f0_v1, f0_v2, f1_v0, ...]`, total length
   * `numFrames * 3`. Per-voice values are pre-pan, pre-mix DAC samples
   * — useful for scope visualization.
   */
  generateWithChannels(stereoOutput: Float32Array, channelsOutput: Float32Array): void {
    const numFrames = stereoOutput.length >>> 1;
    if (numFrames === 0) return;
    if (channelsOutput.length < numFrames * AY_VOICE_COUNT) {
      throw new Error(
        `cawtooth: channelsOutput must hold numFrames * ${AY_VOICE_COUNT} samples ` +
          `(got ${channelsOutput.length}, need ${numFrames * AY_VOICE_COUNT})`,
      );
    }

    this.growScratch(numFrames);
    this.exports.cawtooth_ay_generate_channels(
      this.handlePtr,
      this.scratchPtr,
      this.channelsScratchPtr,
      numFrames,
    );

    const mem = this.exports.memory.buffer;
    const stereoView = new Int16Array(mem, this.scratchPtr, numFrames * 2);
    for (let i = 0; i < numFrames * 2; i++) {
      stereoOutput[i] = stereoView[i] * INT16_TO_FLOAT;
    }

    const chView = new Int16Array(mem, this.channelsScratchPtr, numFrames * AY_VOICE_COUNT);
    for (let i = 0; i < chView.length; i++) {
      channelsOutput[i] = chView[i] * INT16_TO_FLOAT;
    }
  }

  /** Reset all 16 registers to 0. Silences the chip immediately. */
  reset(): void {
    this.exports.cawtooth_ay_reset(this.handlePtr);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exports.free(this.scratchPtr);
    this.exports.free(this.channelsScratchPtr);
    this.exports.cawtooth_ay_destroy(this.handlePtr);
  }

  private growScratch(numFrames: number): void {
    if (numFrames <= this.scratchFrames) return;
    this.exports.free(this.scratchPtr);
    this.exports.free(this.channelsScratchPtr);
    this.scratchFrames = numFrames;
    this.scratchPtr = this.exports.malloc(numFrames * 2 * 2);
    this.channelsScratchPtr = this.exports.malloc(numFrames * AY_VOICE_COUNT * 2);
    if (!this.scratchPtr || !this.channelsScratchPtr) {
      throw new Error('cawtooth: failed to grow AY sample scratch');
    }
  }
}
