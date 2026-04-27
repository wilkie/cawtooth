import { describe, expect, it } from '@jest/globals';
import { parseVtx } from './vtx.js';

/**
 * Pack arbitrary bits MSB-first into a byte array. Mirrors the helper in
 * lh5.test.ts; duplicated here so the two test files don't depend on each
 * other.
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
 * Encode `bytes` as a chain of one-byte LH5 blocks, each block using a
 * singleton c_table whose only symbol is the byte's value. This is the
 * least-efficient possible compression — every byte costs 52 bits of
 * frame overhead — but it's trivial to construct without porting the
 * full LHA encoder, and the decoder treats it identically to a real
 * compressed payload.
 */
function lh5SingletonStream(bytes: readonly number[]): Uint8Array {
  const w = new BitWriter();
  for (const b of bytes) {
    w.writeBits(1, 16); // block count = 1
    w.writeBits(0, 5);
    w.writeBits(0, 5); // pt singleton (irrelevant)
    w.writeBits(0, 9);
    w.writeBits(b, 9); // c singleton = b
    w.writeBits(0, 4);
    w.writeBits(0, 4); // p singleton (irrelevant)
  }
  return w.toBytes();
}

interface VtxFixture {
  magic?: 'ay' | 'ym';
  layout?: number;
  loopFrame?: number;
  clockFrequency?: number;
  intFreq?: number;
  year?: number;
  payloadFrames: number; // = numFrames; payload size = 14 * numFrames
  /** Sparse map: payload[k * frames + i] = value. */
  writes?: Record<string, number>; // key "reg:frame"
  title?: string;
  author?: string;
  program?: string;
  tracker?: string;
  comment?: string;
}

/** Build a syntactically-correct VTX file from a fixture description. */
function buildVtx(fx: VtxFixture): Uint8Array {
  const numFrames = fx.payloadFrames;
  const unpackedSize = 14 * numFrames;
  const payload = new Uint8Array(unpackedSize);
  for (const key in fx.writes ?? {}) {
    const [regS, frameS] = key.split(':');
    const reg = Number(regS);
    const frame = Number(frameS);
    payload[reg * numFrames + frame] = fx.writes![key];
  }

  const compressed = lh5SingletonStream(Array.from(payload));

  // Header (16 bytes) + 5 null-terminated strings + compressed.
  const enc = new TextEncoder();
  const titleBytes = enc.encode(fx.title ?? '');
  const authorBytes = enc.encode(fx.author ?? '');
  const programBytes = enc.encode(fx.program ?? '');
  const trackerBytes = enc.encode(fx.tracker ?? '');
  const commentBytes = enc.encode(fx.comment ?? '');
  const stringsLen =
    titleBytes.length +
    authorBytes.length +
    programBytes.length +
    trackerBytes.length +
    commentBytes.length +
    5;

  const out = new Uint8Array(16 + stringsLen + compressed.length);
  const dv = new DataView(out.buffer);
  const magic = fx.magic ?? 'ay';
  out[0] = magic.charCodeAt(0);
  out[1] = magic.charCodeAt(1);
  out[2] = fx.layout ?? 1; // ABC stereo
  dv.setUint16(3, fx.loopFrame ?? 0, true);
  dv.setUint32(5, fx.clockFrequency ?? 1773400, true);
  out[9] = fx.intFreq ?? 50;
  dv.setUint16(10, fx.year ?? 0, true);
  dv.setUint32(12, unpackedSize, true);

  let pos = 16;
  for (const s of [titleBytes, authorBytes, programBytes, trackerBytes, commentBytes]) {
    out.set(s, pos);
    pos += s.length;
    out[pos++] = 0;
  }
  out.set(compressed, pos);
  return out;
}

