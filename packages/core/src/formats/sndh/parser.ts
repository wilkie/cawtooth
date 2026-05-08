/**
 * SNDH metadata parser.
 *
 * Layout in source order:
 *   bytes 0x00–0x0B : 3 × `BRA.W disp16` to init / exit / play
 *   bytes 0x0C–0x0F : magic `'SNDH'`
 *   bytes 0x10..    : variable-length tag stream, terminated by `'HDNS'`
 *   then            : the m68k player binary (loaded verbatim into RAM)
 *
 * Tags come in two shapes:
 *   - 4-char ASCII tag + null-terminated CP1252 string
 *     (`TITL`, `COMM`, `RIPP`, `CONV`, `YEAR`, `FLAG`, `!#SN`)
 *   - 2-char prefix + ASCII digits + null
 *     (`TA{N}`, `TB{N}`, `TC{N}`, `TD{N}`, `!V{N}`)
 *
 * Plus a few binary outliers:
 *   - `TIME` : `subsongCount × 2` bytes of BE u16 durations (seconds)
 *   - `FRMS` : 4 bytes of BE u32 total frame count
 *   - `##NN` / `!#NN` : 4-char tag where positions 2–3 are subsong digits
 *
 * Tags are not consistently word-aligned in real-world files (e.g.
 * `Jupiter_Probe.sndh` packs `CONV"Grazey"\0YEAR...` with no padding),
 * so we walk byte-by-byte and trust each branch to leave the cursor
 * sitting on the next tag.
 */

import type { SndhSong, SndhTimer } from './types.js';

const MAGIC_SNDH = 0x534e4448; // 'SNDH'

const decoder = new TextDecoder('windows-1252');

function readU16BE(b: Uint8Array, off: number): number {
  return (b[off]! << 8) | b[off + 1]!;
}

function readU32BE(b: Uint8Array, off: number): number {
  return (
    ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>>
    0
  );
}

interface ZString {
  readonly text: string;
  readonly nextOff: number;
}

function readZString(b: Uint8Array, start: number): ZString {
  let i = start;
  while (i < b.length && b[i] !== 0) i++;
  const text = decoder.decode(b.subarray(start, i));
  return { text, nextOff: Math.min(i + 1, b.length) };
}

function tag4(b: Uint8Array, off: number): string {
  if (off + 4 > b.length) return '';
  return String.fromCharCode(b[off]!, b[off + 1]!, b[off + 2]!, b[off + 3]!);
}

function readBraTarget(b: Uint8Array, off: number): number {
  if (b[off] !== 0x60 || b[off + 1] !== 0x00) {
    throw new Error(
      `cawtooth/sndh: expected BRA.W at offset 0x${off.toString(16)} (got 0x${b[off]!.toString(16)} 0x${b[off + 1]!.toString(16)})`,
    );
  }
  // m68k BRA.W displacement is signed and applied from PC-after-opcode
  // (i.e. the address of the displacement word, == off + 2).
  const disp = (b[off + 2]! << 8) | b[off + 3]!;
  const signed = disp & 0x8000 ? disp - 0x10000 : disp;
  return off + 2 + signed;
}

function timerTypeOf(prefix: string): SndhTimer['type'] | undefined {
  if (prefix === 'TA') return 'A';
  if (prefix === 'TB') return 'B';
  if (prefix === 'TC') return 'C';
  if (prefix === 'TD') return 'D';
  if (prefix === '!V') return 'V';
  return undefined;
}

export function parseSndh(bytes: Uint8Array): SndhSong {
  if (bytes.length < 0x10) {
    throw new Error('cawtooth/sndh: file too short for header');
  }
  if (readU32BE(bytes, 0x0c) !== MAGIC_SNDH) {
    throw new Error('cawtooth/sndh: missing SNDH magic at offset 0x0C');
  }

  const initAddress = readBraTarget(bytes, 0);
  const exitAddress = readBraTarget(bytes, 4);
  const playAddress = readBraTarget(bytes, 8);

  let title = '';
  let composer = '';
  let ripper = '';
  let converter = '';
  let year = '';
  let timer: SndhTimer | undefined;
  let subsongCount = 1;
  let defaultSubsong = 1;
  let flags = '';
  let timeOffset = -1;

  let off = 0x10;
  const max = bytes.length;

  while (off < max) {
    const lookahead = tag4(bytes, off);
    if (lookahead === 'HDNS') {
      off += 4;
      break;
    }

    // Timer tags use a 2-char prefix and embed the frequency in the
    // same null-terminated run (`TC50\0`).
    const prefix2 = lookahead.slice(0, 2);
    const tType = timerTypeOf(prefix2);
    if (tType !== undefined) {
      const r = readZString(bytes, off + 2);
      const freq = parseInt(r.text, 10);
      if (Number.isFinite(freq) && freq > 0) {
        timer = { type: tType, frequencyHz: freq };
      }
      off = r.nextOff;
      continue;
    }

    const tag = lookahead;
    const dataOff = off + 4;

    switch (tag) {
      case 'TITL': {
        const r = readZString(bytes, dataOff);
        title = r.text;
        off = r.nextOff;
        break;
      }
      case 'COMM': {
        const r = readZString(bytes, dataOff);
        composer = r.text;
        off = r.nextOff;
        break;
      }
      case 'RIPP': {
        const r = readZString(bytes, dataOff);
        ripper = r.text;
        off = r.nextOff;
        break;
      }
      case 'CONV': {
        const r = readZString(bytes, dataOff);
        converter = r.text;
        off = r.nextOff;
        break;
      }
      case 'YEAR': {
        const r = readZString(bytes, dataOff);
        year = r.text;
        off = r.nextOff;
        break;
      }
      case 'FLAG': {
        const r = readZString(bytes, dataOff);
        flags = r.text;
        off = r.nextOff;
        break;
      }
      case '!#SN': {
        const r = readZString(bytes, dataOff);
        const n = parseInt(r.text, 10);
        if (Number.isFinite(n) && n > 0) subsongCount = n;
        off = r.nextOff;
        break;
      }
      case 'FRMS': {
        // Total frame count, BE u32. We don't surface it on SndhSong
        // directly; the duration table (`TIME`) is the per-subsong source.
        off = dataOff + 4;
        break;
      }
      case 'TIME': {
        // Length depends on subsongCount, which may have been parsed
        // already or may come later. Defer the actual read.
        timeOffset = dataOff;
        off = dataOff + Math.max(2, subsongCount * 2);
        break;
      }
      default: {
        // `##NN` / `!#NN` pack 2 ASCII digits into the tag itself.
        if (tag.startsWith('##') || tag.startsWith('!#')) {
          const n = parseInt(tag.slice(2), 10);
          if (Number.isFinite(n) && n > 0) subsongCount = n;
          off = dataOff;
          break;
        }
        // Unknown 4-char tag: best effort — assume null-terminated string.
        const r = readZString(bytes, dataOff);
        off = r.nextOff;
        break;
      }
    }
  }

  let durations: number[] = [];
  if (timeOffset >= 0 && subsongCount > 0) {
    durations = [];
    for (let i = 0; i < subsongCount; i++) {
      const o = timeOffset + i * 2;
      if (o + 2 > bytes.length) break;
      durations.push(readU16BE(bytes, o));
    }
  }

  return {
    binary: bytes,
    initAddress,
    exitAddress,
    playAddress,
    title,
    composer,
    ripper,
    converter,
    year,
    timer,
    subsongCount,
    defaultSubsong,
    flags,
    durations,
  };
}
