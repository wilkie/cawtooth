/**
 * HSQ decompression — the LZSS variant Cryo Interactive used for HERAD music
 * files from Dune (1992) onward.
 *
 * Scope: this module handles the *compression layer* only. It turns an HSQ
 * blob into its decompressed HERAD payload. Parsing that payload (patterns,
 * tracks, instruments, events) is a separate concern — see the HERAD parser
 * (Phase B).
 *
 * The same compression scheme underlies several extensions:
 *   - .HSQ — classic HERAD v1 compressed music (OPL2 / AdLib).
 *   - .AGD — HERAD compressed music for AdLib Gold (OPL3-ish).
 *   - .HA2 — HERAD v2 compressed music (only differs at the payload level).
 *   - .SQX — a newer Cryo compression variant with different parameters.
 *     Not handled here; flag if you see one and we'll extend.
 *
 * ## Header (6 bytes)
 *
 * ```
 * [0..2)  u16 LE   decompressed size
 * [2]     u8       always 0x00 in practice
 * [3..5)  u16 LE   compressed size (INCLUDING this header)
 * [5]     u8       checksum byte — chosen so the six header bytes sum to 0xAB (mod 256)
 * ```
 *
 * ## Data
 *
 * After the header, a stream of variable-length codes. A 16-bit "queue" of
 * compression flags is read from the input (u16 LE) and consumed LSB-first;
 * when drained, another u16 is read to refill.
 *
 *   - queue bit = 1 → emit one literal byte copied from the input.
 *   - queue bit = 0 → back-reference. One more queue bit decides the sub-form:
 *     - sub-bit = 1 → long reference, two bytes follow:
 *         b1, b2 where length = (b2 & 7) and offset = ((b2 & 0xF8) << 5) | b1
 *         offset is then shifted by -0x2000 to land in [-8192, -1].
 *         If length == 0, read one more byte as an explicit length; if that
 *         byte is itself 0, the stream ends.
 *         length += 2 before use.
 *     - sub-bit = 0 → short reference, two more queue bits + one input byte:
 *         length = (bit << 1 | bit) + 2; offset = (byte) - 256.
 */

export interface HsqHeader {
  /** Total bytes that will be written to the output buffer. */
  readonly decompressedSize: number;
  /** Size of the on-disk file *including* the 6-byte header. */
  readonly compressedSize: number;
}

const HEADER_SIZE = 6;
const HEADER_CHECKSUM = 0xab;

/**
 * Parse and validate the 6-byte HSQ header. Throws if the checksum fails.
 * A valid checksum is a strong signal that the payload is in fact HSQ (the
 * probability of a 6-byte random tail summing to exactly 0xAB is 1/256).
 */
export function readHsqHeader(bytes: Uint8Array): HsqHeader {
  if (bytes.length < HEADER_SIZE) {
    throw new Error(`cawtooth/hsq: input too short for a header (${bytes.length} bytes)`);
  }
  let sum = 0;
  for (let i = 0; i < HEADER_SIZE; i++) sum += bytes[i];
  if ((sum & 0xff) !== HEADER_CHECKSUM) {
    throw new Error(
      `cawtooth/hsq: header checksum 0x${(sum & 0xff).toString(16)} does not match 0xab`,
    );
  }
  return {
    decompressedSize: bytes[0] | (bytes[1] << 8),
    compressedSize: bytes[3] | (bytes[4] << 8),
  };
}

/**
 * Fast header-only check: returns true if `bytes` could plausibly be an HSQ
 * blob. Useful for format dispatch when you're handed an unknown binary and
 * need to pick a parser.
 */
export function isHsq(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_SIZE) return false;
  let sum = 0;
  for (let i = 0; i < HEADER_SIZE; i++) sum += bytes[i];
  return (sum & 0xff) === HEADER_CHECKSUM;
}

/**
 * Decompress HSQ-compressed bytes into a fresh Uint8Array. Output length
 * matches `decompressedSize` from the header exactly; short reads throw.
 */
export function decompressHsq(bytes: Uint8Array): Uint8Array {
  const header = readHsqHeader(bytes);
  const { decompressedSize, compressedSize } = header;

  if (compressedSize > bytes.length) {
    throw new Error(
      `cawtooth/hsq: header claims ${compressedSize} bytes but only ${bytes.length} are available`,
    );
  }

  const output = new Uint8Array(decompressedSize);
  let outPos = 0;
  let inPos = HEADER_SIZE;

  // Queue uses the AdPlug "sentinel bit" trick: on load we OR in 0x10000, so
  // the queue has 17 bits where bit 16 is a sentinel marker. When the queue
  // has been shifted down to exactly 1, we know all 16 data bits have been
  // consumed and it's time to refill. Starting value of 1 forces the initial
  // refill on the first call.
  let queue = 1;

  const getBit = (): number => {
    if (queue === 1) {
      if (inPos + 1 >= compressedSize) {
        throw new Error('cawtooth/hsq: truncated input while refilling bit queue');
      }
      queue = bytes[inPos] | (bytes[inPos + 1] << 8) | 0x10000;
      inPos += 2;
    }
    const bit = queue & 1;
    queue >>>= 1;
    return bit;
  };

  while (true) {
    if (getBit() === 1) {
      if (inPos >= compressedSize) {
        throw new Error('cawtooth/hsq: truncated input reading a literal');
      }
      if (outPos < decompressedSize) output[outPos] = bytes[inPos];
      outPos++;
      inPos++;
      continue;
    }

    let length: number;
    let offset: number;

    if (getBit() === 1) {
      // Long reference. Read 2 bytes as u16 LE; offset is the top 13 bits
      // (minus 8192 to make it negative), length is the bottom 3.
      if (inPos + 1 >= compressedSize) {
        throw new Error('cawtooth/hsq: truncated input reading a long reference');
      }
      const packed = bytes[inPos] | (bytes[inPos + 1] << 8);
      inPos += 2;
      offset = (packed >> 3) - 0x2000;
      length = packed & 0x07;

      if (length === 0) {
        // Escape: an explicit length byte follows. A byte of zero marks
        // end-of-stream — real HSQ files reliably end this way.
        if (inPos >= compressedSize) {
          throw new Error('cawtooth/hsq: truncated input reading an explicit length');
        }
        length = bytes[inPos++];
        if (length === 0) break;
      }
    } else {
      // Short reference: two queue bits for a 2-bit length, one byte for offset.
      const hi = getBit();
      const lo = getBit();
      if (inPos >= compressedSize) {
        throw new Error('cawtooth/hsq: truncated input reading a short reference');
      }
      length = (hi << 1) | lo;
      offset = bytes[inPos++] - 256;
    }

    length += 2;

    const srcStart = outPos + offset;
    if (srcStart < 0) {
      throw new Error(
        `cawtooth/hsq: back-reference offset ${offset} at outPos ${outPos} reaches before start`,
      );
    }
    // Copy length bytes, allowing the source range to overlap the destination
    // (this is how LZSS run-length encoding of a repeating byte pattern works).
    for (let i = 0; i < length; i++) {
      if (outPos < decompressedSize) output[outPos] = output[outPos + offset];
      outPos++;
    }
  }

  if (outPos < decompressedSize) {
    throw new Error(
      `cawtooth/hsq: stream ended early — produced ${outPos} bytes, header declared ${decompressedSize}`,
    );
  }

  return output;
}
