import type { SidChipModel, SidSamplingMethod } from '../../chip/resid-sid.js';
import { SID_CLOCK_PAL, SID_CLOCK_NTSC } from '../../chip/resid-sid.js';
import { asSidplayExports, type SidplayExports } from './sidplay-loader.js';
import type { PsidSidModel, PsidSong } from './types.js';

const INT16_TO_FLOAT = 1 / 32768;
const INITIAL_SCRATCH_SAMPLES = 1024;

/**
 * Maximum PSID voice slots the channel buffer carries. Three voices ×
 * three SID chip slots per the v4 PSID spec. The wasm always fills
 * this full stride, zero-padding inactive SID slots.
 */
export const PSID_MAX_VOICE_COUNT = 9;

/** Nominal PAL C64 cycles-per-vblank (50.124 Hz). */
export const PAL_CYCLES_PER_FRAME = 19656;
/** Nominal NTSC C64 cycles-per-vblank (59.826 Hz). */
export const NTSC_CYCLES_PER_FRAME = 17095;

/** Defaults & coercions shared with SidChip, kept consistent on purpose. */
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
 * Pick a SID model for an extra chip. The PSID flag bits can be
 * 'unknown' or 'both' — neither tells us what to instantiate, so we
 * inherit the primary chip's model. When the flag does specify a
 * concrete revision, honour it (multi-SID tunes sometimes intentionally
 * mix a 6581 and an 8580).
 */
function pickExtraModel(flag: PsidSidModel, primary: SidChipModel): SidChipModel {
  if (flag === 'MOS6581' || flag === 'MOS8580') return flag;
  return primary;
}

export interface SidTuneOptions {
  /** Output sample rate in Hz. */
  sampleRate: number;
  /**
   * Host clock frequency. Leave undefined to auto-pick from the tune's
   * PSID flags (`clock: 'NTSC'` → NTSC, anything else → PAL).
   */
  clockFrequency?: number;
  /**
   * Chip revision. Leave undefined to auto-pick from the tune's PSID flags
   * (`sidModel: 'MOS8580'` → 8580, anything else → 6581).
   */
  model?: SidChipModel;
  /** reSID sampling method. Defaults to 'resample'. */
  samplingMethod?: SidSamplingMethod;
}

/**
 * Loaded, ready-to-play PSID tune backed by sidplay.wasm (fake6502 CPU +
 * reSID + 64 KB RAM in one module).
 *
 * Typical flow:
 *   const tune = new SidTune(instance, song, { sampleRate: 48000 });
 *   tune.initSong(song.startSong);  // 1-based; matches PSID convention
 *   tune.generate(stereoBuffer);    // pull audio
 */
export class SidTune {
  readonly sampleRate: number;
  readonly clockFrequency: number;
  readonly model: SidChipModel;
  readonly samplingMethod: SidSamplingMethod;
  readonly song: PsidSong;

  private readonly exports: SidplayExports;
  private scratchPtr: number;
  private channelsScratchPtr: number;
  private scratchSamples: number;
  private cyclesPerFrame: number;
  private disposed = false;

