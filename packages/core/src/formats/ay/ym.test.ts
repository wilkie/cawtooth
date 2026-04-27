import { describe, expect, it } from '@jest/globals';
import { parseYm } from './ym.js';

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

/** Same singleton-LH5 helper as the other AY format tests. */
function lh5SingletonStream(bytes: readonly number[]): Uint8Array {
  const w = new BitWriter();
  for (const b of bytes) {
    w.writeBits(1, 16);
    w.writeBits(0, 5);
    w.writeBits(0, 5);
    w.writeBits(0, 9);
    w.writeBits(b, 9);
    w.writeBits(0, 4);
    w.writeBits(0, 4);
  }
  return w.toBytes();
}

interface YmFixture {
  variant?: 'YM5!' | 'YM6!';
  numFrames: number;
  attributes?: number; // default: 1 (interleaved)
  tickRate?: number; // default: 50
  clockFrequency?: number; // default: 2000000 (Atari ST)
  loopFrame?: number;
  title?: string;
  author?: string;
  comment?: string;
  /** Sparse `"reg:frame"` → value. Defaults to 0 elsewhere. */
  writes?: Record<string, number>;
  /** Wrap the inner payload in an LHA "-lh5-" level-0 header. */
  wrap?: boolean;
}

function buildYmInner(fx: YmFixture): Uint8Array {
  const numFrames = fx.numFrames;
  const interleaved = (fx.attributes ?? 1) & 0x01;

  const enc = new TextEncoder();
  const titleB = enc.encode(fx.title ?? '');
  const authorB = enc.encode(fx.author ?? '');
  const commentB = enc.encode(fx.comment ?? '');

  const regBytes = new Uint8Array(numFrames * 16);
  for (const key in fx.writes ?? {}) {
    const [regS, frameS] = key.split(':');
    const reg = Number(regS);
    const frame = Number(frameS);
    if (interleaved) {
      regBytes[reg * numFrames + frame] = fx.writes![key];
    } else {
      regBytes[frame * 16 + reg] = fx.writes![key];
    }
  }

  const trail = enc.encode('End!');
  const headerSize =
    34 + // fixed header
    titleB.length +
    1 +
    authorB.length +
    1 +
    commentB.length +
    1;
  const total = headerSize + regBytes.length + trail.length;

  const out = new Uint8Array(total);
  out.set(enc.encode(fx.variant ?? 'YM5!'), 0);
  out.set(enc.encode('LeOnArD!'), 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(12, numFrames, false);
  dv.setUint32(16, fx.attributes ?? 1, false);
  dv.setUint16(20, 0, false); // 0 digidrums
  dv.setUint32(22, fx.clockFrequency ?? 2000000, false);
  dv.setUint16(26, fx.tickRate ?? 50, false);
  dv.setUint32(28, fx.loopFrame ?? 0, false);
  dv.setUint16(32, 0, false); // 0 extra info bytes

  let pos = 34;
  out.set(titleB, pos);
  pos += titleB.length;
  out[pos++] = 0;
  out.set(authorB, pos);
  pos += authorB.length;
  out[pos++] = 0;
  out.set(commentB, pos);
  pos += commentB.length;
  out[pos++] = 0;
  out.set(regBytes, pos);
  pos += regBytes.length;
  out.set(trail, pos);
  return out;
}

/** Wrap an inner YM payload in an LHA level-0 "-lh5-" header. */
function buildLhaWrapper(inner: Uint8Array): Uint8Array {
  const compressed = lh5SingletonStream(Array.from(inner));
  const enc = new TextEncoder();
  const filename = enc.encode('test.ym');
  // Level-0 header: byte 0 = headerSize (excludes itself + checksum byte),
  // byte 1 = checksum, then 5-byte method, then sizes/dates/etc.
  // Compute headerSize: from byte 2 to end of header. Layout:
  //   2..6:   "-lh5-"
  //   7..10:  compressedSize (LE u32)
  //   11..14: uncompressedSize (LE u32)
  //   15..18: timestamp
  //   19:     attribute
  //   20:     level (0)
  //   21:     filenameLen
  //   22..21+F: filename
  //   22+F..23+F: file CRC
  // Total header bytes from position 2: 5 + 4 + 4 + 4 + 1 + 1 + 1 + F + 2 = 22 + F
  const F = filename.length;
  const headerBodySize = 22 + F;
  const out = new Uint8Array(2 + headerBodySize + compressed.length);
  out[0] = headerBodySize;
  out[1] = 0; // skip checksum (parser tolerates this)
  out.set(enc.encode('-lh5-'), 2);
  const dv = new DataView(out.buffer);
  dv.setUint32(7, compressed.length, true);
  dv.setUint32(11, inner.length, true);
  dv.setUint32(15, 0, true); // timestamp
  out[19] = 0x20; // file attribute
  out[20] = 0; // level 0
  out[21] = F;
  out.set(filename, 22);
  // CRC bytes 22+F..23+F left as zero
  out.set(compressed, 2 + headerBodySize);
  return out;
}

function buildYm(fx: YmFixture): Uint8Array {
  const inner = buildYmInner(fx);
  return fx.wrap ? buildLhaWrapper(inner) : inner;
}

describe('parseYm', () => {
  it('rejects a file too short to identify variant', () => {
    expect(() => parseYm(new Uint8Array(2))).toThrow(/too short to identify/);
  });

  it('rejects an inner payload with the wrong magic', () => {
    const fx = buildYm({ numFrames: 1, writes: { '0:0': 1 } });
    fx[0] = 0x42; // 'B'
    expect(() => parseYm(fx)).toThrow(/unsupported variant/);
  });

  it('rejects an inner payload missing the "LeOnArD!" check string', () => {
    const fx = buildYm({ numFrames: 1, writes: { '0:0': 1 } });
    fx[5] = 0x00; // corrupt the 'e' of "LeOnArD!"
    expect(() => parseYm(fx)).toThrow(/check string/);
  });

  it('reads tick rate, clock, and frame count from the inner header', () => {
    const song = parseYm(
      buildYm({
        numFrames: 4,
        clockFrequency: 1773400,
        tickRate: 60,
        writes: { '0:0': 0xaa },
      }),
    );
    expect(song.clockFrequency).toBe(1773400);
    expect(song.tickRate).toBe(60);
  });

  it('classifies YM5! and YM6! variants by their inner magic', () => {
    const ym5 = parseYm(buildYm({ variant: 'YM5!', numFrames: 1, writes: { '0:0': 1 } }));
    const ym6 = parseYm(buildYm({ variant: 'YM6!', numFrames: 1, writes: { '0:0': 1 } }));
    expect(ym5.variant).toBe('YM5');
    expect(ym6.variant).toBe('YM6');
    expect(ym5.model).toBe('YM2149');
  });

  it('reads the three metadata strings in order', () => {
    const song = parseYm(
      buildYm({
        title: 'Tune',
        author: 'Coder',
        comment: 'Test',
        numFrames: 1,
        writes: { '0:0': 1 },
      }),
    );
    expect(song.title).toBe('Tune');
    expect(song.author).toBe('Coder');
    expect(song.comment).toBe('Test');
  });

  it('emits change-only events for interleaved YM5 storage', () => {
    // Frame 0: reg 0 = 10, reg 7 = 20.
    // Frame 1: reg 0 unchanged, reg 7 unchanged.
    // Frame 2: reg 0 → 30.
    const song = parseYm(
      buildYm({
        numFrames: 3,
        writes: {
          '0:0': 10,
          '0:1': 10,
          '0:2': 30,
          '7:0': 20,
          '7:1': 20,
          '7:2': 20,
        },
      }),
    );
    expect(Array.from(song.stream.regs)).toEqual([0, 7, 0]);
    expect(Array.from(song.stream.values)).toEqual([10, 20, 30]);
    expect(Array.from(song.stream.delayTicks)).toEqual([0, 2, 1]);
  });

  it('handles frame-major storage when the interleaved attribute bit is clear', () => {
    const song = parseYm(
      buildYm({
        attributes: 0,
        numFrames: 2,
        writes: { '0:0': 10, '0:1': 20 },
      }),
    );
    expect(Array.from(song.stream.regs)).toEqual([0, 0]);
    expect(Array.from(song.stream.values)).toEqual([10, 20]);
  });

  it('ignores R14 and R15 (I/O ports / digidrum control)', () => {
    // Set R15 to a non-zero value across frames — should NOT appear in
    // the event stream since AyumiChip never models I/O ports.
    const song = parseYm(
      buildYm({
        numFrames: 2,
        writes: { '0:0': 5, '0:1': 5, '15:0': 0xff, '15:1': 0xff },
      }),
    );
    expect(Array.from(song.stream.regs)).toEqual([0]);
    expect(Array.from(song.stream.values)).toEqual([5]);
  });

  it('rejects a payload with no register changes', () => {
    expect(() => parseYm(buildYm({ numFrames: 4 }))).toThrow(/no register changes/);
  });

  it('decompresses an LHA-wrapped inner payload transparently', () => {
    const song = parseYm(
      buildYm({
        wrap: true,
        numFrames: 2,
        writes: { '0:0': 10, '0:1': 20 },
      }),
    );
    expect(Array.from(song.stream.regs)).toEqual([0, 0]);
    expect(Array.from(song.stream.values)).toEqual([10, 20]);
  });
});
