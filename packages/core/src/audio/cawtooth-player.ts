import { parsePsid } from '../formats/psid/parser.js';
import { parseImf } from '../formats/imf/parser.js';
import { parseDro } from '../formats/dro/parser.js';
import { parseHerad } from '../formats/herad/parser.js';
import { renderHeradToStream } from '../formats/herad/render.js';
import { isHsq } from '../formats/herad/hsq.js';
import { isSqx } from '../formats/herad/sqx.js';
import { OplPlayer } from './opl-player.js';
import { PsidPlayer } from './psid-player.js';
import type { Player } from './player.js';

/**
 * Concrete formats the factory knows how to detect and dispatch.
 *
 * `psid` covers both PSID and RSID files — the underlying parser + worklet
 * handle either transparently.
 */
export type DetectedFormat = 'psid' | 'imf' | 'dro' | 'herad';

/** Per-format runtime URLs. Worklet bundle + wasm module. */
export interface CawtoothFormatConfig {
  workletUrl: string | URL;
  wasmUrl: string | URL;
}

export interface CawtoothPlayerOptions {
  /**
   * Per-format runtime URLs. Only formats listed here can be loaded —
   * trying to load a tune for a format the caller hasn't configured
   * throws a descriptive error rather than failing silently.
   *
   * The two keys cover every format the factory can dispatch:
   *   - `opl`  — drives IMF, DRO, and HERAD playback through the OPL3 wasm
   *   - `psid` — drives PSID and RSID playback through the sidplay wasm
   */
  formats: {
    opl?: CawtoothFormatConfig;
    psid?: CawtoothFormatConfig;
  };
  /**
   * Shared AudioContext. Created on demand if omitted. Sharing one
   * context across many loaded tunes lets a downstream UI route
   * everything through the same effects chain.
   */
  audioContext?: AudioContext;
}

export interface CawtoothLoadOptions {
  /**
   * Filename hint. Disambiguates IMF and decompressed HERAD, which have
   * no magic bytes; not needed for PSID/RSID/DRO/HSQ/SQX.
   */
  filename?: string;
  /**
   * Override format detection entirely. Useful when the caller knows
   * exactly what they have (e.g. a parser failed and they want to retry
   * a different one) or when sniffing would be ambiguous.
   */
  format?: DetectedFormat;
  /**
   * IMF tick rate in Hz. IMF files don't encode their tick rate; common
   * values are 560 (Commander Keen / Bio Menace), 700 (Wolfenstein 3D
   * and most Apogee titles), 280 (Duke Nukem II). Defaults to 700.
   */
  tickRate?: number;
  /** Loop OPL streams. Defaults to false. */
  loop?: boolean;
  /** PSID subsong, 1-based. Defaults to the tune's startSong. */
  subsong?: number;
}

/**
 * Top-level factory: format auto-detection + Player dispatch.
 *
 * Two-step usage so the heavy bits (AudioContext, AudioWorklet
 * registration) are done once and amortized across many tune loads:
 *
 * ```ts
 * const factory = await CawtoothPlayer.init({
 *   formats: {
 *     opl:  { workletUrl: oplWorkletUrl,  wasmUrl: oplWasmUrl },
 *     psid: { workletUrl: psidWorkletUrl, wasmUrl: sidWasmUrl },
 *   },
 * });
 *
 * const player = await factory.load(fileBytes, { filename: 'song.imf' });
 * await player.resumeAudio();
 * player.play();
 * ```
 *
 * `load()` returns the concrete `Player` subclass so a caller can narrow
 * via `instanceof` or via the `.format` discriminator on `info`.
 *
 * Each load creates a fresh `Player` instance. The factory does not track
 * or auto-dispose previously-returned players — call `.dispose()` on the
 * old one before loading the next tune to free its worklet node.
 */
export class CawtoothPlayer {
  private constructor(
    private readonly ctx: AudioContext,
    private readonly ownsContext: boolean,
    private readonly formats: CawtoothPlayerOptions['formats'],
  ) {}

  static async init(options: CawtoothPlayerOptions): Promise<CawtoothPlayer> {
    const ownsContext = !options.audioContext;
    const ctx = options.audioContext ?? new AudioContext();
    return new CawtoothPlayer(ctx, ownsContext, options.formats);
  }

  get audioContext(): AudioContext {
    return this.ctx;
  }

