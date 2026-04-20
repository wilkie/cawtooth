import { parseDro } from './parser.js';

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const MAGIC = new Uint8Array([0x44, 0x42, 0x52, 0x41, 0x57, 0x4f, 0x50, 0x4c]);

function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

function u16le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

/**
 * Build a valid DRO v2 file.
 *
 * v2 layout:
 *   [0..8)   magic
 *   [8]      version major (= 2, u8)
 *   [9]      version minor (= 0, u8)
 *   [10..14) lengthPairs (u32 LE)
 *   [14..18) lengthMS (u32 LE)
 *   [18]     hardware (u8)
 *   [19]     format (u8, = 0)
 *   [20]     compression (u8, = 0)
 *   [21]     shortDelayCode
 *   [22]     longDelayCode
 *   [23]     codemapLength
 *   [24..24+N) codemap
 *   [24+N..) data pairs
 */
function buildV2(options: {
  pairs: Array<readonly [number, number]>;
  shortDelayCode: number;
  longDelayCode: number;
  codemap: number[];
  durationMs?: number;
  hardware?: number;
  format?: number;
  compression?: number;
}): Uint8Array {
  const codemap = new Uint8Array(options.codemap);
  const dataBytes = new Uint8Array(options.pairs.length * 2);
  options.pairs.forEach(([cmd, val], i) => {
    dataBytes[i * 2] = cmd;
    dataBytes[i * 2 + 1] = val;
  });
  return concat(
    MAGIC,
    new Uint8Array([2, 0]), // version major, minor (u8 each)
    u32le(options.pairs.length),
    u32le(options.durationMs ?? 0),
    new Uint8Array([
      options.hardware ?? 0,
      options.format ?? 0,
      options.compression ?? 0,
      options.shortDelayCode,
      options.longDelayCode,
      codemap.length,
    ]),
    codemap,
    dataBytes,
  );
}

/**
 * Build a valid DRO v1 file.
 *
 * v1 layout (24-byte header, data at offset 24):
 *   [0..8)   magic
 *   [8..10)  version major (= 0, u16 LE)
 *   [10..12) version minor (= 0 or 1, u16 LE)
 *   [12..16) lengthMS (u32 LE)
 *   [16..20) lengthBytes (u32 LE)
 *   [20]     hardware (u8)
 *   [21..24) three zero bytes (iFormat / iCompression / iReserved)
 *   [24..)   data
 */
function buildV1(options: {
  data: Uint8Array;
  versionMinor?: number;
  durationMs?: number;
  hardware?: number;
}): Uint8Array {
  return concat(
    MAGIC,
    u16le(0), // version major
    u16le(options.versionMinor ?? 1), // version minor (1 is what Adplug expects)
    u32le(options.durationMs ?? 0),
    u32le(options.data.length),
    new Uint8Array([options.hardware ?? 0, 0, 0, 0]),
    options.data,
  );
}

describe('parseDro v2', () => {
  it('parses a simple two-register sequence with short delays', () => {
    const bytes = buildV2({
      shortDelayCode: 0xfe,
      longDelayCode: 0xff,
      codemap: [0x20, 0x40],
      pairs: [
        [0, 0x01],
        [0xfe, 49], // 50 ms
        [1, 0x10],
      ],
    });

    const song = parseDro(bytes);

    expect(song.variant).toBe('v2');
    expect(song.tickRate).toBe(1000);
    expect(Array.from(song.stream.regs)).toEqual([0x20, 0x40]);
    expect(Array.from(song.stream.values)).toEqual([0x01, 0x10]);
    expect(Array.from(song.stream.delayTicks)).toEqual([50, 0]);
  });

  it('maps a long delay code to (val + 1) * 256 ms', () => {
    const bytes = buildV2({
      shortDelayCode: 0xfe,
      longDelayCode: 0xff,
      codemap: [0x20],
      pairs: [
        [0, 0x01],
        [0xff, 3], // (3 + 1) * 256 = 1024 ms
        [0, 0x02],
      ],
    });

    expect(Array.from(parseDro(bytes).stream.delayTicks)).toEqual([1024, 0]);
  });

  it('routes high-bit cmds to the OPL3 upper bank (reg | 0x100)', () => {
    const bytes = buildV2({
      shortDelayCode: 0xfe,
      longDelayCode: 0xff,
      codemap: [0x05],
      pairs: [[0x80, 0x01]],
    });

    const song = parseDro(bytes);
    expect(song.stream.regs[0]).toBe(0x105);
    expect(song.stream.values[0]).toBe(0x01);
  });

  it('encodes a leading delay as a synthetic reg=0 silence event', () => {
    const bytes = buildV2({
      shortDelayCode: 0xfe,
      longDelayCode: 0xff,
      codemap: [0x20],
      pairs: [
        [0xfe, 99], // 100 ms lead-in
        [0, 0x01],
      ],
    });

    const song = parseDro(bytes);
    expect(Array.from(song.stream.regs)).toEqual([0, 0x20]);
    expect(Array.from(song.stream.delayTicks)).toEqual([100, 0]);
  });

  it('captures trailing delay on the final event', () => {
    const bytes = buildV2({
      shortDelayCode: 0xfe,
      longDelayCode: 0xff,
      codemap: [0x20],
      pairs: [
        [0, 0x01],
        [0xfe, 249], // 250 ms trailing
      ],
    });

    expect(Array.from(parseDro(bytes).stream.delayTicks)).toEqual([250]);
  });

  it('reports hardware code 2 as opl3 in v2', () => {
    const bytes = buildV2({
      shortDelayCode: 0xfe,
      longDelayCode: 0xff,
      codemap: [0x20],
      pairs: [[0, 0x01]],
      hardware: 2,
    });
    expect(parseDro(bytes).hardware).toBe('opl3');
  });

  it('rejects a missing magic', () => {
    const bogus = new Uint8Array(32);
    expect(() => parseDro(bogus)).toThrow(/magic/);
  });

  it('rejects an unsupported compression', () => {
    const bytes = buildV2({
      shortDelayCode: 0xfe,
      longDelayCode: 0xff,
      codemap: [0x20],
      pairs: [[0, 0x01]],
      compression: 1,
    });
    expect(() => parseDro(bytes)).toThrow(/compression/);
  });

  it('rejects a codemap index that overruns the codemap', () => {
    const bytes = buildV2({
      shortDelayCode: 0xfe,
      longDelayCode: 0xff,
      codemap: [0x20],
      pairs: [[5, 0x01]],
    });
    expect(() => parseDro(bytes)).toThrow(/codemap index/);
  });
});

