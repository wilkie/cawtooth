/**
 * Atari ST SNDH module types.
 *
 * SNDH wraps a tiny Motorola 68000 player binary together with a
 * tagged metadata block. Every file starts with three `BRA.W`
 * instructions that point at `init` / `exit` / `play` entry points,
 * followed by the literal magic `'SNDH'` at offset 0x0C and a stream
 * of variable-length tag/value pairs terminated by `'HDNS'`.
 *
 * The compiled m68k payload for the player itself sits past the
 * metadata; we surface the entire file via `binary` so the WASM
 * loader can map it verbatim into the simulated Atari ST RAM at $0
 * and let Musashi resolve the branch displacements at runtime.
 */

/** MFP timer (or VBL) the SNDH file authored its `play` cadence against. */
export interface SndhTimer {
  /** `'A'`/`'B'`/`'C'`/`'D'` for MFP 68901 timer channels, `'V'` for VBL. */
  readonly type: 'A' | 'B' | 'C' | 'D' | 'V';
  readonly frequencyHz: number;
}

export interface SndhSong {
  /** Whole file. The m68k loader maps this verbatim into RAM at $0. */
  readonly binary: Uint8Array;
  /** Resolved m68k address of the `init` entry point. */
  readonly initAddress: number;
  /** Resolved m68k address of the `exit` entry point. */
  readonly exitAddress: number;
  /** Resolved m68k address of the `play` entry point (interrupt-driven). */
  readonly playAddress: number;
  /** `TITL` tag value; empty when not present. */
  readonly title: string;
  /** `COMM` tag value (composer/author); empty when not present. */
  readonly composer: string;
  /** `RIPP` tag value; empty when not present. */
  readonly ripper: string;
  /** `CONV` tag value; empty when not present. */
  readonly converter: string;
  /** `YEAR` tag value; empty when not present. */
  readonly year: string;
  /** Parsed timer tag (`TA`/`TB`/`TC`/`TD`/`!V`). Undefined when absent. */
  readonly timer?: SndhTimer;
  /** Total subsong count. Defaults to `1` when no count tag is present. */
  readonly subsongCount: number;
  /** Default subsong (1-based). Defaults to `1` when not specified. */
  readonly defaultSubsong: number;
  /** Concatenated `FLAG` characters, one per subsong. Empty when absent. */
  readonly flags: string;
  /** Per-subsong durations in seconds from the `TIME` tag. Empty when absent. */
  readonly durations: readonly number[];
}
