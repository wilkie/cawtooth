/**
 * LH5 (LHA "level 5") decompressor.
 *
 * LH5 is an LZSS sliding window (8 KiB / 13-bit offsets, minimum match
 * length 3) wrapped in two static-Huffman streams: a "code table" carries
 * literal bytes and length tokens, and a "position table" carries the
 * high bits of match offsets. Both tables are rebuilt at the start of
 * every compressed block, so the decoder is essentially a state machine
 * that reads tables, then reads block-many tokens, then loops.
 *
 * We need this for the AY scene's two heavyweight container formats:
 *   - `.vtx` — the entire register-stream payload after the text header
 *     is a raw LH5 bitstream (no LZH archive wrapper).
 *   - `.ym`  — almost every YM5/YM6 file in the wild ships inside an LZH
 *     archive whose single member is a raw register dump compressed with
 *     LH5.
 *
 * Implementation notes:
 *   - We use a plain binary-tree decoder (no fast-lookup table). For the
 *     small payloads typical of AY tracks (10–100 KiB after decompression)
 *     this is well under a millisecond and avoids the canonical-Huffman
 *     table-construction bugs that plague the LHA reference port.
 *   - Constants follow LHA convention (NC, NP, NT, CBIT, PBIT, TBIT) so
 *     anyone cross-referencing the spec finds familiar names.
 */

const DICTIONARY_BITS = 13;
const DICTIONARY_SIZE = 1 << DICTIONARY_BITS;
const THRESHOLD = 3;

const NC = 256 + 256 - THRESHOLD + 1; // 510 — literals + length tokens
const NP = DICTIONARY_BITS + 1; // 14 — position table alphabet
const NT = 19; // length-encoding table for c_table

const CBIT = 9; // bits to read for c_table count + zero-run lengths
const PBIT = 4; // bits per position-table per-symbol length
const TBIT = 5; // bits per length-encoding-table per-symbol length

const MAX_HUFF_BITS = 16;

/**
 * MSB-first bit reader. Returns 0 for any reads past end-of-stream — the
 * LHA convention is that the encoder zero-pads the last byte, so a
 * decoder that overshoots by a few bits during the last block doesn't
 * crash. Real corruption is caught when codes don't decode.
 */
class BitReader {
  private bitBuffer = 0;
  private bitCount = 0;
  private bytePos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readBits(n: number): number {
    while (this.bitCount < n) {
      const byte = this.bytePos < this.bytes.length ? this.bytes[this.bytePos++] : 0;
      this.bitBuffer = ((this.bitBuffer << 8) | byte) >>> 0;
      this.bitCount += 8;
    }
    const result = (this.bitBuffer >>> (this.bitCount - n)) & ((1 << n) - 1);
    this.bitCount -= n;
    return result;
  }
}

/**
 * Binary-tree Huffman decoder. Internal nodes are stored in `left[]` /
 * `right[]`; leaves carry their symbol in `symbol[]`. Index 0 is the
 * root. `singleton` is set when the table collapses to a single value
 * for the entire alphabet (LHA's degenerate "all-zero lengths" case),
 * in which case `decode()` returns it without consuming any bits.
 */
interface HuffTree {
  readonly left: Int32Array;
  readonly right: Int32Array;
  readonly symbol: Int32Array;
  readonly singleton: number; // -1 if no singleton
}

/**
 * Build a canonical-Huffman tree from per-symbol bit-lengths. `lengths[s]`
 * == 0 means symbol `s` is unused. Symbols are ordered by (length, then
 * symbol index); codes are assigned in that order with the standard
 * "increment then left-shift on length increase" rule.
 */
