/**
 * DRO v2 encoder — writes a `RegisterEventStream` out as a DOSBox Raw OPL
 * v2 file. See `docs/formats/dro.md` for the full on-disk layout.
 *
 * Encoding strategy:
 *   1. Walk the stream once to collect the set of register numbers that get
 *      written (ignoring the OPL3 upper-bank bit — that's encoded separately
 *      as a high bit on the command byte).
 *   2. Build a codemap in first-seen order. The codemap size must be at
 *      most 126 so there are two free slots for the short/long delay codes.
 *   3. Reserve `codemap.length` as the short-delay code and
 *      `codemap.length + 1` as the long-delay code.
 *   4. Walk the stream again: for each event emit (index | bank_bit, val),
 *      then encode its trailing delay as zero or more delay pairs.
 *
 * Delay unit conversion: stream delays are in ticks at `timed.tickRate` Hz.
 * DRO counts in milliseconds. We round to nearest ms and then split each
 * delay into long (256 * (val+1) ms) and short ((val+1) ms) pairs.
 */

import type { TimedRegisterStream } from '../../sequencer/types.js';

const MAGIC = [0x44, 0x42, 0x52, 0x41, 0x57, 0x4f, 0x50, 0x4c]; // "DBRAWOPL"
const V2_HEADER_SIZE_BEFORE_CODEMAP = 24;
const MAX_CODEMAP_SIZE = 126; // 128 - 2 reserved delay codes, minus one for bank-bit safety

export interface EncodeDroOptions {
  /**
   * Informational hardware-type byte. When omitted we infer: OPL3 if any
   * upper-bank write is present, else OPL2. Playback doesn't use this
   * field — the chip state is driven entirely by register writes — but
   * other tools do display it.
   */
  readonly hardware?: 'opl2' | 'dual-opl2' | 'opl3' | 'auto';
}

export function encodeDro(timed: TimedRegisterStream, options: EncodeDroOptions = {}): Uint8Array {
  const { stream, tickRate } = timed;
  if (!(tickRate > 0)) {
    throw new Error(`cawtooth/dro: tickRate must be positive (got ${tickRate})`);
  }

  // Pass 1: collect unique low-byte register numbers in first-seen order.
  // The OPL3 upper-bank bit is orthogonal — we encode it as a high bit on
  // the command byte, not as a separate codemap entry.
  const codemap: number[] = [];
  const codemapIndex = new Map<number, number>();
  let hasUpperBank = false;
  for (let i = 0; i < stream.regs.length; i++) {
    const reg = stream.regs[i];
    const base = reg & 0xff;
    if (reg >= 0x100) hasUpperBank = true;
    if (!codemapIndex.has(base)) {
      codemapIndex.set(base, codemap.length);
      codemap.push(base);
    }
  }
  if (codemap.length > MAX_CODEMAP_SIZE) {
    throw new Error(
      `cawtooth/dro: stream uses ${codemap.length} distinct register numbers; ` +
        `DRO v2 supports at most ${MAX_CODEMAP_SIZE}.`,
    );
  }

  const shortDelayCode = codemap.length;
  const longDelayCode = codemap.length + 1;

  // Pass 2: emit the (cmd, val) pairs, interleaving delay pairs as needed.
  const pairs: number[] = []; // flat [cmd0, val0, cmd1, val1, ...]
  let totalMs = 0;

  for (let i = 0; i < stream.regs.length; i++) {
    const reg = stream.regs[i];
    const base = reg & 0xff;
    const idx = codemapIndex.get(base)!;
    const cmd = reg >= 0x100 ? idx | 0x80 : idx;
    pairs.push(cmd, stream.values[i]);

    const ticks = stream.delayTicks[i];
    if (ticks > 0) {
      const ms = Math.round((ticks * 1000) / tickRate);
      totalMs += ms;
      emitDelay(pairs, ms, shortDelayCode, longDelayCode);
    }
  }

  // Resolve hardware byte.
  const hw = options.hardware ?? 'auto';
  let hardwareCode: number;
  if (hw === 'auto') {
    hardwareCode = hasUpperBank ? 2 : 0; // v2: 0=OPL2, 1=dual-OPL2, 2=OPL3
  } else if (hw === 'opl2') hardwareCode = 0;
  else if (hw === 'dual-opl2') hardwareCode = 1;
  else hardwareCode = 2; // opl3

  const lengthPairs = pairs.length / 2;
  const totalBytes = V2_HEADER_SIZE_BEFORE_CODEMAP + codemap.length + pairs.length;
  const out = new Uint8Array(totalBytes);

  // Magic.
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC[i];
  // Version (u8 major, u8 minor).
  out[8] = 2;
  out[9] = 0;
  // lengthPairs (u32 LE).
  writeU32LE(out, 10, lengthPairs);
  // lengthMS (u32 LE).
  writeU32LE(out, 14, totalMs);
  // iHardwareType / iFormat / iCompression.
  out[18] = hardwareCode;
  out[19] = 0;
  out[20] = 0;
  // Delay codes + codemap length.
  out[21] = shortDelayCode;
  out[22] = longDelayCode;
  out[23] = codemap.length;
  // Codemap.
  for (let i = 0; i < codemap.length; i++) out[24 + i] = codemap[i];
  // Data pairs.
  const dataOffset = V2_HEADER_SIZE_BEFORE_CODEMAP + codemap.length;
  for (let i = 0; i < pairs.length; i++) out[dataOffset + i] = pairs[i];

  return out;
}

/**
 * Emit zero or more delay pairs that sum to `ms` milliseconds.
 *
 * - Long delay: (longCode, val) means (val + 1) × 256 ms. Max 65,536 ms
 *   per pair (val=255).
 * - Short delay: (shortCode, val) means (val + 1) ms. Max 256 ms per pair.
 *
 * For delays above 65,536 ms we repeat long-delay pairs.
 */
function emitDelay(pairs: number[], ms: number, shortCode: number, longCode: number): void {
  let remaining = ms;
  while (remaining >= 256) {
    const units = Math.min(256, Math.floor(remaining / 256));
    pairs.push(longCode, units - 1);
    remaining -= units * 256;
  }
  if (remaining > 0) {
    pairs.push(shortCode, remaining - 1);
  }
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
