/**
 * .YM (Atari ST register-dump) parser.
 *
 * The vast majority of YM files in the wild are YM5 or YM6 packets
 * wrapped in an LHA archive whose single member is the raw register
 * dump compressed with LH5. We unwrap the archive, decompress the
 * payload, then walk the YM5/YM6 inner header before de-interleaving
 * the per-register columns into a normal `RegisterEventStream`.
 *
 * What we support today:
 *   - LHA level-0 / level-1 wrappers around a single "-lh5-" member.
 *   - YM5! and YM6! inner headers with interleaved register storage
 *     and zero digidrum samples (the standard tracker output).
 *
 * What we don't model yet (the file parses, but the corresponding
 * effects don't make it through to playback):
 *   - Digidrum samples — we skip past their data and ignore the
 *     reg-13 patches that select them. Tunes that use sampled drums
 *     will be missing the drum hits.
 *   - YM3 / YM3b raw (uncompressed) variants — uncommon; those are
 *     fixed 50 Hz, 14-byte frames with no header.
 *   - The "Sinchro Bus" / extra-info flags that signal extended sync
 *     events to the original Atari driver.
 *
 * Header layout (all integers big-endian — note YM uses BE while VTX
 * uses LE):
 *
 *   bytes 0–3   : "YM5!" or "YM6!"
 *   bytes 4–11  : "LeOnArD!" check string (always literal)
 *   bytes 12–15 : number of frames (BE u32)
 *   bytes 16–19 : attribute flags (BE u32) — bit 0: interleaved storage
 *   bytes 20–21 : digidrum sample count (BE u16)
 *   bytes 22–25 : chip clock in Hz (BE u32)
 *   bytes 26–27 : tick rate in Hz (BE u16) — typically 50, sometimes 60
 *   bytes 28–31 : loop frame index (BE u32)
 *   bytes 32–33 : extra-info size (BE u16; we skip these bytes)
 *
 *   then, if digidrum count > 0:
 *     - one BE u32 sample-size per digidrum
 *     - then the concatenated PCM data
 *
 *   then three null-terminated strings: song name, author, comment
 *   then `numFrames * 16` bytes of register data (interleaved or not)
 *   then trailing 4 bytes "End!"
 */

import { decompressLh5 } from './lh5.js';
import type { AySong } from './types.js';

const YM_REGISTER_COUNT = 16;

/** Minimum bytes needed to safely peek the inner YM header. */
const YM_INNER_MIN_HEADER = 34;

/** Magic that identifies an LHA "-lh5-" packed member at header offset 2. */
const LH5_METHOD = '-lh5-';

export function parseYm(bytes: Uint8Array): AySong {
  if (bytes.length < 4) {
    throw new Error('cawtooth/ym: file too short to identify variant');
  }

  // Detect LHA wrapper. Level-0 / level-1 headers carry the method
  // string at offset 2; level-2 carries it at offset 4 and the format
  // is rarer for YM files (we don't support it yet).
  const method = bytes.length >= 7 ? String.fromCharCode(...bytes.subarray(2, 7)) : '';

  let inner: Uint8Array;
  if (method === LH5_METHOD) {
    inner = decompressLhaMember(bytes);
  } else {
    inner = bytes;
  }

  return parseYmInner(inner);
}

/**
 * Parse a level-0 / level-1 LHA header and decompress its single member.
 *
 * We reject multi-member archives — every YM-in-LHA file we've seen
 * holds exactly one "-lh5-" member, and chasing the next-member chain
 * here would only obscure errors when a malformed archive is passed in.
 */
function decompressLhaMember(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 24) {
    throw new Error('cawtooth/ym: LHA file too short for a level-0 header');
  }
  const headerSize = bytes[0];
  // bytes[1] is the header checksum. We don't validate it; corrupt
  // data trips the LH5 decoder downstream which gives clearer errors.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressedSize = view.getUint32(7, true);
  const uncompressedSize = view.getUint32(11, true);
  const level = bytes[20];
  const filenameLen = bytes[21];

  // Level 0: payload starts at (2 + headerSize); the headerSize byte
  // describes the number of bytes between byte 2 and the payload.
  // Level 1: payload starts after the header AND any extended header
  // chain. Each ext header begins with a u16 LE next-header-size; a
  // size of 0 marks the end. We still need to walk past them.
  let payloadStart: number;
  if (level === 0) {
    payloadStart = 2 + headerSize;
  } else if (level === 1) {
    // Base header through the file CRC, then OS byte, then ext chain.
    let p = 2 + headerSize; // points at OS byte's position from spec
    // Level 1 actually places the next-header-size u16 at the position
    // immediately after the base header per the LHA spec; walk until
    // we hit a size-0 marker.
    for (;;) {
      if (p + 2 > bytes.length) {
        throw new Error('cawtooth/ym: truncated LHA level-1 extended header');
      }
      const nextSize = view.getUint16(p, true);
      if (nextSize === 0) {
        p += 2;
        break;
      }
      p += nextSize;
    }
    payloadStart = p;
  } else {
    throw new Error(`cawtooth/ym: unsupported LHA header level ${level}`);
  }

  if (payloadStart + compressedSize > bytes.length) {
    throw new Error(
      `cawtooth/ym: LHA payload extends past end of file ` +
        `(start=${payloadStart}, size=${compressedSize}, file=${bytes.length})`,
    );
  }

  void filenameLen;

  const compressed = bytes.subarray(payloadStart, payloadStart + compressedSize);
  return decompressLh5(compressed, uncompressedSize);
}