function buildTree(lengths: Uint8Array, alphabetSize: number): HuffTree {
  // Collect (sym, len) sorted by length then symbol.
  const symbols: number[] = [];
  for (let s = 0; s < alphabetSize; s++) {
    if (lengths[s] > 0) symbols.push(s);
  }
  symbols.sort((a, b) => lengths[a] - lengths[b] || a - b);

  if (symbols.length === 0) {
    // Every symbol is unused. Caller likely shouldn't be reading from
    // this table at all, but return an empty tree just in case.
    return {
      left: new Int32Array([-1]),
      right: new Int32Array([-1]),
      symbol: new Int32Array([-1]),
      singleton: -1,
    };
  }
  if (symbols.length === 1) {
    // Only one usable symbol — emit it for every decode without consuming
    // bits. LHA's canonical encoder does this implicitly via the n==0
    // special case in readBitLengthTable, but we keep the same data path
    // here so the rest of the code stays uniform.
    return {
      left: new Int32Array([-1]),
      right: new Int32Array([-1]),
      symbol: new Int32Array([-1]),
      singleton: symbols[0],
    };
  }

  const left: number[] = [-1];
  const right: number[] = [-1];
  const symbol: number[] = [-1];

  let code = 0;
  let prevLen = lengths[symbols[0]];
  let isFirst = true;
  for (const sym of symbols) {
    const len = lengths[sym];
    if (isFirst) {
      isFirst = false;
    } else {
      code += 1;
      if (len > prevLen) {
        code <<= len - prevLen;
      }
    }
    prevLen = len;
    if (len > MAX_HUFF_BITS) {
      throw new Error(`cawtooth/lh5: bit length ${len} exceeds ${MAX_HUFF_BITS}`);
    }
    if (code >= 1 << len) {
      throw new Error('cawtooth/lh5: malformed canonical Huffman codes (overflow)');
    }

    // Walk the tree from the root, allocating nodes as we go. The
    // top-most bit of `code` (bit position `len - 1`) is the first step.
    let node = 0;
    for (let depth = len - 1; depth > 0; depth--) {
      const goRight = ((code >>> depth) & 1) !== 0;
      const childArr = goRight ? right : left;
      let next = childArr[node];
      if (next === -1) {
        next = left.length;
        left.push(-1);
        right.push(-1);
        symbol.push(-1);
        childArr[node] = next;
      } else if (symbol[next] !== -1) {
        throw new Error('cawtooth/lh5: malformed Huffman tree (code prefix collision)');
      }
      node = next;
    }
    // Final bit places the leaf.
    const goRight = (code & 1) !== 0;
    const childArr = goRight ? right : left;
    if (childArr[node] !== -1) {
      throw new Error('cawtooth/lh5: malformed Huffman tree (duplicate code)');
    }
    const leafIdx = left.length;
    left.push(-1);
    right.push(-1);
    symbol.push(sym);
    childArr[node] = leafIdx;
  }

  return {
    left: Int32Array.from(left),
    right: Int32Array.from(right),
    symbol: Int32Array.from(symbol),
    singleton: -1,
  };
}

function decode(reader: BitReader, tree: HuffTree): number {
  if (tree.singleton !== -1) return tree.singleton;
  let node = 0;
  for (;;) {
    const bit = reader.readBits(1);
    node = bit === 0 ? tree.left[node] : tree.right[node];
    if (node === -1) {
      throw new Error('cawtooth/lh5: walked off end of Huffman tree (corrupt stream)');
    }
    const sym = tree.symbol[node];
    if (sym !== -1) return sym;
  }
}

/**
 * Decode the per-symbol bit-length list for a block-prefix table. Used
 * two ways:
 *
 *   - `(NT, TBIT, 3)` — the small "length-encoding" table that prefixes
 *     each block's c_table description. iSpecial=3 means "after writing
 *     pt_len[3], read a 2-bit count and skip that many zeros" — a tiny
 *     RLE for the common "first few entries are unused" pattern.
 *
 *   - `(NP, PBIT, -1)` — the position table itself. iSpecial=-1 disables
 *     the zero-run shortcut.
 *
 * The two paths are unified because LHA's bitstream uses the same
 * "3-bit-per-length plus 1-bit-extension escape" encoding for both.
 */
function readBitLengths(
  reader: BitReader,
  alphabetSize: number,
  nbit: number,
  iSpecial: number,
): Uint8Array {
  const result = new Uint8Array(alphabetSize);
  const n = reader.readBits(nbit);
  if (n === 0) {
    // Singleton: every decode of this table returns the same symbol.
    const sym = reader.readBits(nbit);
    if (sym >= alphabetSize) {
      throw new Error(
        `cawtooth/lh5: singleton symbol ${sym} out of range for alphabet ${alphabetSize}`,
      );
    }
    // Mark with a sentinel: length = MAX_HUFF_BITS + 1 means "this is the
    // singleton". buildTree() handles all-other-zero correctly via the
    // length===1-entry branch, so we can just set length 1 here as a
    // marker — but we need the caller to know the singleton symbol. Use
    // a side channel.
    (result as unknown as { singleton: number }).singleton = sym;
    return result;
  }

  let i = 0;
  while (i < n) {
    let c = reader.readBits(3);
    if (c === 7) {
      // 3 bits couldn't represent the length — extend with as many 1s as
      // it takes to reach the actual value, then consume the terminating
      // 0. The trailing zero is part of the encoding, NOT a peek-and-stop
      // sentinel; LHA's reference encoder spends `c - 3` bits *after* the
      // initial 3 (including that terminator), so a decoder that doesn't
      // eat the 0 here ends up off-by-one on every length ≥ 7. Cap at
      // MAX_HUFF_BITS so a corrupt stream can't loop forever.
      while (reader.readBits(1) === 1) {
        c++;
        if (c > MAX_HUFF_BITS) {
          throw new Error('cawtooth/lh5: bit length escape exceeded MAX_HUFF_BITS');
        }
      }
    }
    result[i++] = c;
    if (i === iSpecial) {
      let zeros = reader.readBits(2);
      while (zeros > 0 && i < alphabetSize) {
        result[i++] = 0;
        zeros--;
      }
    }
  }
  return result;
}

