/**
 * HERAD binary-format parser.
 *
 * Transforms the decompressed bytes of a HERAD song (pattern/track/instrument
 * structure from the Cryo HERAD engine) into a structured `HeradSong`. Does
 * not touch event semantics — that's Phase C. We deliberately keep the
 * instrument blocks as raw 40-byte arrays so the event-level code can decode
 * operator parameters at the moment it emits OPL register writes, preserving
 * fidelity for every mode (SDB1/SDB2/AGD).
 *
 * Accepts either compressed (HSQ) or already-decompressed bytes: if the input
 * passes `isHsq`, we decompress first. This lets callers hand the parser a
 * raw file from disk without thinking about compression.
 *
 * File layout (all little-endian):
 *
 * ```
 *  [0..2)     instOffset  — start-of-instrument-bank (also end-of-tracks)
 *  [2..0x2C)  track offsets, u16 each, 0-terminated, max HERAD_MAX_TRACKS.
 *             Stored in "offset + 2" form: add 2 to get the byte position.
 *             The first track's offset value is always 0x32 (OPL2 / AdLib)
 *             or 0x52 (AGD / AdLib Gold). The latter reserves 32 extra bytes
 *             for AGD-specific header data between the fixed header and the
 *             tracks.
 *  [0x2C]     wLoopStart (u16 LE)
 *  [0x2E]     wLoopEnd   (u16 LE)
 *  [0x30]     wLoopCount (u16 LE)
 *  [0x32]     wSpeed     (u16 LE) — must be non-zero
 *  [0x34..)   track data (for OPL2); for AGD, +0x20 of extra header first
 *  [instOffset..fileEnd)  instrument bank — (fileEnd - instOffset) / 40 entries
 * ```
 */

import { decompressHsq, isHsq } from './hsq.js';
import {
  HERAD_INST_SIZE,
  HERAD_INSTMODE,
  HERAD_MAX_TRACKS,
  HERAD_MIN_DECOMPRESSED_SIZE,
  type HeradInstrument,
  type HeradKeymap,
  type HeradPatch,
  type HeradSong,
  type ParseHeradOptions,
} from './types.js';

/**
 * Parse a HERAD file. Accepts either the original compressed bytes (HSQ) or
 * a decompressed payload.
 */
export function parseHerad(bytes: Uint8Array, options: ParseHeradOptions = {}): HeradSong {
  const payload = isHsq(bytes) ? decompressHsq(bytes) : bytes;
  return parseDecompressedHerad(payload, options);
}

/**
 * Parse a decompressed HERAD payload. Most callers want `parseHerad`, which
 * dispatches based on compression; this is exposed for cases where you've
 * already decompressed (or never compressed) the data.
 */
