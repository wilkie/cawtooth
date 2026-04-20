/**
 * DRO (DOSBox Raw OPL) parser.
 *
 * DRO captures the OPL register writes a game performs while running under
 * DOSBox, producing a game-agnostic replay file. Two on-disk variants exist:
 *
 *   - v1 (DOSBox 0.63–0.73) — in-stream opcodes for delays and bank switches.
 *   - v2 (DOSBox 0.74+) — fixed-size (cmd, val) pairs with a codemap.
 *
 * Note on field sizes: v1 and v2 encode their version numbers differently —
 * v1 uses two u16 LE (major, minor), v2 uses two u8. The downstream fields
 * live at different offsets as a result. We read version as u16 at offset 8
 * and branch on major; v2's major happens to also read cleanly (the second
 * byte is always 0 since v2 is on major 2) so the check is unambiguous.
 *
 * Both formats decode to the library's common `RegisterEventStream`. Unlike
 * IMF, DRO records its own wall-clock timing in milliseconds, so playback
 * uses a fixed `tickRate` of 1000. OPL3 upper-bank writes round-trip through
 * the 9-bit register space (`reg | 0x100`).
 */

import type { RegisterEventStream } from '../../sequencer/types.js';

export interface DroSong {
  /** Parsed register-write events. */
  readonly stream: RegisterEventStream;
  /** Always 1000 — DRO timing is in milliseconds. */
  readonly tickRate: 1000;
  /** DRO on-disk variant. */
  readonly variant: 'v1' | 'v2';
  /** Hardware the capture was taken against (informational; playback ignores). */
  readonly hardware: 'opl2' | 'dual-opl2' | 'opl3';
  /** Total duration from the file header (ms). Useful as a sanity check. */
  readonly durationMs: number;
}

const MAGIC = [0x44, 0x42, 0x52, 0x41, 0x57, 0x4f, 0x50, 0x4c]; // "DBRAWOPL"

export function parseDro(bytes: Uint8Array): DroSong {
  if (bytes.length < 12) {
    throw new Error('cawtooth/dro: file too short to contain a header');
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) {
      throw new Error('cawtooth/dro: not a DRO file (missing DBRAWOPL magic)');
    }
  }

  // Read version major as u16 LE at offset 8. v2 stores this as u8 followed
  // by u8 minor, but minor is always 0, so the u16 read still yields 2.
  const versionMajor = bytes[8] | (bytes[9] << 8);

  if (versionMajor === 2) {
    return parseV2(bytes);
  }
  if (versionMajor === 0) {
    return parseV1(bytes);
  }
  throw new Error(
    `cawtooth/dro: unsupported DRO version major ${versionMajor} ` +
      `(expected 0 for v1 or 2 for v2)`,
  );
}

/* ──────────────────────────────── v2 ──────────────────────────────── */

/**
 * v2 header layout:
 *   [0..8)   magic "DBRAWOPL"
 *   [8]      iVersionMajor (u8, = 2)
 *   [9]      iVersionMinor (u8, = 0)
 *   [10..14) iLengthPairs  (u32 LE) — number of (cmd, val) pairs
 *   [14..18) iLengthMS     (u32 LE) — duration
 *   [18]     iHardwareType (u8)     — 0=OPL2, 1=dual-OPL2, 2=OPL3
 *   [19]     iFormat       (u8)     — must be 0 (interleaved)
 *   [20]     iCompression  (u8)     — must be 0 (uncompressed)
 *   [21]     iShortDelayCode (u8)
 *   [22]     iLongDelayCode  (u8)
 *   [23]     iCodemapLength  (u8)   — N
 *   [24..24+N) codemap — register number for each 7-bit cmd index
 *   [24+N..) data — iLengthPairs × 2 bytes
 */
function parseV2(bytes: Uint8Array): DroSong {
  if (bytes.length < 24) {
    throw new Error('cawtooth/dro: v2 header truncated');
  }
  const lengthPairs = readU32LE(bytes, 10);
  const durationMs = readU32LE(bytes, 14);
  const iHardwareType = bytes[18];
  const iFormat = bytes[19];
  const iCompression = bytes[20];
  const shortDelayCode = bytes[21];
  const longDelayCode = bytes[22];
  const codemapLength = bytes[23];

  if (iFormat !== 0) {
    throw new Error(`cawtooth/dro: v2 format ${iFormat} not supported (only 0 = interleaved)`);
  }
  if (iCompression !== 0) {
    throw new Error(`cawtooth/dro: v2 compression ${iCompression} not supported (only 0 = none)`);
  }

  const codemapOffset = 24;
  const dataOffset = codemapOffset + codemapLength;
  if (bytes.length < dataOffset) {
    throw new Error('cawtooth/dro: v2 codemap truncated');
  }
  // DOSBox sometimes writes a slightly longer data section than iLengthPairs
  // implies, and the spec says to trust the pair count. Clamp to what fits.
  const availablePairs = Math.floor((bytes.length - dataOffset) / 2);
  const pairsToRead = Math.min(lengthPairs, availablePairs);

  const codemap = bytes.subarray(codemapOffset, dataOffset);

  const regs: number[] = [];
  const values: number[] = [];
  const delays: number[] = [];
  let accumulatedMs = 0;

  for (let i = 0; i < pairsToRead; i++) {
    const o = dataOffset + i * 2;
    const cmd = bytes[o];
    const val = bytes[o + 1];

    if (cmd === shortDelayCode) {
      accumulatedMs += val + 1;
      continue;
    }
    if (cmd === longDelayCode) {
      accumulatedMs += (val + 1) << 8;
      continue;
    }

    const index = cmd & 0x7f;
    if (index >= codemapLength) {
      throw new Error(
        `cawtooth/dro: v2 codemap index ${index} out of range (codemap size ${codemapLength})`,
      );
    }
    const highBank = (cmd & 0x80) !== 0;
    const reg = codemap[index] | (highBank ? 0x100 : 0);

    flushDelay(regs, values, delays, accumulatedMs);
    accumulatedMs = 0;
    regs.push(reg);
    values.push(val);
    delays.push(0);
  }

  if (delays.length > 0) {
    delays[delays.length - 1] = accumulatedMs;
  }

  return {
    stream: toStream(regs, values, delays),
    tickRate: 1000,
    variant: 'v2',
    hardware: mapHardwareV2(iHardwareType),
    durationMs,
  };
}

