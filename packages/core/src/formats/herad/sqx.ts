/**
 * SQX decompression — Cryo's second-generation HERAD compression.
 *
 * SQX is a cousin of HSQ: same LZSS-with-bit-queue foundation, but each file
 * carries its own table of three operations to run (one per combination of
 * compression flag bits), plus a parameterisable long-reference bit count.
 * A single decoder handles every concrete variant Cryo shipped.
 *
 * Header (6 bytes):
 *   [0..2)  u16 LE   Pre-fill bytes. Copied into output[0..2) before the LZ
 *                    codec runs, so back-references that reach before
 *                    position 0 (e.g. a short ref with offset -2 as the very
 *                    first op) land on valid data. The codec then writes
 *                    from output[0] onward and overwrites the pre-fill in
 *                    the typical case. SQX has NO explicit decompressed-size
 *                    field — output length is determined by how much the
 *                    codec emits before hitting the end-of-stream sentinel.
 *   [2]     u8       op for flag bit "0"    (0 = literal, 1 = short ref, 2 = long ref)
 *   [3]     u8       op for flag bits "10"  (same encoding)
 *   [4]     u8       op for flag bits "11"  (same encoding)
 *   [5]     u8       long-ref length-field bit count (1..15)
 *
 * Detection: `data[2..4]` each ≤ 2 and `data[5]` in 1..15. Unlike HSQ there's
 * no checksum byte, so detection is heuristic — false positives are possible
 * but unlikely in practice given the narrow field ranges.
 *
 * Bit queue: 16 bits per reload. SQX uses the "bit_p" trick — when the queue
 * drains, the next bit is read from the fresh 16-bit word, and the *previous*
 * queue bit is written into the MSB of the new queue. Preserves one bit of
 * state across the reload boundary.
 *
 * Short ref (op 1): read 2 bits of length (via the 3-bit-spanning-reload
 * mechanic), then 1 byte of offset in [-256, -1]. length += 2.
 *
 * Long ref (op 2): read 2 bytes as a u16, split by `data[5]`:
 *   offset = (u16 >> bits) - (1 << (16 - bits))   — negative, reaches back
 *                                                    up to 2^(16-bits) bytes
 *   length = u16 & ((1 << bits) - 1)
 *   if length == 0: read one more byte as an explicit length
 *   if that byte is 0: end of stream
 *   length += 2
 */

export interface SqxHeader {
  /** Per-flag operation codes (0=literal, 1=short ref, 2=long ref). */
  readonly op0: 0 | 1 | 2;
  readonly op10: 0 | 1 | 2;
  readonly op11: 0 | 1 | 2;
  /** Bit count for the long-reference length field (and implicitly its offset). */
  readonly longRefBits: number;
}

const HEADER_SIZE = 6;

/**
 * Fast header-only check: returns true if `bytes` could plausibly be SQX.
 * Useful for format dispatch when you're handed an unknown binary.
 */
export function isSqx(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_SIZE) return false;
  if (bytes[2] > 2 || bytes[3] > 2 || bytes[4] > 2) return false;
  if (bytes[5] === 0 || bytes[5] > 15) return false;
  return true;
}

export function readSqxHeader(bytes: Uint8Array): SqxHeader {
  if (bytes.length < HEADER_SIZE) {
    throw new Error(`cawtooth/sqx: input too short for a header (${bytes.length} bytes)`);
  }
  if (bytes[2] > 2 || bytes[3] > 2 || bytes[4] > 2) {
    throw new Error('cawtooth/sqx: invalid operation flags (must each be 0, 1, or 2)');
  }
  if (bytes[5] === 0 || bytes[5] > 15) {
    throw new Error(`cawtooth/sqx: invalid long-ref bit count ${bytes[5]} (expected 1..15)`);
  }
  return {
    op0: bytes[2] as 0 | 1 | 2,
    op10: bytes[3] as 0 | 1 | 2,
    op11: bytes[4] as 0 | 1 | 2,
    longRefBits: bytes[5],
  };
}

/**
 * HERAD's official cap on decompressed size (75 KB), used by AdPlug. SQX has
 * no explicit output-length field, so we allocate once at this ceiling and
 * trim the result to whatever the codec actually emitted.
 */
const SQX_MAX_OUTPUT = 75775;

