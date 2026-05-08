import { asSndhExports, type SndhExports } from './sndh-loader.js';
import type { SndhSong } from './types.js';

const INT16_TO_FLOAT = 1 / 32768;
const INITIAL_SCRATCH_FRAMES = 1024;

/** Number of YM voices the channel buffer carries (3 tone channels). */
export const SNDH_VOICE_COUNT = 3;

/** Atari ST 68000 clock, PAL machines (8.0106 MHz). */
export const ATARI_ST_PAL_CLOCK = 8010613;
/** Atari ST 68000 clock, NTSC machines (8.054 MHz). */
export const ATARI_ST_NTSC_CLOCK = 8053977;
/** YM2149 chip clock — 1/4 of the 68000 clock on every Atari ST. */
export const ATARI_ST_YM2149_CLOCK = 2000000;

/** Fallback play frequency when the SNDH header has no timer tag. */
const DEFAULT_TIMER_HZ = 50;

export interface SndhTuneOptions {
  /** Output sample rate in Hz. */
  sampleRate: number;
  /** 68000 clock in Hz. Defaults to PAL ({@link ATARI_ST_PAL_CLOCK}). */
  clockFrequency?: number;
  /** YM2149 chip clock in Hz. Defaults to {@link ATARI_ST_YM2149_CLOCK}. */
  ymClockFrequency?: number;
  /** True for YM2149 (Atari ST), false for AY-3-8910. Defaults to true. */
  isYm?: boolean;
}

/**
 * Loaded, ready-to-play SNDH tune backed by sndh.wasm (Musashi 68000 +
 * Ayumi YM2149 + 4 MB Atari ST RAM in one module).
 *
 * Typical flow:
 *   const tune = new SndhTune(instance, song, { sampleRate: 48000 });
 *   tune.initSong(1);             // 1-based; matches SNDH convention
 *   tune.generate(stereoBuffer);  // pull audio
 */
export class SndhTune {
  readonly sampleRate: number;
  readonly clockFrequency: number;
  readonly ymClockFrequency: number;
  readonly isYm: boolean;
  readonly song: SndhSong;

  private readonly exports: SndhExports;
  private scratchPtr: number;
  private channelsScratchPtr: number;
  private scratchFrames: number;
  private cyclesPerPlay: number;
  private disposed = false;

  constructor(instance: WebAssembly.Instance, song: SndhSong, options: SndhTuneOptions) {
    this.exports = asSndhExports(instance);
    this.song = song;
    this.sampleRate = options.sampleRate;
    this.clockFrequency = options.clockFrequency ?? ATARI_ST_PAL_CLOCK;
    this.ymClockFrequency = options.ymClockFrequency ?? ATARI_ST_YM2149_CLOCK;
    this.isYm = options.isYm ?? true;

    const timerHz = song.timer?.frequencyHz ?? DEFAULT_TIMER_HZ;
    this.cyclesPerPlay = Math.max(1, Math.floor(this.clockFrequency / timerHz));

    this.exports._initialize?.();

    const ok = this.exports.cawtooth_sndh_create(
      this.clockFrequency,
      this.ymClockFrequency,
      this.sampleRate,
      this.isYm ? 1 : 0,
    );
    if (!ok) {
      throw new Error('cawtooth: failed to create sndh runtime');
    }

    // Copy the SNDH binary verbatim into simulated Atari ST RAM at $0.
    const dataPtr = this.exports.malloc(song.binary.length);
    if (!dataPtr) {
      this.exports.cawtooth_sndh_destroy();
      throw new Error('cawtooth: failed to allocate tune payload');
    }
    try {
      new Uint8Array(this.exports.memory.buffer, dataPtr, song.binary.length).set(song.binary);
      this.exports.cawtooth_sndh_load(dataPtr, song.binary.length);
    } finally {
      this.exports.free(dataPtr);
    }

    this.scratchFrames = INITIAL_SCRATCH_FRAMES;
    this.scratchPtr = this.exports.malloc(this.scratchFrames * 2 * 2); // stereo int16
    this.channelsScratchPtr = this.exports.malloc(
      this.scratchFrames * SNDH_VOICE_COUNT * 2,
    );
    if (!this.scratchPtr || !this.channelsScratchPtr) {
      this.exports.cawtooth_sndh_destroy();
      throw new Error('cawtooth: failed to allocate sample scratch');
    }
  }

