/**
 * PSID / RSID header types.
 *
 * Reference: HVSC "SID file format" doc
 * https://www.hvsc.c64.org/download/C64Music/DOCUMENTS/SID_file_format.txt
 *
 * All multi-byte fields in the on-disk header are big-endian. The embedded
 * C64 binary payload (after the header) uses little-endian PRG-style load
 * addresses, which the parser resolves into `loadAddress`.
 */

export type PsidMagic = 'PSID' | 'RSID';

export type PsidClock = 'unknown' | 'PAL' | 'NTSC' | 'both';

export type PsidSidModel = 'unknown' | 'MOS6581' | 'MOS8580' | 'both';

/**
 * Decoded flags word from header offset +76 (v2+ only). Missing for v1
 * files; the parser fills in sensible defaults (all `unknown`) so callers
 * don't have to special-case version.
 */
export interface PsidFlags {
  /** bit 0: built-in Compute!'s Sidplayer MUS format. */
  musPlayer: boolean;
  /**
   * bit 1. PSID: true = PlaySID-specific (non-C64-compatible). RSID: this
   * bit means the tune expects BASIC to be running.
   */
  psidSpecific: boolean;
  /** bits 2–3: C64 video standard hint. */
  clock: PsidClock;
  /** bits 4–5: first SID chip model hint. */
  sidModel: PsidSidModel;
  /** bits 6–7: second SID chip model hint (v3+). */
  sidModel2: PsidSidModel;
  /** bits 8–9: third SID chip model hint (v4). */
  sidModel3: PsidSidModel;
}

/**
 * Parsed PSID/RSID song file.
 *
 * `data` is the C64 binary payload ONLY — if the on-disk header's load
 * address field was 0, the parser consumes the first 2 bytes of the data
 * block as the PRG-style little-endian load address and strips them, so
 * callers always get a clean "copy this into C64 memory starting at
 * loadAddress" buffer.
 */
export interface PsidSong {
  magic: PsidMagic;
  version: 1 | 2 | 3 | 4;
  /** Header size in bytes. 0x76 for v1, 0x7C for v2+. */
  dataOffset: number;
  /** Resolved 16-bit C64 load address. */
  loadAddress: number;
  /** 16-bit C64 address of the init routine. */
  initAddress: number;
  /**
   * 16-bit C64 address of the play routine. Zero means the tune installs
   * its own IRQ vector during init; player must follow the vector instead
   * of calling a fixed play address. RSID files always have playAddress=0.
   */
  playAddress: number;
  /** Total number of subtunes (1–256). */
  songs: number;
  /** 1-based index of the default subtune. */
  startSong: number;
  /**
   * 32-bit speed bitfield. Bit N = 1 means subtune N+1 uses CIA timer;
   * bit N = 0 means vblank. RSID files always have speed=0. For tunes
   * with more than 32 subtunes the field wraps mod 32.
   */
  speed: number;
  name: string;
  author: string;
  released: string;
  flags: PsidFlags;
  /** v2NG+: start page of a relocation area the driver promises not to touch. */
  startPage: number;
  /** v2NG+: length in pages of the relocation area starting at startPage. */
  pageLength: number;
  /**
   * v3+: second SID base address encoded as `$D000 | (secondSIDAddress << 4)`.
   * 0 = no second SID. Parser returns the raw byte; consumer resolves.
   */
  secondSIDAddress: number;
  /** v4: third SID base address (same encoding as secondSIDAddress). */
  thirdSIDAddress: number;
  /** C64 binary payload. First byte goes at `loadAddress` in C64 memory. */
  data: Uint8Array;
}
