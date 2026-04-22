import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parsePsid } from './parser.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Build a minimal valid PSID v2 file in-memory for unit tests. The payload
 * is whatever the caller supplies; fields take sensible defaults.
 */
function buildPsidV2(opts: {
  loadAddressField?: number;
  initAddress?: number;
  playAddress?: number;
  songs?: number;
  startSong?: number;
  speed?: number;
  name?: string;
  author?: string;
  released?: string;
  flags?: number;
  payload: Uint8Array;
}): Uint8Array {
  const header = new Uint8Array(0x7c);
  const view = new DataView(header.buffer);
  header.set([0x50, 0x53, 0x49, 0x44]); // 'PSID'
  view.setUint16(4, 2, false); // version
  view.setUint16(6, 0x7c, false); // dataOffset
  view.setUint16(8, opts.loadAddressField ?? 0x1000, false);
  view.setUint16(10, opts.initAddress ?? 0x1000, false);
  view.setUint16(12, opts.playAddress ?? 0x1003, false);
  view.setUint16(14, opts.songs ?? 1, false);
  view.setUint16(16, opts.startSong ?? 1, false);
  view.setUint32(18, opts.speed ?? 0, false);
  const enc = new TextEncoder();
  const nameBytes = enc.encode(opts.name ?? 'Test');
  header.set(nameBytes.subarray(0, 32), 22);
  const authorBytes = enc.encode(opts.author ?? 'Author');
  header.set(authorBytes.subarray(0, 32), 54);
  const releasedBytes = enc.encode(opts.released ?? '2026');
  header.set(releasedBytes.subarray(0, 32), 86);
  view.setUint16(118, opts.flags ?? 0, false);
  // startPage/pageLength/second/third default to 0

  const out = new Uint8Array(header.length + opts.payload.length);
  out.set(header, 0);
  out.set(opts.payload, header.length);
  return out;
}

describe('parsePsid', () => {
  it('rejects files with unrecognized magic', () => {
    const bad = new Uint8Array(128);
    bad.set([0x42, 0x41, 0x44, 0x21]); // 'BAD!'
    expect(() => parsePsid(bad)).toThrow(/unrecognized magic/);
  });

  it('rejects truncated files', () => {
    expect(() => parsePsid(new Uint8Array(16))).toThrow(/too short/);
  });

  it('rejects unsupported versions', () => {
    const file = buildPsidV2({ payload: new Uint8Array(4) });
    const view = new DataView(file.buffer);
    view.setUint16(4, 7, false); // version = 7, invalid
    expect(() => parsePsid(file)).toThrow(/unsupported version 7/);
  });

  it('parses a minimal v2 file with explicit load address', () => {
    const file = buildPsidV2({
      loadAddressField: 0x2000,
      initAddress: 0x2003,
      playAddress: 0x2010,
      songs: 3,
      startSong: 2,
      speed: 0b101,
      name: 'Hello',
      author: 'Me',
      released: '2026',
      payload: new Uint8Array([1, 2, 3, 4, 5]),
    });
    const song = parsePsid(file);
    expect(song.magic).toBe('PSID');
    expect(song.version).toBe(2);
    expect(song.loadAddress).toBe(0x2000);
    expect(song.initAddress).toBe(0x2003);
    expect(song.playAddress).toBe(0x2010);
    expect(song.songs).toBe(3);
    expect(song.startSong).toBe(2);
    expect(song.speed).toBe(0b101);
    expect(song.name).toBe('Hello');
    expect(song.author).toBe('Me');
    expect(song.released).toBe('2026');
    expect(song.data).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('strips the embedded PRG load address when header loadAddress = 0', () => {
    // PRG-style: first 2 bytes of payload are little-endian load address.
    const payload = new Uint8Array([0x00, 0x10, 0xaa, 0xbb, 0xcc]);
    const file = buildPsidV2({ loadAddressField: 0, payload });
    const song = parsePsid(file);
    expect(song.loadAddress).toBe(0x1000);
    expect(song.data).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
  });

  it('defaults init address to load address when init field is 0', () => {
    const file = buildPsidV2({
      loadAddressField: 0x3000,
      initAddress: 0,
      payload: new Uint8Array(4),
    });
    expect(parsePsid(file).initAddress).toBe(0x3000);
  });

  it('decodes the flags bitfield', () => {
    // bits 2-3 = 01 (PAL), bits 4-5 = 10 (MOS8580)
    const flagsRaw = (0b01 << 2) | (0b10 << 4);
    const file = buildPsidV2({ flags: flagsRaw, payload: new Uint8Array(2) });
    const song = parsePsid(file);
    expect(song.flags.clock).toBe('PAL');
    expect(song.flags.sidModel).toBe('MOS8580');
    expect(song.flags.musPlayer).toBe(false);
    expect(song.flags.psidSpecific).toBe(false);
  });

  it('parses the Batman, the Movie fixture (real PSID v2)', async () => {
    const bytes = new Uint8Array(
      await readFile(resolve(HERE, '../../../../../examples/sid/data/Batman_the_Movie.sid')),
    );
    const song = parsePsid(bytes);
    expect(song.magic).toBe('PSID');
    expect(song.version).toBe(2);
    expect(song.name).toBe('Batman, the Movie');
    expect(song.author).toBe('Matthew Cannon');
    expect(song.released).toBe('1989 Ocean');
    expect(song.songs).toBe(9);
    expect(song.startSong).toBe(1);
    expect(song.initAddress).toBe(0x5165);
    expect(song.playAddress).toBe(0x5171);
    expect(song.speed).toBe(0);
    expect(song.flags.clock).toBe('PAL');
    expect(song.flags.sidModel).toBe('MOS6581');
    // File had loadAddressField=0 with embedded PRG header; resolved to $1000.
    expect(song.loadAddress).toBe(0x1000);
    // Payload data follows 0x7C header + 2 embedded-PRG bytes stripped.
    expect(song.data.length).toBe(bytes.length - 0x7c - 2);
  });
});
