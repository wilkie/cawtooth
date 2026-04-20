/**
 * HERAD format types.
 *
 * A HERAD song is a pattern-based, instrument-driven AdLib song format. The
 * on-disk file (decompressed if it was HSQ/SQX) looks like:
 *
 *   [header — 52 bytes fixed layout]
 *   [track data — concatenated event byte streams, one per track]
 *   [instrument bank — 40-byte blocks, variable count]
 *
 * Tracks hold raw event bytes; actually *playing* them (note-on/off events,
 * pitch bends, tempo, etc.) requires the HERAD event engine, which is Phase
 * C of this library. Phase B — what this file covers — stops at the
 * structural decoding.
 */

/** Bytes per on-disk instrument block. */
export const HERAD_INST_SIZE = 40;

/** Maximum number of tracks. Matches the header's track-offset table capacity. */
export const HERAD_MAX_TRACKS = 21;

/** Minimum valid decompressed file size (header + at least one instrument). */
export const HERAD_MIN_DECOMPRESSED_SIZE = 52 + HERAD_INST_SIZE;

/** HERAD instrument mode codes as stored in the first byte of each 40-byte block. */
export const HERAD_INSTMODE = {
  /** v1 SDB instrument (AdLib / OPL2). */
  SDB1: 0,
  /** v2 SDB instrument. Slightly different operator layout. */
  SDB2: 1,
  /** AdLib Gold / OPL3 instrument. */
  AGD: 4,
  /** v2 keymap — indirects through other instruments by note. */
  KEYMAP: 0xff, // stored as signed -1, read as unsigned 0xFF
} as const;

export type HeradVariant = 'v1' | 'v2';

export interface HeradSong {
  /** File-layout hint. v1 is the classic HERAD; v2 has keymaps and truncated events. */
  readonly variant: HeradVariant;
  /** True when track 0's offset field == 0x52, signalling an AdLib Gold capture. */
  readonly isAgd: boolean;
  /** Raw wSpeed header field (fixed-point tempo). Phase C converts to real time. */
  readonly speed: number;
  /** Loop-start measure (1-based), or 0 if the song does not loop. */
  readonly loopStart: number;
  /** Loop-end measure (1-based), or 0 if the song does not loop. */
  readonly loopEnd: number;
  /** Loop iteration count. 0 = infinite, >0 = play N times total. */
  readonly loopCount: number;
  /** Event byte-streams, one per voice/track. Decoded by Phase C. */
  readonly tracks: ReadonlyArray<Uint8Array>;
  /** Instrument bank. Patch or keymap depending on `mode`. */
  readonly instruments: ReadonlyArray<HeradInstrument>;
}

export type HeradInstrument = HeradPatch | HeradKeymap;

export interface HeradPatch {
  readonly kind: 'patch';
  /** SDB1 | SDB2 | AGD. */
  readonly mode: 0 | 1 | 4;
  /**
   * The full 40-byte block. Phase C decodes operator params (KSL/MUL/AR/DR/SR/RR/
   * waveform/etc.) from this; exposing it raw keeps Phase B format-faithful and
   * defers semantic interpretation to when we actually emit register writes.
   */
  readonly raw: Uint8Array;
}

export interface HeradKeymap {
  readonly kind: 'keymap';
  /** Always 0xFF (as unsigned). */
  readonly mode: 0xff;
  /** Voice number from byte 1 (unused per the AdPlug source, but preserved). */
  readonly voice: number;
  /** Root-note offset. 0 → C2 (MIDI 24), 24 → C4 (MIDI 48). */
  readonly noteOffset: number;
  /** 36 indices into the instrument bank, one per note relative to noteOffset. */
  readonly indices: Uint8Array;
}

export interface ParseHeradOptions {
  /**
   * Force a specific variant. When omitted we auto-detect v2 by looking for a
   * keymap instrument; songs that use v2-only event forms without keymaps
   * (e.g. ALARME) auto-detect as v1 — pass `'v2'` explicitly for those.
   */
  variant?: HeradVariant;
}
