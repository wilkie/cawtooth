/**
 * Chip interfaces — shared across OPL and SID (and any future chip).
 *
 * The common shape is a pure state machine driven by register writes: the
 * consumer pokes bytes into registers, then pulls audio samples. Formats,
 * timing, and playback concerns live in higher layers.
 */

/**
 * Base interface any register-driven sound chip satisfies. Consumers that
 * don't need per-voice visualisation should type against this — it covers
 * OPL, SID, and any future chip with the same "write byte, pull samples"
 * shape.
 */
export interface Chip {
  /** Output sample rate in Hz — what `generate()` writes to the buffer. */
  readonly sampleRate: number;

  /**
   * Number of addressable voices the chip produces. Used by visualisations
   * and by encoders that care about voice mapping. OPL2/OPL3: 18 voices
   * (9 active in OPL2 mode). SID: 3.
   */
  readonly voiceCount: number;

  /** Write `value` (0–255) into register `reg`. */
  writeRegister(reg: number, value: number): void;

  /**
   * Fill the output buffer with stereo interleaved samples in [-1, 1].
   * Number of frames generated is `output.length / 2`.
   */
  generate(output: Float32Array): void;

  /** Return the chip to a clean power-on state. */
  reset(): void;

  /** Free backing resources (wasm memory, native handles, etc.). */
  dispose(): void;
}

/**
 * Chips that can produce per-voice pre-mix output alongside the stereo mix.
 * Used by the oscilloscope panel and any analysis that cares about
 * per-voice waveforms.
 */
export interface PerVoiceChip extends Chip {
  /**
   * Fill both a stereo output buffer AND a per-voice buffer in one pass.
   *
   * `channelsOutput` is frame-interleaved:
   * `[f0_v0, f0_v1, ..., f0_v(voiceCount-1), f1_v0, ...]`,
   * total length `numFrames * voiceCount`. Per-voice values bypass any
   * chip-level routing (e.g. OPL3 CHA/CHB masks) so visualisers see what
   * each voice is producing regardless of whether it's routed to output.
   */
  generateWithChannels(stereoOutput: Float32Array, channelsOutput: Float32Array): void;
}

/**
 * Narrow the capability of an arbitrary Chip to PerVoiceChip at runtime.
 * Useful for code that wants per-voice output when available but should
 * degrade gracefully when it isn't (SID in Phase 1, for instance).
 */
export function supportsPerVoiceOutput(chip: Chip): chip is PerVoiceChip {
  return (
    'generateWithChannels' in chip &&
    typeof (chip as PerVoiceChip).generateWithChannels === 'function'
  );
}

/**
 * OPL-family chip. Alias for PerVoiceChip — OPL chips always expose
 * per-voice output via the Nuked patch (see packages/core/native/wrapper.c
 * and tools/patches/nuked-opl3/0001-per-channel-output.patch). SID chips
 * type against Chip, not OplChip, because per-voice output requires
 * additional work in reSID we haven't done.
 */
export type OplChip = PerVoiceChip;

/**
 * Per-voice channel count for OPL3 specifically. Kept as a convenience
 * export for code that hardcodes OPL; most consumers should read
 * `chip.voiceCount` dynamically.
 */
export const OPL_CHANNEL_COUNT = 18;

export interface OplRegisterWrite {
  reg: number;
  value: number;
}
