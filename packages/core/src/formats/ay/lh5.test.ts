import { describe, expect, it } from '@jest/globals';
import { decompressLh5 } from './lh5.js';

/**
 * Bit-stream builder. Bits are appended MSB-first; pack into bytes when
 * we've accumulated 8. Tail bits are zero-padded.
 */
class BitWriter {
  private readonly out: number[] = [];
  private buf = 0;
  private bitCount = 0;

  writeBits(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      this.buf = (this.buf << 1) | bit;
      this.bitCount++;
      if (this.bitCount === 8) {
        this.out.push(this.buf & 0xff);
        this.buf = 0;
        this.bitCount = 0;
      }
    }
  }

  toBytes(): Uint8Array {
    if (this.bitCount > 0) {
      this.out.push((this.buf << (8 - this.bitCount)) & 0xff);
    }
    return Uint8Array.from(this.out);
  }
}

/**
 * Build an LH5 block whose c_table and p_table are both singletons.
 * Useful for the "single literal byte" and "single back-reference"
 * test cases — the block decodes to `blockCount` copies of the same
 * c_table symbol (interleaved with offset reads if the symbol is a
 * length token).
 */
function singletonBlock(opts: { blockCount: number; cSym: number; pSym: number }): BitWriter {
  const w = new BitWriter();
  w.writeBits(opts.blockCount, 16);
  // pt_table singleton header: n=0, then 5-bit dummy symbol.
  w.writeBits(0, 5);
  w.writeBits(0, 5);
  // c_table singleton header: n=0, then 9-bit symbol.
  w.writeBits(0, 9);
  w.writeBits(opts.cSym, 9);
  // p_table singleton header: n=0, then 4-bit symbol.
  w.writeBits(0, 4);
  w.writeBits(opts.pSym, 4);
  return w;
}

