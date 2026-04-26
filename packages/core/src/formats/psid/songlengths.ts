/**
 * HVSC SongLengths integration.
 *
 * The High Voltage SID Collection maintains a companion file,
 * `Songlengths.md5`, keyed by an MD5 hash computed over a specific slice
 * of each PSID/RSID tune. Each entry lists per-subsong play durations
 * in `mm:ss.fff` format. This module provides:
 *
 *   - `computeSidTuneMd5(song)`   — produce the hash HVSC uses
 *   - `parseSongLengthsDb(text)`  — parse the on-disk `Songlengths.md5`
 *   - `lookupSongLengths(song, db)` — convenience: hash + look up
 *
 * Hash algorithm ("md5new", current HVSC convention): the tune's binary
 * payload followed by
 *   2 bytes BE   initAddress
 *   2 bytes BE   playAddress
 *   2 bytes BE   songs
 *   4 bytes BE   speed bitfield
 *   1 byte       clock (flags bits 2-3: 0=unknown, 1=PAL, 2=NTSC, 3=both)
 *   1 byte       sid model 1 (flags bits 4-5: 0=unknown, 1=6581, 2=8580, 3=both)
 *
 * For v1 PSIDs without flags, both extra bytes are 0 — matching libsidplayfp
 * behavior. Multi-SID model hints (sidModel2/3) are NOT part of the hash.
 *
 * MD5 implementation below is inlined because `SubtleCrypto` omits MD5
 * (rightly — it's cryptographically broken) and pulling a runtime
 * dependency for one ~80-line algorithm isn't worth it.
 */

import type { PsidClock, PsidSidModel, PsidSong } from './types.js';

const CLOCK_CODE: Record<PsidClock, number> = {
  unknown: 0,
  PAL: 1,
  NTSC: 2,
  both: 3,
};

const MODEL_CODE: Record<PsidSidModel, number> = {
  unknown: 0,
  MOS6581: 1,
  MOS8580: 2,
  both: 3,
};

// ----------------------------------------------------------------------------
// MD5 (RFC 1321). Returns a 32-char lowercase hex digest.
// ----------------------------------------------------------------------------

// Constants: K[i] = floor(2^32 * abs(sin(i + 1)))
const K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

// Per-step left-rotate amounts.
const S = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function word2hex(w: number): string {
  return (
    (w & 0xff).toString(16).padStart(2, '0') +
    ((w >>> 8) & 0xff).toString(16).padStart(2, '0') +
    ((w >>> 16) & 0xff).toString(16).padStart(2, '0') +
    ((w >>> 24) & 0xff).toString(16).padStart(2, '0')
  );
}

export function md5(bytes: Uint8Array): string {
  const msgLen = bytes.length;
  // Pad: original bytes + 0x80 + zeros up to 56 mod 64, then 64-bit LE length.
  const paddedLen = Math.ceil((msgLen + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[msgLen] = 0x80;
  const dv = new DataView(padded.buffer);
  const bitLen = msgLen * 8;
  // Write 64-bit LE length. Split across two 32-bit writes because JS
  // numbers exceed 32-bit precision but our inputs do not.
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);

  for (let block = 0; block < paddedLen; block += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = dv.getUint32(block + i * 4, true);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) & 15;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) & 15;
      }
      const t = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl32(t, S[i])) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  return word2hex(a0) + word2hex(b0) + word2hex(c0) + word2hex(d0);
}

// ----------------------------------------------------------------------------
// HVSC hash composition + song-length lookup.
// ----------------------------------------------------------------------------

/**
 * Compute the HVSC-compatible MD5 hash for a parsed PSID/RSID tune.
 *
 * Hashes the tune's binary payload concatenated with 12 bytes derived
 * from the header: initAddr, playAddr, songs, speed, then two bytes of
 * clock + SID model from the v2+ flags field. For v1 tunes the flags
 * default to 0, matching what libsidplayfp / HVSC do.
 *
 * Returns a 32-char lowercase hex digest suitable for keying into
 * `parseSongLengthsDb()`.
 */
export function computeSidTuneMd5(song: PsidSong): string {
  const buf = new Uint8Array(song.data.length + 12);
  buf.set(song.data, 0);
  const dv = new DataView(buf.buffer);
  let pos = song.data.length;
  dv.setUint16(pos, song.initAddress, false);
  pos += 2;
  dv.setUint16(pos, song.playAddress, false);
  pos += 2;
  dv.setUint16(pos, song.songs, false);
  pos += 2;
  dv.setUint32(pos, song.speed, false);
  pos += 4;
  buf[pos++] = CLOCK_CODE[song.flags.clock];
  buf[pos++] = MODEL_CODE[song.flags.sidModel];
  return md5(buf);
}

export interface SongLengths {
  /** Number of subsongs the database has durations for. */
  readonly count: number;
  /**
   * Per-subsong duration in seconds. `durations[0]` is subsong 1 per
   * PSID's 1-based convention.
   */
  readonly durations: readonly number[];
}

export type SongLengthsDb = Map<string, SongLengths>;

/**
 * Parse an HVSC `Songlengths.md5` file. Format:
 *
 *   ; comments begin with a semicolon
 *   [Section] header lines are also skipped
 *   <32-hex-md5>=m:ss m:ss.fff m:ss ...
 *
 * Durations accept `m:ss` or `m:ss.fff`. Returns a Map keyed by the
 * lowercase md5 hex string. Malformed lines are skipped silently.
 */
export function parseSongLengthsDb(text: string): SongLengthsDb {
  const db = new Map<string, SongLengths>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith(';') || trimmed.startsWith('[')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;

    const hash = trimmed.substring(0, eq).trim().toLowerCase();
    if (hash.length !== 32 || !/^[0-9a-f]{32}$/.test(hash)) continue;

    const timesStr = trimmed.substring(eq + 1).trim();
    const durations: number[] = [];
    for (const token of timesStr.split(/\s+/)) {
      const d = parseDuration(token);
      if (d !== null) durations.push(d);
    }
    if (durations.length > 0) {
      db.set(hash, { count: durations.length, durations });
    }
  }
  return db;
}

function parseDuration(s: string): number | null {
  // m:ss or m:ss.fff (HVSC always uses at least two ss digits; fractional
  // part is variable-width milliseconds).
  const m = s.match(/^(\d+):(\d{2})(?:\.(\d+))?$/);
  if (!m) return null;
  const minutes = Number.parseInt(m[1], 10);
  const seconds = Number.parseInt(m[2], 10);
  const frac = m[3] ? Number.parseFloat('0.' + m[3]) : 0;
  return minutes * 60 + seconds + frac;
}

/**
 * Convenience: compute the hash for `song` and look it up in `db`.
 * Returns `null` when the tune isn't in the database. When present,
 * `durations` may have fewer entries than `song.songs` if HVSC only
 * measured a subset.
 */
export function lookupSongLengths(song: PsidSong, db: SongLengthsDb): SongLengths | null {
  return db.get(computeSidTuneMd5(song)) ?? null;
}