  /**
   * Detect the format of `bytes`, parse it, and return a paused-at-zero
   * Player ready for `play()`. The returned player shares this factory's
   * AudioContext.
   */
  async load(bytes: ArrayBuffer | Uint8Array, options: CawtoothLoadOptions = {}): Promise<Player> {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const format = options.format ?? detectFormat(view, options.filename);

    switch (format) {
      case 'psid': {
        const cfg = this.requireFormat('psid');
        const song = parsePsid(view);
        return PsidPlayer.create({
          workletUrl: cfg.workletUrl,
          wasmUrl: cfg.wasmUrl,
          song,
          audioContext: this.ctx,
          subsong: options.subsong,
        });
      }
      case 'imf': {
        const cfg = this.requireFormat('opl');
        const song = parseImf(view);
        const player = await OplPlayer.create({
          workletUrl: cfg.workletUrl,
          wasmUrl: cfg.wasmUrl,
          audioContext: this.ctx,
        });
        player.loadStream(
          song.stream,
          { tickRate: options.tickRate ?? 700, loop: options.loop ?? false },
          {
            container: 'imf',
            variant: song.variant,
            title: song.title ?? '',
            source: song.source ?? '',
            remarks: song.remarks ?? '',
          },
        );
        return player;
      }
      case 'dro': {
        const cfg = this.requireFormat('opl');
        const song = parseDro(view);
        const player = await OplPlayer.create({
          workletUrl: cfg.workletUrl,
          wasmUrl: cfg.wasmUrl,
          audioContext: this.ctx,
        });
        player.loadStream(
          song.stream,
          { tickRate: song.tickRate, loop: options.loop ?? false },
          { container: 'dro', variant: song.variant },
        );
        return player;
      }
      case 'herad': {
        const cfg = this.requireFormat('opl');
        const song = parseHerad(view);
        const stream = renderHeradToStream(song);
        const player = await OplPlayer.create({
          workletUrl: cfg.workletUrl,
          wasmUrl: cfg.wasmUrl,
          audioContext: this.ctx,
        });
        player.loadStream(
          stream.stream,
          { tickRate: stream.tickRate, loop: options.loop ?? false },
          { container: 'herad', variant: song.variant },
        );
        return player;
      }
    }
  }

  /**
   * Tear down the factory. Closes the shared AudioContext if we created
   * it. Does NOT dispose any players the caller previously got from
   * `load()` — those need their own `.dispose()`.
   */
  async dispose(): Promise<void> {
    if (this.ownsContext) {
      await this.ctx.close();
    }
  }

  private requireFormat(name: 'opl' | 'psid'): CawtoothFormatConfig {
    const cfg = this.formats[name];
    if (!cfg) {
      throw new Error(
        `cawtooth: detected ${name} content but no '${name}' format ` +
          `config was provided to CawtoothPlayer.init({ formats: { ${name}: ... } })`,
      );
    }
    return cfg;
  }
}

/**
 * Sniff a chiptune format from raw bytes (and optional filename hint).
 *
 * Detection order, most-reliable first:
 *   1. PSID/RSID — 4-byte ASCII magic at offset 0 (collapsed to `'psid'`).
 *   2. DRO       — 8-byte 'DBRAWOPL' magic at offset 0.
 *   3. HSQ       — 6-byte header whose bytes sum to 0xAB (HERAD-compressed).
 *   4. SQX       — heuristic on bytes 2..5 (HERAD-compressed).
 *   5. filename  — fallback for raw IMF and decompressed HERAD.
 *
 * Throws when nothing matches. Pass `options.format` to `load()` to skip.
 */
export function detectFormat(bytes: Uint8Array, filename?: string): DetectedFormat {
  // PSID and RSID — same parser, same player, same downstream type.
  if (bytes.length >= 4) {
    const m = bytes;
    // 'PSID' = 0x50 0x53 0x49 0x44; 'RSID' = 0x52 0x53 0x49 0x44.
    if (m[1] === 0x53 && m[2] === 0x49 && m[3] === 0x44 && (m[0] === 0x50 || m[0] === 0x52)) {
      return 'psid';
    }
  }
  // 'DBRAWOPL'.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x44 &&
    bytes[1] === 0x42 &&
    bytes[2] === 0x52 &&
    bytes[3] === 0x41 &&
    bytes[4] === 0x57 &&
    bytes[5] === 0x4f &&
    bytes[6] === 0x50 &&
    bytes[7] === 0x4c
  ) {
    return 'dro';
  }
  // Cryo HERAD compressed wrappers. isHsq checksum is 1/256 false-positive;
  // isSqx is heuristic but the field ranges are narrow.
  if (isHsq(bytes) || isSqx(bytes)) {
    return 'herad';
  }

  // Filename fallback for formats without magic bytes.
  if (filename) {
    // Strip any path prefix (forward or back slash) before extracting the extension.
    const base = filename.replace(/^.*[\\/]/, '');
    const ext = base.toLowerCase().split('.').pop() ?? '';
    if (ext === 'imf' || ext === 'wlf' || ext === 'ims') return 'imf';
    if (ext === 'sid') return 'psid';
    if (ext === 'dro') return 'dro';
    if (ext === 'hsq' || ext === 'sqx' || ext === 'agd' || ext === 'ha2') return 'herad';
  }

  throw new Error(
    'cawtooth: could not detect format from bytes' +
      (filename ? ` or filename "${filename}"` : '') +
      '. Pass `format` explicitly to CawtoothPlayer.load() to override.',
  );
}
