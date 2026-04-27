/**
 * .VTX (Vortex Tracker / AY Emul) parser.
 *
 * VTX wraps a column-major register dump in a small text-only header and
 * compresses the dump with LH5. The format is the de-facto standard for
 * ZX Spectrum AY tracks and the one most modern AY trackers (Vortex
 * Tracker II, ASC Sound Master) export to. Two chip variants are
 * distinguished by magic: `"ay"` (AY-3-8910) and `"ym"` (YM2149).
 *
 * Header layout (binary, little-endian):
 *   bytes 0–1   : magic: "ay" or "ym" (lowercase ASCII)
 *   byte  2     : channel layout (0=mono, 1=ABC, 2=ACB, 3=BAC, 4=BCA,
 *                  5=CAB, 6=CBA) — informational only, the AY player
 *                  applies its own pan defaults
 *   bytes 3–4   : loop frame index (LE u16)
 *   bytes 5–8   : chip clock in Hz (LE u32)
 *   byte  9     : interrupt frequency in Hz (50 PAL / 60 NTSC)
 *   bytes 10–11 : year (LE u16) — informational
 *   bytes 12–15 : decompressed payload size in bytes (LE u32)
 *   bytes 16+   : five null-terminated CP1251 strings: title, author,
 *                  program, tracker, comment
 *   ...         : LH5-compressed payload — a column-major register table
 *                  of 14 columns (R0..R13) × N rows (frames)
 *
 * Decompressed payload semantics: byte at column k, row i is the value
 * the original program wrote to register k at frame i. We de-interleave
 * to a row-major event stream, emitting one register-write event per
 * frame per register whose value differs from the previous frame
 * (skipping repeats produces a much smaller stream and matches what
 * actual tracker drivers do).
 */

import type { AyChipModel } from '../../chip/ayumi-chip.js';
import { decompressLh5 } from './lh5.js';
import type { AySong } from './types.js';

const VTX_MIN_HEADER = 16;
const VTX_REGISTER_COUNT = 14;

export function parseVtx(bytes: Uint8Array): AySong {
  if (bytes.length < VTX_MIN_HEADER) {
    throw new Error('cawtooth/vtx: file too short to contain a VTX header');
  }

  const magic = String.fromCharCode(bytes[0], bytes[1]);
  let model: AyChipModel;
  if (magic === 'ay') {
    model = 'AY-3-8910';
  } else if (magic === 'ym') {
    model = 'YM2149';
  } else {
    throw new Error(
      `cawtooth/vtx: not a VTX file (magic ${JSON.stringify(magic)} is not "ay" or "ym")`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const layout = bytes[2];
  const loopFrame = view.getUint16(3, true);
  const clockFrequency = view.getUint32(5, true);
  const intFreq = bytes[9];
  // bytes 10–11: year — informational only, we don't surface it.
  const unpackedSize = view.getUint32(12, true);

  if (intFreq === 0) {
    throw new Error('cawtooth/vtx: invalid interrupt frequency 0');
  }
  if (clockFrequency === 0) {
    throw new Error('cawtooth/vtx: invalid chip clock 0');
  }
  if (unpackedSize === 0) {
    throw new Error('cawtooth/vtx: header declares 0-byte payload');
  }

  // Five null-terminated strings. CP1251 (Windows Cyrillic) is the
  // historical encoding — most VTX files originated in the Russian
  // demoscene. ASCII-only metadata round-trips fine through CP1251 too,
  // so this is the safe default.
  const decoder = new TextDecoder('windows-1251');
  let pos = VTX_MIN_HEADER;
  const strings: string[] = [];
  for (let s = 0; s < 5; s++) {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    if (pos >= bytes.length) {
      throw new Error(`cawtooth/vtx: unterminated metadata string #${s}`);
    }
    strings.push(decoder.decode(bytes.subarray(start, pos)));
    pos++; // consume null terminator
  }
  const [title, author, program, tracker, comment] = strings;
  void layout;
  void program;
  void tracker;

  if (pos >= bytes.length) {
    throw new Error('cawtooth/vtx: no compressed payload after metadata');
  }

  const compressed = bytes.subarray(pos);
  const decompressed = decompressLh5(compressed, unpackedSize);

  if (decompressed.length % VTX_REGISTER_COUNT !== 0) {
    throw new Error(
      `cawtooth/vtx: decompressed payload size ${decompressed.length} is not a ` +
        `multiple of ${VTX_REGISTER_COUNT} (14 registers per frame)`,
    );
  }
  const numFrames = decompressed.length / VTX_REGISTER_COUNT;

  // De-interleave column-major dump into a register-write event stream.
  // We only emit when a register's value differs from the previous frame
  // — both for stream-size reasons and because that's the actual write
  // semantic of every AY tracker driver.
  const regs: number[] = [];
  const values: number[] = [];
  const delays: number[] = [];

  // Baseline: chip is reset to all zeros before playback, so any frame-0
  // register that's already 0 is implicitly correct and need not be
  // emitted.
  const lastValue = new Int16Array(VTX_REGISTER_COUNT);

  // Pending tick delay accumulated since the last emitted event. Applied
  // to the previous event's `delayTicks` slot when a new event is about
  // to be emitted.
  let pendingDelay = 0;

  for (let frame = 0; frame < numFrames; frame++) {
    let frameHadWrite = false;
    for (let k = 0; k < VTX_REGISTER_COUNT; k++) {
      const value = decompressed[k * numFrames + frame];
      if (value === lastValue[k]) continue;

      if (regs.length > 0 && !frameHadWrite) {
        delays[delays.length - 1] += pendingDelay;
        pendingDelay = 0;
      }
      regs.push(k);
      values.push(value);
      delays.push(0);
      lastValue[k] = value;
      frameHadWrite = true;
    }
    pendingDelay += 1;
  }

  if (regs.length === 0) {
    throw new Error('cawtooth/vtx: file contained no register changes');
  }

  // Trailing pendingDelay (frames after the last register change) becomes
  // the final event's tail so duration accounts for the song's full
  // length.
  delays[delays.length - 1] += pendingDelay;

  const stream = {
    regs: Uint16Array.from(regs),
    values: Uint8Array.from(values),
    delayTicks: Uint32Array.from(delays),
  };

  void loopFrame;

  return {
    stream,
    tickRate: intFreq,
    container: 'vtx',
    variant: magic,
    model,
    clockFrequency,
    title,
    author,
    comment,
    // VTX always has a loop point — even if loopFrame === 0 it means
    // "loop from the start". Surface this so the player can choose to
    // loop; we don't hard-set timing.loop because individual users may
    // prefer one-shot playback.
    loop: true,
  };
}
