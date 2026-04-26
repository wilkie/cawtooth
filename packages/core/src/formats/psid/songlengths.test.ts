import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parsePsid } from './parser.js';
import { computeSidTuneMd5, lookupSongLengths, md5, parseSongLengthsDb } from './songlengths.js';

function nodeMd5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

describe('md5', () => {
  it('matches RFC 1321 test vectors', () => {
    // Canonical RFC 1321 appendix A.5 test vectors.
    const cases: Array<[string, string]> = [
      ['', 'd41d8cd98f00b204e9800998ecf8427e'],
      ['a', '0cc175b9c0f1b6a831c399e269772661'],
      ['abc', '900150983cd24fb0d6963f7d28e17f72'],
      ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
      ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
      [
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        'd174ab98d277d9f5a5611c2c9f419d9f',
      ],
      [
        '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
        '57edf4a22be3c955ac49da2e2107b67a',
      ],
    ];
    for (const [input, expected] of cases) {
      expect(md5(new TextEncoder().encode(input))).toBe(expected);
    }
  });

  it('handles inputs that sit exactly on a block boundary', () => {
    // Edge case: 55 bytes (one pad byte + length fits in same block),
    // 56 bytes (needs a fresh block for length), 64 bytes.
    for (const n of [55, 56, 63, 64, 65, 127, 128, 129]) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = i & 0xff;
      expect(md5(bytes)).toBe(nodeMd5(bytes));
    }
  });

  it('matches Node crypto for random-ish inputs', () => {
    const sizes = [1, 7, 15, 100, 1000, 8192, 16384];
    for (const n of sizes) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = ((i * 1103515245 + 12345) >>> 0) & 0xff;
      expect(md5(bytes)).toBe(nodeMd5(bytes));
    }
  });
});

describe('computeSidTuneMd5', () => {
  it('composes data + 12 header bytes in the documented order', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sidBytes = new Uint8Array(
      await readFile(resolve(here, '../../../../../examples/sid/data/Batman_the_Movie.sid')),
    );
    const song = parsePsid(sidBytes);

    // Independently construct what should be hashed.
    const expected = new Uint8Array(song.data.length + 12);
    expected.set(song.data, 0);
    const dv = new DataView(expected.buffer);
    let p = song.data.length;
    dv.setUint16(p, song.initAddress, false);
    p += 2;
    dv.setUint16(p, song.playAddress, false);
    p += 2;
    dv.setUint16(p, song.songs, false);
    p += 2;
    dv.setUint32(p, song.speed, false);
    p += 4;
    // Batman: PAL + MOS6581 → clock=1, model=1.
    expected[p++] = 1;
    expected[p++] = 1;

    expect(computeSidTuneMd5(song)).toBe(nodeMd5(expected));
  });

  it('returns a stable 32-char lowercase hex digest', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sidBytes = new Uint8Array(
      await readFile(resolve(here, '../../../../../examples/sid/data/Batman_the_Movie.sid')),
    );
    const song = parsePsid(sidBytes);
    const hash = computeSidTuneMd5(song);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    // Same input → same hash.
    expect(computeSidTuneMd5(song)).toBe(hash);
  });
});

describe('parseSongLengthsDb', () => {
  it('parses well-formed entries', () => {
    const db = parseSongLengthsDb(
      [
        '; HVSC SongLengths v90.0',
        '',
        '[Database]',
        'abcdef0123456789abcdef0123456789=2:41 5:07 2:11',
        '1234567890abcdef1234567890abcdef=0:42.500',
      ].join('\n'),
    );
    expect(db.size).toBe(2);
    expect(db.get('abcdef0123456789abcdef0123456789')).toEqual({
      count: 3,
      durations: [2 * 60 + 41, 5 * 60 + 7, 2 * 60 + 11],
    });
    expect(db.get('1234567890abcdef1234567890abcdef')).toEqual({
      count: 1,
      durations: [42.5],
    });
  });

  it('skips comments, section headers, blank lines, and malformed entries', () => {
    const db = parseSongLengthsDb(
      [
        '; comment',
        '[Section]',
        '',
        'not-a-hash=1:23',
        'too-short=1:23',
        'abcdef0123456789abcdef0123456789=malformedtime',
        'abcdef0123456789abcdef0123456789=1:23',
      ].join('\n'),
    );
    expect(db.size).toBe(1);
    expect(db.get('abcdef0123456789abcdef0123456789')?.durations).toEqual([83]);
  });

  it('lowercases the hex key so inputs are case-insensitive', () => {
    const db = parseSongLengthsDb('ABCDEF0123456789ABCDEF0123456789=1:00\n');
    expect(db.has('abcdef0123456789abcdef0123456789')).toBe(true);
  });

  it('parses fractional durations with any millisecond width', () => {
    const db = parseSongLengthsDb(
      ['abcdef0123456789abcdef0123456789=0:05 0:05.5 0:05.123'].join('\n'),
    );
    const entry = db.get('abcdef0123456789abcdef0123456789');
    expect(entry?.durations).toEqual([5, 5.5, 5.123]);
  });
});

describe('lookupSongLengths', () => {
  it('returns the entry when the tune is in the database', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sidBytes = new Uint8Array(
      await readFile(resolve(here, '../../../../../examples/sid/data/Batman_the_Movie.sid')),
    );
    const song = parsePsid(sidBytes);
    const hash = computeSidTuneMd5(song);

    const db = parseSongLengthsDb(`${hash}=2:41 3:12 4:05\n`);
    const hit = lookupSongLengths(song, db);
    expect(hit).not.toBeNull();
    expect(hit!.count).toBe(3);
    expect(hit!.durations[0]).toBe(161);
  });

  it('returns null when the tune is not in the database', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sidBytes = new Uint8Array(
      await readFile(resolve(here, '../../../../../examples/sid/data/Batman_the_Movie.sid')),
    );
    const song = parsePsid(sidBytes);
    const db = parseSongLengthsDb('deadbeef' + 'cafebabe'.repeat(3) + '=1:00\n');
    expect(lookupSongLengths(song, db)).toBeNull();
  });
});
