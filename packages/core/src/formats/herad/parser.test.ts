import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseDecompressedHerad, parseHerad } from './parser.js';
import { HERAD_INST_SIZE, HERAD_INSTMODE } from './types.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a minimal valid decompressed HERAD payload:
 *   - 1 track with the given event bytes
 *   - 1 SDB1 patch (40 bytes, all zero except mode=0)
 *   - Header with loop/speed fields we can assert on
 */
function buildMinimal(options: {
  trackData?: Uint8Array;
  speed?: number;
  loopStart?: number;
  loopEnd?: number;
  loopCount?: number;
}): Uint8Array {
  const trackData = options.trackData ?? new Uint8Array([0x90, 0x00]); // 2 bytes of events
  const speed = options.speed ?? 0x0100;

  // Layout:
  //   [0..2]     instOffset
  //   [2..4]     track 0 offset (=0x32)
  //   [4..6]     0 (terminator)
  //   [6..0x2C]  unused (zero)
  //   [0x2C..34] loopStart, loopEnd, loopCount, speed
  //   [0x34..]   track data
  //   [instOffset..] instrument (40 bytes, mode=0)
  const trackStart = 0x34;
  const trackEnd = trackStart + trackData.length;
  const instOffset = trackEnd; // one inst immediately after track data
  const total = instOffset + HERAD_INST_SIZE;

  const out = new Uint8Array(total);
  const writeU16 = (at: number, v: number) => {
    out[at] = v & 0xff;
    out[at + 1] = (v >> 8) & 0xff;
  };
  writeU16(0, instOffset);
  writeU16(2, 0x32); // track 0 offset value
  writeU16(4, 0); // terminator
  writeU16(0x2c, options.loopStart ?? 0);
  writeU16(0x2e, options.loopEnd ?? 0);
  writeU16(0x30, options.loopCount ?? 0);
  writeU16(0x32, speed);
  out.set(trackData, trackStart);
  // Instrument at instOffset: mode=0, voice=0, rest zero. Valid SDB1 patch.
  return out;
}

describe('parseHerad (decompressed)', () => {
  it('parses a minimal hand-crafted file', () => {
    const bytes = buildMinimal({
      trackData: new Uint8Array([0x10, 0x20, 0x30, 0x40]),
      speed: 0x0200,
      loopStart: 1,
      loopEnd: 4,
      loopCount: 2,
    });

    const song = parseDecompressedHerad(bytes);

    expect(song.variant).toBe('v1');
    expect(song.isAgd).toBe(false);
    expect(song.speed).toBe(0x0200);
    expect(song.loopStart).toBe(1);
    expect(song.loopEnd).toBe(4);
    expect(song.loopCount).toBe(2);
    expect(song.tracks).toHaveLength(1);
    expect(Array.from(song.tracks[0])).toEqual([0x10, 0x20, 0x30, 0x40]);
    expect(song.instruments).toHaveLength(1);
    expect(song.instruments[0].kind).toBe('patch');
  });

  it('rejects a file whose first track offset is neither 0x32 nor 0x52', () => {
    const bytes = buildMinimal({});
    bytes[2] = 0x20; // corrupt first track offset
    expect(() => parseDecompressedHerad(bytes)).toThrow(/first track offset/);
  });

  it('rejects a file with wSpeed = 0', () => {
    const bytes = buildMinimal({ speed: 0 });
    expect(() => parseDecompressedHerad(bytes)).toThrow(/wSpeed/);
  });

  it('silently drops trailing bytes past the last full instrument block', () => {
    // AdPlug matches this behaviour — real .sdb files occasionally have
    // padding. A single trailing byte should leave the instrument count
    // unchanged, not throw.
    const bytes = buildMinimal({});
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes, 0);
    const song = parseDecompressedHerad(padded);
    expect(song.instruments).toHaveLength(1);
  });

  it('rejects a file whose bank is shorter than one instrument', () => {
    // Truncate so the bank isn't even 40 bytes — no instruments at all.
    const bytes = buildMinimal({});
    const truncated = bytes.subarray(0, bytes.length - 3);
    expect(() => parseDecompressedHerad(truncated)).toThrow(/too small/);
  });

  it('allows the caller to force a variant', () => {
    const bytes = buildMinimal({});
    const song = parseDecompressedHerad(bytes, { variant: 'v2' });
    expect(song.variant).toBe('v2');
  });

  it('auto-detects v2 when any instrument is a keymap', () => {
    // Build a minimal file with 2 instruments, second one keymap.
    const base = buildMinimal({});
    const withKeymap = new Uint8Array(base.length + HERAD_INST_SIZE);
    withKeymap.set(base, 0);
    // Insert keymap at the tail.
    const offset = base.length;
    withKeymap[offset] = HERAD_INSTMODE.KEYMAP; // mode = 0xFF
    withKeymap[offset + 1] = 5; // voice
    withKeymap[offset + 2] = 24; // noteOffset → C4
    // Fill indices with sentinel values.
    for (let i = 0; i < HERAD_INST_SIZE - 4; i++) {
      withKeymap[offset + 4 + i] = i;
    }
    // instOffset stays the same (start of bank); bank now has 2 entries.
    const song = parseDecompressedHerad(withKeymap);
    expect(song.variant).toBe('v2');
    expect(song.instruments).toHaveLength(2);
    const keymap = song.instruments[1];
    expect(keymap.kind).toBe('keymap');
    if (keymap.kind === 'keymap') {
      expect(keymap.voice).toBe(5);
      expect(keymap.noteOffset).toBe(24);
      expect(keymap.indices.length).toBe(HERAD_INST_SIZE - 4);
    }
  });
});