  constructor(instance: WebAssembly.Instance, song: PsidSong, options: SidTuneOptions) {
    this.exports = asSidplayExports(instance);
    this.song = song;
    this.sampleRate = options.sampleRate;
    this.model = options.model ?? (song.flags.sidModel === 'MOS8580' ? 'MOS8580' : 'MOS6581');
    const autoClock = song.flags.clock === 'NTSC' ? SID_CLOCK_NTSC : SID_CLOCK_PAL;
    this.clockFrequency = options.clockFrequency ?? autoClock;
    this.samplingMethod = options.samplingMethod ?? 'resample';
    this.cyclesPerFrame =
      this.clockFrequency === SID_CLOCK_NTSC ? NTSC_CYCLES_PER_FRAME : PAL_CYCLES_PER_FRAME;

    this.exports._initialize?.();

    const ok = this.exports.cawtooth_sidplay_create(
      this.clockFrequency,
      this.sampleRate,
      MODEL_CODE[this.model],
      SAMPLING_METHOD_CODE[this.samplingMethod],
    );
    if (!ok) {
      throw new Error('cawtooth: failed to create sidplay runtime');
    }

    // Configure extra SIDs for v3/v4 multi-SID PSIDs. Address encoding
    // from the HVSC spec: actualAddr = $D000 | (headerByte << 4). A
    // zero byte means that slot is unused. Model falls back to the
    // primary SID's model when the flags field gives no specific hint.
    if (song.secondSIDAddress !== 0) {
      const base2 = 0xd000 | (song.secondSIDAddress << 4);
      const model2 = pickExtraModel(song.flags.sidModel2, this.model);
      this.exports.cawtooth_sidplay_set_extra_sid(1, base2, MODEL_CODE[model2]);
    }
    if (song.thirdSIDAddress !== 0) {
      const base3 = 0xd000 | (song.thirdSIDAddress << 4);
      const model3 = pickExtraModel(song.flags.sidModel3, this.model);
      this.exports.cawtooth_sidplay_set_extra_sid(2, base3, MODEL_CODE[model3]);
    }

    // Copy the tune's binary into emulated C64 RAM.
    const dataPtr = this.exports.malloc(song.data.length);
    if (!dataPtr) {
      this.exports.cawtooth_sidplay_destroy();
      throw new Error('cawtooth: failed to allocate tune payload');
    }
    try {
      new Uint8Array(this.exports.memory.buffer, dataPtr, song.data.length).set(song.data);
      this.exports.cawtooth_sidplay_load(song.loadAddress, dataPtr, song.data.length);
    } finally {
      this.exports.free(dataPtr);
    }

    this.scratchSamples = INITIAL_SCRATCH_SAMPLES;
    this.scratchPtr = this.exports.malloc(this.scratchSamples * 2);
    this.channelsScratchPtr = this.exports.malloc(
      this.scratchSamples * PSID_MAX_VOICE_COUNT * 2,
    );
    if (!this.scratchPtr || !this.channelsScratchPtr) {
      this.exports.cawtooth_sidplay_destroy();
      throw new Error('cawtooth: failed to allocate sample scratch');
    }
  }

  /**
   * Run the tune's init routine for the given subsong. `subsong` is
   * 1-based per PSID convention (matching `song.startSong`).
   *
   * Returns the number of CPU cycles consumed by init, or -1 if the init
   * exceeded the wasm-level cycle cap (usually a sign of a malformed tune
   * or an IRQ-driven design we don't yet support).
   *
   * The PSID `speed` bitfield decides whether this subsong's play routine
   * runs on vblank or on CIA 1 Timer A. For CIA-driven subsongs, the init
   * routine writes the timer period to $DC04/$DC05; the wasm-level init
   * reads those back after init completes and uses the 16-bit value as
   * the per-frame cycle budget. Subsongs beyond 32 wrap their speed bit
   * (mod 32) per PSID convention.
   */
  initSong(subsong: number): number {
    if (subsong < 1 || subsong > this.song.songs) {
      throw new Error(
        `cawtooth: subsong ${subsong} out of range [1, ${this.song.songs}]`,
      );
    }
    const speedBitIndex = (subsong - 1) % 32;
    const useCiaTimer = ((this.song.speed >>> speedBitIndex) & 1) === 1;
    // RSID files always use CIA-timer playback driven by an IRQ handler
    // the tune installs. The wasm-level init honours this regardless of
    // the speed bit (which the RSID spec pins at 0 anyway).
    const isRsid = this.song.magic === 'RSID';
    return this.exports.cawtooth_sidplay_init(
      this.song.initAddress,
      subsong - 1,
      this.song.playAddress,
      this.cyclesPerFrame,
      useCiaTimer ? 1 : 0,
      isRsid ? 1 : 0,
    );
  }

