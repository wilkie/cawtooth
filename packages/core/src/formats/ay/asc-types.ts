/**
 * Internal types for the ASC Sound Master parser + replayer.
 *
 * Mirrored after the ZXTune `Module::ASCSoundMaster` data shapes but
 * cleaned up for TypeScript: we drop the bitfield struct layouts and
 * keep only the post-decode shapes the replayer reads. The names line
 * up with ZXTune so anyone cross-referencing the C++ has an easy time.
 */

export const ASC_MAX_PATTERNS = 32;
export const ASC_MAX_SAMPLES = 32;
export const ASC_MAX_ORNAMENTS = 32;
export const ASC_MAX_PATTERN_LINES = 64;
export const ASC_MIN_PATTERN_LINES = 1;
export const ASC_MAX_SAMPLE_LINES = 150;
export const ASC_MAX_ORNAMENT_LINES = 30;

export interface AscSampleLine {
  /** Volume level 0–15. */
  readonly level: number;
  /** Signed tone-period delta, accumulated each tick this line is active. */
  readonly toneDeviation: number;
  /** True → channel's tone disabled (R7 bit set). */
  readonly toneMask: boolean;
  /** True → channel's noise disabled. Also routes the `adding` field to envelope tone. */
  readonly noiseMask: boolean;
  /** Signed 5-bit amount added to noise period (or envelope tone when noiseMask). */
  readonly adding: number;
  /** True → envelope is enabled while this sample line is active. */
  readonly enableEnvelope: boolean;
  /** -1, 0, or +1 — volume addon delta per tick from the EMPTY/ENVELOPE/DECVOLADD/INCVOLADD command bits. */
  readonly volSlide: number;
}

export interface AscSample {
  readonly lines: readonly AscSampleLine[];
  /** Loop start index (inclusive). When the cursor reaches loopLimit+1 we jump back here. */
  readonly loop: number;
  /** Loop end index (inclusive). */
  readonly loopLimit: number;
}

export interface AscOrnamentLine {
  /** Signed semitone offset from the channel's base note. */
  readonly noteAddon: number;
  /** Signed 5-bit noise period offset added to the channel's base noise. */
  readonly noiseAddon: number;
}

export interface AscOrnament {
  readonly lines: readonly AscOrnamentLine[];
  readonly loop: number;
  readonly loopLimit: number;
}

/**
 * One row × one channel of pattern data, fully parsed from the bytecode
 * stream. Fields are optional because most rows leave most things alone;
 * the replayer only updates state on the fields that are present.
 */
export interface AscCell {
  /** Channel "skip" period in lines, set by the 0x60..0x9F group. */
  period?: number;
  /** Note number 0..0x55 (semitones from low C). */
  note?: number;
  /** Selected sample index 0..31. */
  sample?: number;
  /** Selected ornament index 0..31. */
  ornament?: number;
  /** Channel volume 1..15 (or 15 + envelope-on for the 0xE0 command). */
  volume?: number;
  /** false → rest (gates the channel off). */
  enabled?: boolean;
  /** Stop the running sample and silence the channel without losing the sample slot. */
  breakSample?: boolean;
  /** Envelope shape (R13 low nibble). */
  envelopeType?: number;
  /** 8-bit envelope tone period (R11 low byte; R12 stays 0 in ASC). */
  envelopeTone?: number;
  /** Turn this channel's envelope on (volume bit 4). */
  envelopeOn?: boolean;
  /** Turn this channel's envelope off. */
  envelopeOff?: boolean;
  /** Set noise period (R6). */
  noise?: number;
  /** Continue sample without resetting cursor (used with stepped slides). */
  contSample?: boolean;
  /** Continue ornament without resetting cursor. */
  contOrnament?: boolean;
  /** Continuous tone slide ("portamento"); positive or negative integer. */
  glissade?: number;
  /** Stepped slide N steps; negative = down, positive = up. Param2 sliding-on flag. */
  slideSteps?: number;
  slideToneSliding?: boolean;
  /** Volume-slide period (ticks per step). */
  volSlideDelay?: number;
  /** Volume-slide step direction (+1 / -1). */
  volSlideAddon?: number;
}

/** A full pattern: one row per "line", each row = 3 channel cells + optional row-level tempo override. */
export interface AscRow {
  readonly cells: readonly [AscCell, AscCell, AscCell];
  /** Tempo (ticks/line) override set by a 0xF4 command in any channel. */
  readonly tempo?: number;
}

export interface AscPattern {
  readonly rows: readonly AscRow[];
}

export interface AscModule {
  /** Default tempo (ticks per pattern row). 0xF4 commands override per-row. */
  readonly tempo: number;
  /** Position-list loop point. Ver0 files have no explicit loop; we surface 0 there. */
  readonly loop: number;
  /** Order list — pattern indices to play in sequence. */
  readonly positions: readonly number[];
  /** Title from the optional ID block. Empty when not present. */
  readonly title: string;
  /** Author from the optional ID block. Empty when not present. */
  readonly author: string;
  readonly samples: readonly AscSample[];
  readonly ornaments: readonly AscOrnament[];
  readonly patterns: readonly AscPattern[];
}