/** Decompress SQX-compressed bytes into a fresh Uint8Array. */
export function decompressSqx(bytes: Uint8Array): Uint8Array {
  const header = readSqxHeader(bytes);
  const { op0, op10, op11, longRefBits } = header;

  const scratch = new Uint8Array(SQX_MAX_OUTPUT);
  // Pre-fill the first two bytes with the SQX header's equivalent field.
  // The LZ codec starts writing from output[0] and will overwrite these in
  // the typical case; their purpose is to give early back-references
  // (anything reaching before position 0) a defined value to look up.
  scratch[0] = bytes[0];
  scratch[1] = bytes[1];
  let outPos = 0;

  let inPos = HEADER_SIZE;
  let queue = 1;
  let bitP = 0;

  const readBit = (): number => {
    const bit = queue & 1;
    queue >>>= 1;
    if (queue === 0) {
      // Reload from the next 16-bit word, seeding the MSB with the bit we
      // just consumed so state survives the boundary.
      if (inPos + 1 >= bytes.length) {
        throw new Error('cawtooth/sqx: truncated input reloading bit queue');
      }
      queue = bytes[inPos] | (bytes[inPos + 1] << 8);
      inPos += 2;
      bitP = bit;
      const nextBit = queue & 1;
      queue >>>= 1;
      if (bitP) queue |= 0x8000;
      return nextBit;
    }
    return bit;
  };

  const longRefMask = (1 << longRefBits) - 1;
  const longRefOffsetBase = 1 << (16 - longRefBits);

  /** Execute one op; returns true if this op marks end-of-stream. */
  const runOp = (op: 0 | 1 | 2): boolean => {
    switch (op) {
      case 0: {
        // Literal byte.
        if (inPos >= bytes.length) {
          throw new Error('cawtooth/sqx: truncated input reading literal');
        }
        scratch[outPos++] = bytes[inPos++];
        return false;
      }
      case 1: {
        // Short reference: 2 length bits from the queue + 1 byte offset.
        const hi = readBit();
        const lo = readBit();
        if (inPos >= bytes.length) {
          throw new Error('cawtooth/sqx: truncated input reading short ref');
        }
        const offset = bytes[inPos++] - 256;
        const length = ((hi << 1) | lo) + 2;
        copyRef(scratch, outPos, offset, length);
        outPos += length;
        return false;
      }
      case 2: {
        // Long reference: 2 bytes packing offset + length.
        if (inPos + 1 >= bytes.length) {
          throw new Error('cawtooth/sqx: truncated input reading long ref');
        }
        const packed = bytes[inPos] | (bytes[inPos + 1] << 8);
        inPos += 2;
        const offset = (packed >>> longRefBits) - longRefOffsetBase;
        let length = packed & longRefMask;
        if (length === 0) {
          if (inPos >= bytes.length) {
            throw new Error('cawtooth/sqx: truncated input reading explicit length');
          }
          length = bytes[inPos++];
          if (length === 0) return true; // end of stream
        }
        length += 2;
        copyRef(scratch, outPos, offset, length);
        outPos += length;
        return false;
      }
    }
  };

  while (true) {
    const first = readBit();
    let op: 0 | 1 | 2;
    if (first === 0) {
      op = op0;
    } else {
      const second = readBit();
      op = second === 0 ? op10 : op11;
    }
    if (runOp(op)) break;
    if (outPos > SQX_MAX_OUTPUT - 260) {
      throw new Error(`cawtooth/sqx: decompressed output exceeds ${SQX_MAX_OUTPUT} byte ceiling`);
    }
  }

  return scratch.slice(0, outPos);
}

/**
 * Byte-by-byte back-reference copy. The source range may overlap the
 * destination (that's how LZSS encodes runs). Reaching before position 0 is
 * technically valid because the caller pre-fills the first two output bytes
 * from the SQX header — however, a reference that reaches before position 0
 * for MORE than two bytes signals genuinely malformed data, so we clamp
 * defensively and let garbage flow through rather than throwing (AdPlug does
 * similarly: no bounds check, Uint8Array access is implicitly clamped at 0).
 */
function copyRef(output: Uint8Array, outPos: number, offset: number, length: number): void {
  for (let i = 0; i < length; i++) {
    const srcIdx = outPos + i + offset;
    output[outPos + i] = srcIdx >= 0 ? output[srcIdx] : 0;
  }
}