describe('decompressLh5', () => {
  it('returns an empty array when expectedSize is 0', () => {
    expect(decompressLh5(new Uint8Array(0), 0)).toEqual(new Uint8Array(0));
  });

  it('rejects a negative expectedSize', () => {
    expect(() => decompressLh5(new Uint8Array(0), -1)).toThrow(/non-negative/);
  });

  it('decodes a single literal byte from a singleton-c_table block', () => {
    // c_table singleton = 0x41 ('A'); block emits 1 literal.
    const w = singletonBlock({ blockCount: 1, cSym: 0x41, pSym: 0 });
    const out = decompressLh5(w.toBytes(), 1);
    expect(Array.from(out)).toEqual([0x41]);
  });

  it('decodes multiple literal bytes from a singleton-c_table block', () => {
    // 5 copies of 'Z'.
    const w = singletonBlock({ blockCount: 5, cSym: 0x5a, pSym: 0 });
    const out = decompressLh5(w.toBytes(), 5);
    expect(Array.from(out)).toEqual([0x5a, 0x5a, 0x5a, 0x5a, 0x5a]);
  });

  it('rejects a back-reference whose offset reaches before output start', () => {
    // c_table singleton = 256 (length token, length = 3). p_table
    // singleton = 0, meaning distance = 1 — needs at least one prior
    // byte. With pos = 0 (no literal written yet), copyFrom = -1, which
    // is invalid.
    const w = singletonBlock({ blockCount: 1, cSym: 256, pSym: 0 });
    expect(() => decompressLh5(w.toBytes(), 3)).toThrow(/out of range/);
  });

  it('handles self-overlapping back-references (LZSS run-length)', () => {
    // Build a two-block stream:
    //   block 1: emit one literal 'X'.
    //   block 2: emit a length-3 back-reference at distance 1.
    //            (c_table singleton = 256 → length 3; p_table singleton
    //             = 0 → distance = 1, so copyFrom = pos - 1 = the 'X'
    //             we just wrote)
    // The match overlaps itself — each written byte feeds the next read,
    // producing a run of 3 X's after the initial literal.
    const w = new BitWriter();

    // Block 1: literal 'X'.
    w.writeBits(1, 16);
    w.writeBits(0, 5);
    w.writeBits(0, 5); // pt singleton
    w.writeBits(0, 9);
    w.writeBits(0x58, 9); // c singleton = 'X'
    w.writeBits(0, 4);
    w.writeBits(0, 4); // p singleton

    // Block 2: one length token of 3 bytes, distance 1.
    w.writeBits(1, 16);
    w.writeBits(0, 5);
    w.writeBits(0, 5);
    w.writeBits(0, 9);
    w.writeBits(256, 9); // c singleton = length token (len=3)
    w.writeBits(0, 4);
    w.writeBits(0, 4); // p singleton = 0 → distance = 1

    const out = decompressLh5(w.toBytes(), 4);
    expect(Array.from(out)).toEqual([0x58, 0x58, 0x58, 0x58]);
  });

  it('rejects a stream with a zero-length block before end of output', () => {
    const w = new BitWriter();
    w.writeBits(0, 16); // block count = 0 — illegal
    expect(() => decompressLh5(w.toBytes(), 1)).toThrow(/zero-length block/);
  });

  it('consumes the terminating zero bit on a length-≥7 escape', () => {
    // Regression for a real .ym file that failed with "walked off end of
    // Huffman tree": LHA's bit-length descriptor encodes any length ≥ 7
    // as `"111" + (length - 7)` extra `1` bits + a single `0` terminator,
    // and that terminator is *part of the stream* — a decoder that
    // peeks-and-stops loses 1+ bits of alignment per long entry, so the
    // c_table descriptor that follows reads garbage.
    //
    // We exercise the path with the smallest possible pt_table that
    // contains a length-7 entry, then drop into a singleton c_table whose
    // 9-bit symbol can only line up if the pt descriptor consumed the
    // escape correctly.
    const w = new BitWriter();

    // Block count = 1.
    w.writeBits(1, 16);

    // pt_table descriptor: declare 2 entries.
    //   entry 0 = length 7 → encoded as "111" (=7 in 3 bits) + "0" terminator.
    //   entry 1 = length 1 → encoded as "001" (=1 in 3 bits).
    // No iSpecial skip (i never reaches 3 because n=2 < 3).
    w.writeBits(2, 5);
    w.writeBits(7, 3); // initial 3 bits = 111 (= length 7 escape)
    w.writeBits(0, 1); // terminating zero — this is what the bug missed
    w.writeBits(1, 3); // entry 1 length = 1

    // c_table singleton at 'A' (0x41). Decode of 'A' consumes zero bits,
    // so the block body just emits the symbol once.
    w.writeBits(0, 9);
    w.writeBits(0x41, 9);

    // p_table singleton at 0 (no offsets ever used).
    w.writeBits(0, 4);
    w.writeBits(0, 4);

    const out = decompressLh5(w.toBytes(), 1);
    expect(Array.from(out)).toEqual([0x41]);
  });

  it('decodes a non-singleton c_table built from real canonical Huffman codes', () => {
    // Hand-built block whose c_table has two real entries (literals 'A'
    // and 'B', both length 1 — codes 0 and 1) and whose pt_table is
    // itself non-singleton (symbols 2 and 3 of NT, both length 1).
    // Exercises buildTree on every code path that vendor .vtx/.ym files
    // hit, so a regression in canonical-code assignment shows up here
    // long before integration tests do.
    const w = new BitWriter();

    // Block count = 2 (we'll emit "AB").
    w.writeBits(2, 16);

    // pt_table descriptor: declare 4 entries (N=4 in 5 bits), lengths
    // 0/0/1 for slots 0..2; iSpecial=3 means the 2-bit zero-skip is
    // injected *after* slot 2 (when i has just been bumped to 3); then
    // slot 3 with length 1.
    w.writeBits(4, 5);
    w.writeBits(0, 3);
    w.writeBits(0, 3);
    w.writeBits(1, 3);
    w.writeBits(0, 2);
    w.writeBits(1, 3);

    // c_table descriptor: 67 entries (slots 0..66; everything past the
    // last 'B' literal stays implicit zero).
    w.writeBits(67, 9);
    // Skip the 65 entries before 'A' using pt symbol 2 ("read CBIT bits,
    // skip count + 20 zeros"). With sorted pt codes [sym 2 → bit 0,
    // sym 3 → bit 1], decoding bit '0' produces pt symbol 2.
    w.writeBits(0, 1); // pt symbol 2
    w.writeBits(45, 9); // 45 + 20 = 65 zeros skipped
    // 'A' (slot 65): pt symbol 3 (= bit '1') → c_length = 1.
    w.writeBits(1, 1);
    // 'B' (slot 66): pt symbol 3 → c_length = 1.
    w.writeBits(1, 1);

    // p_table singleton at symbol 0 (no offsets used; we never emit a
    // length token in this block).
    w.writeBits(0, 4);
    w.writeBits(0, 4);

    // Block body: bit '0' → 'A', bit '1' → 'B'.
    w.writeBits(0, 1);
    w.writeBits(1, 1);

    const out = decompressLh5(w.toBytes(), 2);
    expect(Array.from(out)).toEqual([0x41, 0x42]);
  });
});