  /**
   * Resolved per-frame CPU cycle budget for the currently-initialized
   * subsong. Either the PAL/NTSC vblank period (for speed-bit=0 subsongs)
   * or the CIA Timer A value that the init routine programmed (for
   * speed-bit=1 subsongs). Surface for inspection/UI.
   */
  get effectivePlayInterval(): number {
    return this.exports.cawtooth_sidplay_get_play_interval();
  }

  /**
   * Fill `output` with stereo-interleaved Float32 samples in [-1, 1].
   *
   * PSID tunes are mono; the same value is written to both L/R. Consumers
   * that want mono can read every other element, or use `generateMono`.
   */
  generate(output: Float32Array): void {
    const numFrames = output.length >>> 1;
    if (numFrames === 0) return;

    this.growScratch(numFrames);
    this.exports.cawtooth_sidplay_generate(this.scratchPtr, numFrames);

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
   * `channelsOutput` length must be `numFrames * PSID_MAX_VOICE_COUNT`
   * (9 voices: 3 per SID slot × 3 slots). Layout is frame-interleaved:
   * `[f0_sid1_v1, f0_sid1_v2, f0_sid1_v3, f0_sid2_v1, ..., f0_sid3_v3,
   *   f1_sid1_v1, ...]`. For single- and dual-SID tunes the unused SID
   * slots are zero-filled, so the caller can read a stable stride of 9
   * without having to check active-chip state per frame.
   *
   * Values are scaled Float32 in roughly [-1, 1]; see the resid-wrapper
   * comment for the 20-bit voice output → int16 scaling rationale.
   */
  generateWithChannels(stereoOutput: Float32Array, channelsOutput: Float32Array): void {
    const numFrames = stereoOutput.length >>> 1;
    if (numFrames === 0) return;
    const required = numFrames * PSID_MAX_VOICE_COUNT;
    if (channelsOutput.length < required) {
      throw new Error(
        `cawtooth: channelsOutput must hold numFrames * ${PSID_MAX_VOICE_COUNT} samples ` +
          `(got ${channelsOutput.length}, need ${required})`,
      );
    }

    this.growScratch(numFrames);
    this.exports.cawtooth_sidplay_generate_channels(
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

    const chView = new Int16Array(mem, this.channelsScratchPtr, required);
    for (let i = 0; i < required; i++) {
      channelsOutput[i] = chView[i] * INT16_TO_FLOAT;
    }
  }

  /** Generate mono samples directly — avoids the L/R duplication. */
  generateMono(output: Float32Array): void {
    const numSamples = output.length;
    if (numSamples === 0) return;

    this.growScratch(numSamples);
    this.exports.cawtooth_sidplay_generate(this.scratchPtr, numSamples);

    const view = new Int16Array(this.exports.memory.buffer, this.scratchPtr, numSamples);
    for (let i = 0; i < numSamples; i++) {
      output[i] = view[i] * INT16_TO_FLOAT;
    }
  }

  /** Reset just the SID chip; doesn't re-run the tune's init routine. */
  resetSid(): void {
    this.exports.cawtooth_sidplay_reset_sid();
  }

  /** Peek a byte from emulated C64 RAM. Intended for tests. */
  peek(address: number): number {
    return this.exports.cawtooth_sidplay_peek(address & 0xffff);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exports.free(this.scratchPtr);
    this.exports.free(this.channelsScratchPtr);
    this.exports.cawtooth_sidplay_destroy();
  }

  private growScratch(numSamples: number): void {
    if (numSamples <= this.scratchSamples) return;
    this.exports.free(this.scratchPtr);
    this.exports.free(this.channelsScratchPtr);
    this.scratchSamples = numSamples;
    this.scratchPtr = this.exports.malloc(numSamples * 2);
    this.channelsScratchPtr = this.exports.malloc(
      numSamples * PSID_MAX_VOICE_COUNT * 2,
    );
    if (!this.scratchPtr || !this.channelsScratchPtr) {
      throw new Error('cawtooth: failed to grow sample scratch');
    }
  }
}