describe('parseHerad — real files', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, '../../../../../examples/hsq/data');

  interface Expectation {
    file: string;
    tracks: number;
    instruments: number;
    isAgd: boolean;
    speed: number;
    loopStart: number;
    loopEnd: number;
    loopCount: number;
    /** Forced variant (used for files the keymap heuristic can't detect). */
    forceVariant?: 'v1' | 'v2';
    expectedVariant: 'v1' | 'v2';
  }

  const samples: Expectation[] = [
    {
      file: 'WORMINTR.HSQ',
      tracks: 9,
      instruments: 21,
      isAgd: false,
      speed: 0x409,
      loopStart: 42,
      loopEnd: 45,
      loopCount: 1,
      expectedVariant: 'v1',
    },
    {
      file: 'SAVAGE.HSQ',
      tracks: 9,
      instruments: 44,
      isAgd: false,
      speed: 0x497,
      loopStart: 21,
      loopEnd: 25,
      loopCount: 2,
      expectedVariant: 'v1',
    },
    {
      file: 'WORMINTR.AGD',
      tracks: 13,
      instruments: 41,
      isAgd: true,
      speed: 0x409,
      loopStart: 43,
      loopEnd: 49,
      loopCount: 1,
      expectedVariant: 'v1',
    },
    {
      file: 'ALARME.HSQ',
      tracks: 9,
      instruments: 46,
      isAgd: false,
      speed: 0x3c7,
      loopStart: 70,
      loopEnd: 71,
      loopCount: 1,
      // ALARME has no keymap instruments, so the heuristic classes it as v1;
      // the payload is actually v2. Force it to prove the override works.
      forceVariant: 'v2',
      expectedVariant: 'v2',
    },
  ];

  for (const sample of samples) {
    it(`parses ${sample.file}`, async () => {
      const path = resolve(dataDir, sample.file);
      if (!(await fileExists(path))) {
        console.warn(`[herad test] skipping ${sample.file} — not present`);
        return;
      }
      const bytes = new Uint8Array(await readFile(path));
      const song = parseHerad(bytes, sample.forceVariant ? { variant: sample.forceVariant } : {});
      expect(song.tracks).toHaveLength(sample.tracks);
      expect(song.instruments).toHaveLength(sample.instruments);
      expect(song.isAgd).toBe(sample.isAgd);
      expect(song.speed).toBe(sample.speed);
      expect(song.loopStart).toBe(sample.loopStart);
      expect(song.loopEnd).toBe(sample.loopEnd);
      expect(song.loopCount).toBe(sample.loopCount);
      expect(song.variant).toBe(sample.expectedVariant);
    });
  }

  it('accepts compressed HSQ bytes directly', async () => {
    const path = resolve(dataDir, 'WORMINTR.HSQ');
    if (!(await fileExists(path))) return;
    const bytes = new Uint8Array(await readFile(path));
    // parseHerad detects HSQ compression via isHsq and decompresses before parsing.
    const song = parseHerad(bytes);
    expect(song.tracks.length).toBeGreaterThan(0);
  });
});