/* ──────────────────────────────── v1 ──────────────────────────────── */

/**
 * v1 header layout:
 *   [0..8)   magic "DBRAWOPL"
 *   [8..10)  iVersionMajor (u16 LE, = 0)
 *   [10..12) iVersionMinor (u16 LE, = 0 or 1)
 *   [12..16) iLengthMS     (u32 LE)
 *   [16..20) iLengthBytes  (u32 LE) — bytes in the data section
 *   [20]     iHardwareType (u8)
 *   [21..24) (usually three zero bytes: iFormat, iCompression, iReserved)
 *   [24..)   data — opcode stream
 *
 * In the wild, every v1 capture we've seen has data at offset 24; the three
 * bytes after iHardwareType are either explicit zero fields (iFormat,
 * iCompression, iReserved) or padding to a u32 alignment. The hot-earliest
 * layout with data at offset 21 is theoretically possible but vanishingly
 * rare, so we don't handle it.
 */
function parseV1(bytes: Uint8Array): DroSong {
  if (bytes.length < 24) {
    throw new Error('cawtooth/dro: v1 header truncated');
  }
  const durationMs = readU32LE(bytes, 12);
  const lengthBytes = readU32LE(bytes, 16);
  const hardwareType = bytes[20];

  const dataOffset = 24;
  const dataEnd = Math.min(bytes.length, dataOffset + lengthBytes);

  const regs: number[] = [];
  const values: number[] = [];
  const delays: number[] = [];
  let accumulatedMs = 0;
  let highBank = false;

  let i = dataOffset;
  while (i < dataEnd) {
    const opcode = bytes[i++];

    if (opcode === 0x00) {
      // Short delay: next byte = (ms - 1), so 1..256 ms.
      if (i >= dataEnd) break;
      accumulatedMs += bytes[i++] + 1;
      continue;
    }
    if (opcode === 0x01) {
      // Long delay: next 2 bytes = (ms - 1) as u16 LE.
      if (i + 1 >= dataEnd) break;
      accumulatedMs += (bytes[i] | (bytes[i + 1] << 8)) + 1;
      i += 2;
      continue;
    }
    if (opcode === 0x02) {
      highBank = false;
      continue;
    }
    if (opcode === 0x03) {
      highBank = true;
      continue;
    }

    let reg: number;
    let val: number;
    if (opcode === 0x04) {
      // Escape: next two bytes are the actual (reg, val) — used when the
      // register number would collide with an opcode (0x00–0x04).
      if (i + 1 >= dataEnd) break;
      reg = bytes[i];
      val = bytes[i + 1];
      i += 2;
    } else {
      // Direct: opcode IS the register number (0x05..0xFF).
      if (i >= dataEnd) break;
      reg = opcode;
      val = bytes[i++];
    }

    const fullReg = reg | (highBank ? 0x100 : 0);
    flushDelay(regs, values, delays, accumulatedMs);
    accumulatedMs = 0;
    regs.push(fullReg);
    values.push(val);
    delays.push(0);
  }

  if (delays.length > 0) {
    delays[delays.length - 1] = accumulatedMs;
  }

  return {
    stream: toStream(regs, values, delays),
    tickRate: 1000,
    variant: 'v1',
    hardware: mapHardwareV1(hardwareType),
    durationMs,
  };
}

/* ──────────────────────────────── helpers ──────────────────────────────── */

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/**
 * Attach any pending cross-event delay to the preceding event, or synthesize
 * a leading-silence event if nothing has been written yet. DRO expresses
 * delays between writes; our stream format attaches the delay to the
 * preceding event, so this is where that translation happens.
 */
function flushDelay(
  regs: number[],
  values: number[],
  delays: number[],
  accumulatedMs: number,
): void {
  if (regs.length === 0) {
    if (accumulatedMs > 0) {
      regs.push(0);
      values.push(0);
      delays.push(accumulatedMs);
    }
    return;
  }
  delays[delays.length - 1] = accumulatedMs;
}

/** v1 hardware code: 0=OPL2, 1=OPL3, 2=dual-OPL2 (legacy ordering). */
function mapHardwareV1(code: number): DroSong['hardware'] {
  if (code === 0) return 'opl2';
  if (code === 1) return 'opl3';
  if (code === 2) return 'dual-opl2';
  return 'opl2';
}

/** v2 hardware code: 0=OPL2, 1=dual-OPL2, 2=OPL3 (spec-corrected order). */
function mapHardwareV2(code: number): DroSong['hardware'] {
  if (code === 0) return 'opl2';
  if (code === 1) return 'dual-opl2';
  if (code === 2) return 'opl3';
  return 'opl2';
}

function toStream(regs: number[], values: number[], delays: number[]): RegisterEventStream {
  return {
    regs: new Uint16Array(regs),
    values: new Uint8Array(values),
    delayTicks: new Uint32Array(delays),
  };
}