/** Read the c_table — uses pt_table as an intermediate length encoding. */
function readCTable(reader: BitReader): HuffTree {
  const ptLengths = readBitLengths(reader, NT, TBIT, 3);
  const ptSingleton = (ptLengths as unknown as { singleton?: number }).singleton;
  const ptTree =
    ptSingleton === undefined
      ? buildTree(ptLengths, NT)
      : ({
          left: new Int32Array([-1]),
          right: new Int32Array([-1]),
          symbol: new Int32Array([-1]),
          singleton: ptSingleton,
        } as HuffTree);

  const n = reader.readBits(CBIT);
  const cLengths = new Uint8Array(NC);
  if (n === 0) {
    const sym = reader.readBits(CBIT);
    if (sym >= NC) {
      throw new Error(`cawtooth/lh5: c_table singleton symbol ${sym} out of range`);
    }
    return {
      left: new Int32Array([-1]),
      right: new Int32Array([-1]),
      symbol: new Int32Array([-1]),
      singleton: sym,
    };
  }

  let i = 0;
  while (i < n) {
    const c = decode(reader, ptTree);
    if (c === 0) {
      cLengths[i++] = 0;
    } else if (c === 1) {
      let zeros = reader.readBits(4) + 3;
      while (zeros > 0 && i < NC) {
        cLengths[i++] = 0;
        zeros--;
      }
    } else if (c === 2) {
      let zeros = reader.readBits(CBIT) + 20;
      while (zeros > 0 && i < NC) {
        cLengths[i++] = 0;
        zeros--;
      }
    } else {
      cLengths[i++] = c - 2;
    }
  }
  return buildTree(cLengths, NC);
}

function readPTable(reader: BitReader): HuffTree {
  const lengths = readBitLengths(reader, NP, PBIT, -1);
  const singleton = (lengths as unknown as { singleton?: number }).singleton;
  if (singleton !== undefined) {
    return {
      left: new Int32Array([-1]),
      right: new Int32Array([-1]),
      symbol: new Int32Array([-1]),
      singleton,
    };
  }
  return buildTree(lengths, NP);
}

/**
 * Decompress an LH5-compressed payload into a fresh Uint8Array of length
 * `expectedSize`. Throws if the bitstream is malformed; in well-formed
 * input, the per-block counters consume exactly enough tokens to fill
 * `expectedSize` bytes.
 */
export function decompressLh5(input: Uint8Array, expectedSize: number): Uint8Array {
  if (expectedSize < 0) {
    throw new Error('cawtooth/lh5: expectedSize must be non-negative');
  }
  if (expectedSize === 0) return new Uint8Array(0);

  const reader = new BitReader(input);
  const output = new Uint8Array(expectedSize);
  let pos = 0;
  let blockRemaining = 0;
  let cTree!: HuffTree;
  let pTree!: HuffTree;

  while (pos < expectedSize) {
    if (blockRemaining === 0) {
      blockRemaining = reader.readBits(16);
      if (blockRemaining === 0) {
        throw new Error('cawtooth/lh5: zero-length block before end of stream');
      }
      cTree = readCTable(reader);
      pTree = readPTable(reader);
    }

    const code = decode(reader, cTree);
    blockRemaining--;

    if (code < 256) {
      output[pos++] = code;
    } else {
      const length = code - 253; // token 256 → length 3
      const phigh = decode(reader, pTree);
      const offset = phigh === 0 ? 0 : ((1 << (phigh - 1)) | reader.readBits(phigh - 1)) >>> 0;
      // LZSS back-reference: copy `length` bytes starting at
      // `output[pos - offset - 1]`. Self-overlapping copies (length >
      // offset+1) are legal and how LZSS handles run-length: each write
      // becomes the next read source.
      const copyFrom = pos - offset - 1;
      if (copyFrom < 0 || copyFrom < pos - DICTIONARY_SIZE) {
        throw new Error(
          `cawtooth/lh5: back-reference offset ${offset + 1} out of range at output[${pos}]`,
        );
      }
      const limit = Math.min(length, expectedSize - pos);
      for (let j = 0; j < limit; j++) {
        output[pos] = output[copyFrom + j];
        pos++;
      }
    }
  }

  return output;
}
