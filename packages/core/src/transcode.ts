/**
 * Cross-format transcoding helpers.
 *
 * Each backend (OPL, eventually MIDI / others) gets a single "parse to
 * canonical intermediate" function here. The intermediate is the same
 * shape that downstream players and encoders already accept, so any
 * source → any target reduces to two composable calls:
 *
 * ```ts
 * const stream = parseOpl(bytes, { filename });
 * if (stream) {
 *   const dro = encodeDro(stream);
 *   // or: player.loadStream(stream.stream, { tickRate: stream.tickRate })
 *   // or: const imf = encodeImf(stream.stream, { tickRate: stream.tickRate })
 * }
 * ```
 *
 * Keeping the intermediate exposed (rather than wrapping it inside a
 * single `transcode()`) leaves room for the in-between steps that
 * actually matter — `dedupRegisterEventStream`, custom retiming,
 * inspection — without forcing every consumer through a one-shot helper.
 */

import { parseImf } from './formats/imf/parser.js';
import { parseDro } from './formats/dro/parser.js';
import { parseHerad } from './formats/herad/parser.js';
import { renderHeradToStream } from './formats/herad/render.js';
import { detectFormat, type DetectedFormat } from './audio/cawtooth-player.js';
import type { TimedRegisterStream } from './sequencer/types.js';

/**
 * Source-format hint accepted by `parseOpl`. PSID is intentionally
 * absent — it's not an OPL family and `parseOpl` returns `null` for it.
 */
export type ParseOplFormat = Exclude<DetectedFormat, 'psid'>;

export interface ParseOplOptions {
  /**
   * Filename hint for sniffing. IMF and decompressed HERAD have no
   * magic bytes; the extension is what disambiguates them.
   */
  filename?: string;
  /**
   * Override format detection. Useful when the caller already knows what
   * they have, or when sniffing would be ambiguous.
   */
  format?: ParseOplFormat;
  /**
   * IMF tick rate in Hz. IMF files don't store their tick rate (it's
   * game-specific: 560 for Keen, 700 for Wolf3D, 280 for Duke II).
   * Defaults to 700. Ignored for DRO and HERAD, which carry their own.
   */
  tickRate?: number;
}

/**
 * Parse any OPL-family chiptune source into the canonical
 * `TimedRegisterStream` intermediate.
 *
 * Returns `null` when the bytes are recognized as a non-OPL format (e.g.
 * PSID), letting callers branch without a try/catch. Throws when the
 * bytes don't match any known format and no `format` override or usable
 * filename hint is provided.
 *
 * The returned stream is the same shape `OplPlayer.loadStream`,
 * `encodeDro`, and `encodeImf` accept, so any source → any target is a
 * two-line composition.
 */
export function parseOpl(
  bytes: ArrayBuffer | Uint8Array,
  options: ParseOplOptions = {},
): TimedRegisterStream | null {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const format: DetectedFormat = options.format ?? detectFormat(view, options.filename);

  switch (format) {
    case 'imf': {
      const song = parseImf(view);
      return { stream: song.stream, tickRate: options.tickRate ?? 700 };
    }
    case 'dro': {
      const song = parseDro(view);
      return { stream: song.stream, tickRate: song.tickRate };
    }
    case 'herad': {
      // parseHerad transparently handles the HSQ / SQX compression
      // wrappers, then renderHeradToStream walks the per-track event
      // lists into the OPL register-write stream that everything else
      // in the pipeline speaks.
      const song = parseHerad(view);
      return renderHeradToStream(song);
    }
    case 'psid':
    case 'psg':
    case 'vtx':
    case 'ym':
    case 'asc':
    case 'sndh':
      // Recognized non-OPL containers — caller can branch via the null.
      return null;
  }
}