describe('parseDro v1', () => {
  it('accepts version-minor 0 and version-minor 1 (both in the wild)', () => {
    const data = new Uint8Array([0x20, 0x01]); // reg 0x20 = 0x01
    const v00 = buildV1({ data, versionMinor: 0 });
    const v01 = buildV1({ data, versionMinor: 1 });
    expect(parseDro(v00).variant).toBe('v1');
    expect(parseDro(v01).variant).toBe('v1');
  });

  it('parses delays and direct register writes', () => {
    const bytes = buildV1({
      data: new Uint8Array([
        0x00,
        49, // short delay: 50 ms
        0x20,
        0x01, // write reg 0x20 = 0x01
        0x00,
        99, // short delay: 100 ms
        0x40,
        0x10, // write reg 0x40 = 0x10
      ]),
    });

    const song = parseDro(bytes);
    expect(song.variant).toBe('v1');
    expect(song.tickRate).toBe(1000);
    expect(Array.from(song.stream.regs)).toEqual([0, 0x20, 0x40]);
    expect(Array.from(song.stream.values)).toEqual([0, 0x01, 0x10]);
    expect(Array.from(song.stream.delayTicks)).toEqual([50, 100, 0]);
  });

  it('handles the escape opcode for registers 0x00–0x04', () => {
    const bytes = buildV1({
      data: new Uint8Array([0x04, 0x01, 0xaa]),
    });
    const song = parseDro(bytes);
    expect(Array.from(song.stream.regs)).toEqual([0x01]);
    expect(Array.from(song.stream.values)).toEqual([0xaa]);
  });

  it('applies the OPL3 upper-bank flag after opcode 0x03', () => {
    const bytes = buildV1({
      data: new Uint8Array([
        0x03, // switch high
        0x05,
        0x01, // reg 0x105 = 0x01
        0x02, // switch low
        0x20,
        0x01, // reg 0x020 = 0x01
      ]),
    });
    expect(Array.from(parseDro(bytes).stream.regs)).toEqual([0x105, 0x020]);
  });

  it('decodes a long delay as (u16 + 1) ms', () => {
    const bytes = buildV1({
      data: new Uint8Array([
        0x01,
        0xe7,
        0x03, // 0x03E7 + 1 = 1000 ms
        0x20,
        0x01,
      ]),
    });
    expect(Array.from(parseDro(bytes).stream.delayTicks)).toEqual([1000, 0]);
  });

  it('reads durationMs and lengthBytes from the correct header offsets', () => {
    const bytes = buildV1({
      data: new Uint8Array([0x20, 0x01]),
      durationMs: 12345,
    });
    const song = parseDro(bytes);
    expect(song.durationMs).toBe(12345);
    expect(song.stream.regs.length).toBeGreaterThan(0);
  });

  it('reports hardware code 1 as opl3 in v1 (legacy ordering)', () => {
    const bytes = buildV1({
      data: new Uint8Array([0x20, 0x01]),
      hardware: 1,
    });
    expect(parseDro(bytes).hardware).toBe('opl3');
  });
});