export function parseDecompressedHerad(
  bytes: Uint8Array,
  options: ParseHeradOptions = {},
): HeradSong {
  if (bytes.length < HERAD_MIN_DECOMPRESSED_SIZE) {
    throw new Error(
      `cawtooth/herad: file too small (${bytes.length} bytes; need at least ${HERAD_MIN_DECOMPRESSED_SIZE})`,
    );
  }

  const instOffset = u16(bytes, 0);
  if (instOffset === 0 || instOffset > bytes.length) {
    throw new Error(`cawtooth/herad: invalid instOffset 0x${instOffset.toString(16)}`);
  }

  // First track offset doubles as an AGD-vs-OPL2 discriminator.
  const firstTrackOffsetValue = u16(bytes, 2);
  if (firstTrackOffsetValue !== 0x32 && firstTrackOffsetValue !== 0x52) {
    throw new Error(
      `cawtooth/herad: first track offset 0x${firstTrackOffsetValue.toString(16)} is neither 0x32 (OPL2) nor 0x52 (AGD)`,
    );
  }
  const isAgd = firstTrackOffsetValue === 0x52;

  const loopStart = u16(bytes, 0x2c);
  const loopEnd = u16(bytes, 0x2e);
  const loopCount = u16(bytes, 0x30);
  const speed = u16(bytes, 0x32);
  if (speed === 0) {
    throw new Error('cawtooth/herad: wSpeed is 0 (file would not play)');
  }

  // Track offsets are a 0-terminated array at [2 .. 0x2C). Real files have
  // at most HERAD_MAX_TRACKS; iterate that many slots but stop at the first 0.
  const trackOffsets: number[] = [];
  for (let i = 0; i < HERAD_MAX_TRACKS; i++) {
    const raw = u16(bytes, 2 + i * 2);
    if (raw === 0) break;
    trackOffsets.push(raw + 2); // stored as "offset + 2", normalize to file offset
  }
  if (trackOffsets.length === 0) {
    throw new Error('cawtooth/herad: no tracks in file');
  }

  // Each track runs from its offset to the next track's offset, or to
  // instOffset for the last track.
  const tracks: Uint8Array[] = [];
  for (let i = 0; i < trackOffsets.length; i++) {
    const start = trackOffsets[i];
    const end = i + 1 < trackOffsets.length ? trackOffsets[i + 1] : instOffset;
    if (end < start || end > bytes.length) {
      throw new Error(
        `cawtooth/herad: track ${i} extent ${start}..${end} is out of range (file ${bytes.length})`,
      );
    }
    tracks.push(bytes.slice(start, end));
  }

  // Instrument bank: 40-byte blocks from instOffset to EOF.
  const bankSize = bytes.length - instOffset;
  if (bankSize <= 0 || bankSize % HERAD_INST_SIZE !== 0) {
    throw new Error(
      `cawtooth/herad: instrument bank size ${bankSize} is not a multiple of ${HERAD_INST_SIZE}`,
    );
  }
  const nInsts = bankSize / HERAD_INST_SIZE;
  const instruments: HeradInstrument[] = [];
  for (let i = 0; i < nInsts; i++) {
    instruments.push(decodeInstrument(bytes, instOffset + i * HERAD_INST_SIZE));
  }

  const variant = options.variant ?? detectVariant(instruments);

  return {
    variant,
    isAgd,
    speed,
    loopStart,
    loopEnd,
    loopCount,
    tracks,
    instruments,
  };
}

function decodeInstrument(bytes: Uint8Array, offset: number): HeradInstrument {
  const rawMode = bytes[offset];

  // mode is stored as int8; -1 (= 0xFF unsigned) means keymap.
  if (rawMode === HERAD_INSTMODE.KEYMAP) {
    const keymap: HeradKeymap = {
      kind: 'keymap',
      mode: HERAD_INSTMODE.KEYMAP,
      voice: bytes[offset + 1],
      noteOffset: bytes[offset + 2],
      // bytes[offset + 3] is an unknown/dummy byte.
      indices: bytes.slice(offset + 4, offset + HERAD_INST_SIZE),
    };
    return keymap;
  }

  if (
    rawMode !== HERAD_INSTMODE.SDB1 &&
    rawMode !== HERAD_INSTMODE.SDB2 &&
    rawMode !== HERAD_INSTMODE.AGD
  ) {
    throw new Error(
      `cawtooth/herad: unknown instrument mode 0x${rawMode.toString(16)} at offset 0x${offset.toString(16)}`,
    );
  }
  const patch: HeradPatch = {
    kind: 'patch',
    mode: rawMode,
    raw: bytes.slice(offset, offset + HERAD_INST_SIZE),
  };
  return patch;
}

/**
 * Auto-detect v1 vs v2. Any keymap instrument means v2 (keymaps are a v2-only
 * feature). Songs that use v2 event forms without keymaps (like ALARME)
 * auto-detect as v1 here; callers pass `{ variant: 'v2' }` for those. A full
 * detection requires event-level parsing, which we do in Phase C.
 */
function detectVariant(instruments: ReadonlyArray<HeradInstrument>): 'v1' | 'v2' {
  return instruments.some((inst) => inst.kind === 'keymap') ? 'v2' : 'v1';
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