function parseYmInner(bytes: Uint8Array): AySong {
  if (bytes.length < YM_INNER_MIN_HEADER) {
    throw new Error('cawtooth/ym: inner payload too short for a YM5/YM6 header');
  }

  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'YM5!' && magic !== 'YM6!') {
    throw new Error(
      `cawtooth/ym: unsupported variant ${JSON.stringify(magic)} (need YM5! or YM6!)`,
    );
  }
  const variant = magic.slice(0, 3); // "YM5" / "YM6" — drop the '!'

  const check = String.fromCharCode(...bytes.subarray(4, 12));
  if (check !== 'LeOnArD!') {
    throw new Error('cawtooth/ym: missing "LeOnArD!" check string after magic');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numFrames = view.getUint32(12, false);
  const attributes = view.getUint32(16, false);
  const digidrumCount = view.getUint16(20, false);
  const clockFrequency = view.getUint32(22, false);
  const tickRate = view.getUint16(26, false);
  // bytes 28..31: loop frame — informational; we surface `loop=true`.
  const extraInfoSize = view.getUint16(32, false);

  const interleaved = (attributes & 0x01) !== 0;

  if (numFrames === 0) {
    throw new Error('cawtooth/ym: header declares 0 frames');
  }
  if (tickRate === 0) {
    throw new Error('cawtooth/ym: header declares 0 Hz tick rate');
  }
  if (clockFrequency === 0) {
    throw new Error('cawtooth/ym: header declares 0 Hz chip clock');
  }

  // Skip past digidrum sample directory + data + extra info block.
  let pos = 34 + extraInfoSize;
  for (let d = 0; d < digidrumCount; d++) {
    if (pos + 4 > bytes.length) {
      throw new Error('cawtooth/ym: truncated digidrum sample-size table');
    }
    pos += 4;
  }
  for (let d = 0; d < digidrumCount; d++) {
    // Re-read the size — we'd have to walk twice anyway since sizes are
    // not contiguous with their bytes per the spec.
    const sizeOffset = 34 + extraInfoSize + d * 4;
    const size = view.getUint32(sizeOffset, false);
    if (pos + size > bytes.length) {
      throw new Error(`cawtooth/ym: truncated digidrum sample data #${d}`);
    }
    pos += size;
  }

  // Three null-terminated strings: song name, author, comment.
  const decoder = new TextDecoder('windows-1252');
  const strings: string[] = [];
  for (let s = 0; s < 3; s++) {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    if (pos >= bytes.length) {
      throw new Error(`cawtooth/ym: unterminated metadata string #${s}`);
    }
    strings.push(decoder.decode(bytes.subarray(start, pos)));
    pos++; // consume null
  }
  const [title, author, comment] = strings;

  const expectedRegBytes = numFrames * YM_REGISTER_COUNT;
  if (pos + expectedRegBytes > bytes.length) {
    throw new Error(
      `cawtooth/ym: register data underruns header — need ${expectedRegBytes} ` +
        `bytes after offset ${pos}, have ${bytes.length - pos}`,
    );
  }

  const regData = bytes.subarray(pos, pos + expectedRegBytes);
  // Trailing "End!" sentinel is informational — we don't reject if it's
  // missing since some files in the wild have been re-packed without it.

  // De-interleave (column-major → row-major) when the attribute bit
  // says so. Frame-major files are read directly as rows.
  const sample = (frame: number, reg: number): number => {
    if (interleaved) return regData[reg * numFrames + frame];
    return regData[frame * YM_REGISTER_COUNT + reg];
  };

  const regs: number[] = [];
  const values: number[] = [];
  const delays: number[] = [];

  // Track 14 registers for change detection (YM stores 16 but R14/R15
  // are I/O ports / digidrum control we don't emit to the chip).
  const TRACKED = 14;
  const lastValue = new Int16Array(TRACKED);
  let pendingDelay = 0;

  for (let frame = 0; frame < numFrames; frame++) {
    let frameHadWrite = false;
    for (let k = 0; k < TRACKED; k++) {
      const value = sample(frame, k);
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
    throw new Error('cawtooth/ym: file contained no register changes');
  }
  delays[delays.length - 1] += pendingDelay;

  return {
    stream: {
      regs: Uint16Array.from(regs),
      values: Uint8Array.from(values),
      delayTicks: Uint32Array.from(delays),
    },
    tickRate,
    container: 'ym',
    variant,
    // YM is the Atari ST flagship format — YM2149 second-source chip.
    model: 'YM2149',
    clockFrequency,
    title,
    author,
    comment,
    loop: true,
  };
}