describe('parseVtx', () => {
  it('rejects a file shorter than the 16-byte header', () => {
    expect(() => parseVtx(new Uint8Array(8))).toThrow(/too short/);
  });

  it('rejects a file with a non-AY/YM magic', () => {
    const fx = buildVtx({ payloadFrames: 1, writes: { '0:0': 1 } });
    fx[0] = 0x42; // 'B'
    expect(() => parseVtx(fx)).toThrow(/not a VTX file/);
  });

  it('classifies "ay" magic as AY-3-8910 and "ym" as YM2149', () => {
    const ay = parseVtx(buildVtx({ magic: 'ay', payloadFrames: 1, writes: { '0:0': 1 } }));
    const ym = parseVtx(buildVtx({ magic: 'ym', payloadFrames: 1, writes: { '0:0': 1 } }));
    expect(ay.model).toBe('AY-3-8910');
    expect(ay.variant).toBe('ay');
    expect(ym.model).toBe('YM2149');
    expect(ym.variant).toBe('ym');
  });

  it('reads chip clock and tick rate from the header verbatim', () => {
    const song = parseVtx(
      buildVtx({
        clockFrequency: 1789773, // MSX
        intFreq: 60, // NTSC
        payloadFrames: 1,
        writes: { '0:0': 1 },
      }),
    );
    expect(song.clockFrequency).toBe(1789773);
    expect(song.tickRate).toBe(60);
  });

  it('reads the five metadata strings in order', () => {
    const song = parseVtx(
      buildVtx({
        title: 'Song Title',
        author: 'Author Name',
        program: 'Vortex',
        tracker: 'VT2',
        comment: 'Made with love',
        payloadFrames: 1,
        writes: { '0:0': 1 },
      }),
    );
    expect(song.title).toBe('Song Title');
    expect(song.author).toBe('Author Name');
    expect(song.comment).toBe('Made with love');
  });

  it('emits one event per (reg, frame) for changed registers only', () => {
    // Frame 0: reg 0 = 10, reg 7 = 20.
    // Frame 1: identical to frame 0 (no changes).
    // Frame 2: reg 0 changes to 30.
    const song = parseVtx(
      buildVtx({
        payloadFrames: 3,
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
    // After frame 0's two events, frame 1 has no writes (pendingDelay=2
    // before the next event), then frame 2's reg-0 event lands. Tail is
    // 1 frame after the final write.
    expect(Array.from(song.stream.delayTicks)).toEqual([0, 2, 1]);
  });

  it('accumulates trailing silent frames into the last event', () => {
    // Reg 0 = 5 sustained across all 6 frames. Only one event is emitted
    // (frame 0); the remaining 5 frames are pure silence and roll up
    // into the final event's tail along with the 1-frame pending delay
    // from frame 0 itself = 6 ticks total.
    const song = parseVtx(
      buildVtx({
        payloadFrames: 6,
        writes: { '0:0': 5, '0:1': 5, '0:2': 5, '0:3': 5, '0:4': 5, '0:5': 5 },
      }),
    );
    expect(Array.from(song.stream.regs)).toEqual([0]);
    expect(Array.from(song.stream.delayTicks)).toEqual([6]);
  });

  it('rejects a file whose decompressed payload size is not a multiple of 14', () => {
    // Build a fixture with the wrong unpacked size declared.
    const fx = buildVtx({ payloadFrames: 1, writes: { '0:0': 1 } });
    const dv = new DataView(fx.buffer);
    dv.setUint32(12, 13, true); // declared size 13 ≠ multiple of 14
    expect(() => parseVtx(fx)).toThrow(/not a multiple of 14/);
  });

  it('rejects a payload that contains no register changes', () => {
    expect(() => parseVtx(buildVtx({ payloadFrames: 4 }))).toThrow(/no register changes/);
  });

  it('flags the song as loopable (VTX always carries a loop point)', () => {
    const song = parseVtx(buildVtx({ payloadFrames: 1, writes: { '0:0': 1 } }));
    expect(song.loop).toBe(true);
  });
});
