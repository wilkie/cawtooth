import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { parseSndh } from './parser.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('parseSndh', () => {
  it('parses Jupiter_Probe.sndh metadata', async () => {
    const path = resolve(HERE, '../../../../../examples/ay/data/Jupiter_Probe.sndh');
    const bytes = new Uint8Array(await readFile(path));

    const song = parseSndh(bytes);

    expect(song.title).toBe('Jupiter Probe');
    expect(song.composer).toBe('Rob Hubbard');
    expect(song.ripper).toBe('Abyss');
    expect(song.converter).toBe('Grazey');
    expect(song.year).toBe('1987');

    // Standard MFP Timer C @ 50 Hz cadence — every Atari ST chiptune
    // ripper uses this unless the original tune drove a different timer.
    expect(song.timer).toEqual({ type: 'C', frequencyHz: 50 });

    // No `##` / `!#` / `!#SN` tag in this file — defaults to one subsong.
    expect(song.subsongCount).toBe(1);
    expect(song.defaultSubsong).toBe(1);

    expect(song.flags).toBe('~y');

    // BRA.W displacements at offsets 0/4/8 land at the m68k entry points.
    // For Jupiter_Probe.sndh: init=0x6A, exit=0x7C, play=0x7E.
    expect(song.initAddress).toBe(0x6a);
    expect(song.exitAddress).toBe(0x7c);
    expect(song.playAddress).toBe(0x7e);

    // The whole file is surfaced verbatim; the WASM loader maps it into
    // simulated RAM so Musashi can resolve the BRA targets at runtime.
    expect(song.binary).toBe(bytes);
    expect(song.binary.byteLength).toBe(bytes.byteLength);
  });

  it('rejects files smaller than the header', () => {
    expect(() => parseSndh(new Uint8Array(8))).toThrow(/too short/);
  });

  it('rejects files missing the SNDH magic', () => {
    const buf = new Uint8Array(0x20);
    // Three valid BRA.W stubs so we get past the entry-point reads.
    buf.set([0x60, 0x00, 0x00, 0x10, 0x60, 0x00, 0x00, 0x10, 0x60, 0x00, 0x00, 0x10]);
    // Anything that isn't 'SNDH' at offset 0x0C.
    buf.set([0x4d, 0x55, 0x53, 0x48], 0x0c); // 'MUSH'
    expect(() => parseSndh(buf)).toThrow(/SNDH magic/);
  });

  it('rejects files where the entry-point branches are not BRA.W', () => {
    const buf = new Uint8Array(0x20);
    // First instruction is JMP (0x4E F9 ...) instead of BRA.W.
    buf.set([0x4e, 0xf9, 0x00, 0x00], 0);
    buf.set([0x60, 0x00, 0x00, 0x10], 4);
    buf.set([0x60, 0x00, 0x00, 0x10], 8);
    buf.set([0x53, 0x4e, 0x44, 0x48], 0x0c); // 'SNDH'
    expect(() => parseSndh(buf)).toThrow(/BRA\.W/);
  });

  it('parses a synthetic file with !#SN, ##, TIME and FRMS', () => {
    // Build a synthetic SNDH where:
    //   subsong count = 3 via `##03`
    //   TIME = [120, 90, 200] seconds (BE u16)
    //   default Timer A @ 200 Hz
    const meta = [
      // BRAs to a stub at 0x40
      0x60, 0x00, 0x00, 0x3c, // init -> 0x40
      0x60, 0x00, 0x00, 0x3c, // exit -> 0x44 (we'll just terminate at 0x40 with RTS)
      0x60, 0x00, 0x00, 0x3c, // play -> 0x48
      // Magic
      0x53, 0x4e, 0x44, 0x48, // 'SNDH' @ 0x0C
      // ##03
      0x23, 0x23, 0x30, 0x33,
      // TA200\0
      0x54, 0x41, 0x32, 0x30, 0x30, 0x00,
      // TIME: 3 * BE u16
      0x54, 0x49, 0x4d, 0x45,
      0x00, 0x78, // 120
      0x00, 0x5a, // 90
      0x00, 0xc8, // 200
      // HDNS
      0x48, 0x44, 0x4e, 0x53,
    ];
    const buf = new Uint8Array(meta);

    const song = parseSndh(buf);
    expect(song.subsongCount).toBe(3);
    expect(song.timer).toEqual({ type: 'A', frequencyHz: 200 });
    expect(song.durations).toEqual([120, 90, 200]);
    expect(song.title).toBe('');
    expect(song.flags).toBe('');
  });

  it('treats a bare `!V` tag as VBL @ 50 Hz', () => {
    // SNDH convention: `!V` with no trailing digits means "use vertical
    // blank interrupt", which on PAL Atari ST is 50 Hz. Our parser used
    // to drop the tag entirely (frequency parsed to NaN) — verify it now
    // installs the correct default.
    const meta = [
      0x60, 0x00, 0x00, 0x18, 0x60, 0x00, 0x00, 0x18, 0x60, 0x00, 0x00, 0x18,
      0x53, 0x4e, 0x44, 0x48, // 'SNDH'
      0x21, 0x56, 0x00,       // '!V\0'  (bare, no frequency)
      0x48, 0x44, 0x4e, 0x53, // 'HDNS'
    ];
    const song = parseSndh(new Uint8Array(meta));
    expect(song.timer).toEqual({ type: 'V', frequencyHz: 50 });
  });

  it('still honours `!V60` for an NTSC-style explicit VBL frequency', () => {
    const meta = [
      0x60, 0x00, 0x00, 0x1a, 0x60, 0x00, 0x00, 0x1a, 0x60, 0x00, 0x00, 0x1a,
      0x53, 0x4e, 0x44, 0x48, // 'SNDH'
      0x21, 0x56, 0x36, 0x30, 0x00, // '!V60\0'
      0x48, 0x44, 0x4e, 0x53, // 'HDNS'
    ];
    const song = parseSndh(new Uint8Array(meta));
    expect(song.timer).toEqual({ type: 'V', frequencyHz: 60 });
  });
});