  /**
   * Run the SNDH `init` routine for the given subsong. `subsong` is
   * 1-based per the SNDH spec — pass {@link SndhSong.defaultSubsong}
   * unless the caller is explicitly switching tracks.
   *
   * Returns the number of m68k cycles consumed by init, or -1 if init
   * exceeded the wasm-level cycle cap (usually a malformed binary or a
   * memory-mapped hardware feature we don't model).
   */
  initSong(subsong: number): number {
    if (subsong < 1 || subsong > Math.max(1, this.song.subsongCount)) {
      throw new Error(
        `cawtooth: subsong ${subsong} out of range [1, ${this.song.subsongCount}]`,
      );
    }
    return this.exports.cawtooth_sndh_init(
      this.song.initAddress,
      this.song.exitAddress,
      this.song.playAddress,
      subsong,
      this.cyclesPerPlay,
    );
  }

  /**
   * m68k cycles between consecutive `play` invocations for the active
   * subsong, derived from the SNDH timer tag at construction time. Stable
   * across `initSong()` calls — SNDH doesn't have PSID's CIA-vs-vblank
   * dichotomy.
   */
  get effectivePlayInterval(): number {
    return this.exports.cawtooth_sndh_get_play_interval();
  }

  /**
   * Fill `output` with stereo-interleaved Float32 samples in [-1, 1].
   * `output.length` must be even (frame-aligned).
   */
  generate(output: Float32Array): void {
    const numFrames = output.length >>> 1;
    if (numFrames === 0) return;

    this.growScratch(numFrames);
    this.exports.cawtooth_sndh_generate(this.scratchPtr, numFrames);

    const view = new Int16Array(this.exports.memory.buffer, this.scratchPtr, numFrames * 2);
    for (let i = 0; i < numFrames * 2; i++) {
      output[i] = view[i] * INT16_TO_FLOAT;
    }
  }

  /**
   * Fill both a stereo output buffer AND a per-voice buffer in one pass.
   *
   * `channelsOutput.length` must be `numFrames * SNDH_VOICE_COUNT` (3
   * tone channels). Layout is frame-interleaved:
   * `[f0_v0, f0_v1, f0_v2, f1_v0, ...]`. Values are pre-pan DAC samples
   * scaled to Float32 in roughly [-1, 1].
   */
  generateWithChannels(stereoOutput: Float32Array, channelsOutput: Float32Array): void {
    const numFrames = stereoOutput.length >>> 1;
    if (numFrames === 0) return;
    const required = numFrames * SNDH_VOICE_COUNT;
    if (channelsOutput.length < required) {
      throw new Error(
        `cawtooth: channelsOutput must hold numFrames * ${SNDH_VOICE_COUNT} samples ` +
          `(got ${channelsOutput.length}, need ${required})`,
      );
    }

    this.growScratch(numFrames);
    this.exports.cawtooth_sndh_generate_channels(
      this.scratchPtr,
      this.channelsScratchPtr,
      numFrames,
    );

    const mem = this.exports.memory.buffer;
    const stereoView = new Int16Array(mem, this.scratchPtr, numFrames * 2);
    for (let i = 0; i < numFrames * 2; i++) {
      stereoOutput[i] = stereoView[i] * INT16_TO_FLOAT;
    }
    const chView = new Int16Array(mem, this.channelsScratchPtr, required);
    for (let i = 0; i < required; i++) {
      channelsOutput[i] = chView[i] * INT16_TO_FLOAT;
    }
  }

  /** Set per-voice stereo pan. `pan` ∈ [0, 1]: 0 = full left, 1 = full right. */
  setPan(channel: number, pan: number, isEqualPower = true): void {
    this.exports.cawtooth_sndh_set_pan(channel, pan, isEqualPower ? 1 : 0);
  }

  /** Reset just the YM2149; doesn't re-run the tune's init routine. */
  resetChip(): void {
    this.exports.cawtooth_sndh_reset_chip();
  }

  /** Peek a byte from emulated Atari ST RAM. Intended for tests. */
  peek(address: number): number {
    return this.exports.cawtooth_sndh_peek(address >>> 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exports.free(this.scratchPtr);
    this.exports.free(this.channelsScratchPtr);
    this.exports.cawtooth_sndh_destroy();
  }

  private growScratch(numFrames: number): void {
    if (numFrames <= this.scratchFrames) return;
    this.exports.free(this.scratchPtr);
    this.exports.free(this.channelsScratchPtr);
    this.scratchFrames = numFrames;
    this.scratchPtr = this.exports.malloc(numFrames * 2 * 2);
    this.channelsScratchPtr = this.exports.malloc(numFrames * SNDH_VOICE_COUNT * 2);
    if (!this.scratchPtr || !this.channelsScratchPtr) {
      throw new Error('cawtooth: failed to grow sample scratch');
    }
  }
}
