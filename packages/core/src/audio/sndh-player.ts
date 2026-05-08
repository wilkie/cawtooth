import type { ChannelsListener } from './opl-player.js';
import { Player, type SndhPlayerInfo } from './player.js';
import { parseSndh } from '../formats/sndh/parser.js';
import type { SndhSong } from '../formats/sndh/types.js';
import { SNDH_PROCESSOR_NAME } from '../worklet/sndh-processor-name.js';
import type {
  FromSndhWorkletMessage,
  SndhReadyMessage,
  ToSndhWorkletMessage,
} from '../worklet/sndh-messages.js';

export interface SndhPlayerCreateOptions {
  /** URL of the bundled SNDH worklet script (dist/worklet/sndh-processor.js). */
  workletUrl: string | URL;
  /** URL of the sndh wasm module (packages/core/wasm/sndh.wasm). */
  wasmUrl: string | URL;
  /**
   * Raw .sndh file bytes OR an already-parsed SndhSong. Raw bytes are
   * parsed on the main thread (AudioWorkletGlobalScope doesn't reliably
   * expose TextDecoder, which the parser needs for Windows-1252 strings).
   */
  sndhBytes?: ArrayBuffer;
  song?: SndhSong;
  /** Optional existing AudioContext. Player creates one if omitted. */
  audioContext?: AudioContext;
  /** Explicit 68000 clock override. Defaults to PAL Atari ST. */
  clockFrequency?: number;
  /** Explicit YM2149 clock override. Defaults to 2 MHz. */
  ymClockFrequency?: number;
  /** Subsong to start on. 1-based; defaults to {@link SndhSong.defaultSubsong}. */
  subsong?: number;
}

/**
 * Main-thread handle for SNDH playback through the sndh AudioWorklet.
 *
 * Like every cawtooth player, the player is **paused-at-zero** after
 * `create()` returns. The caller must call `play()` to start audio. This
 * matches `OplPlayer` / `PsidPlayer` / `CawtoothPlayer.load()` so a
 * generic UI can always issue the same `resumeAudio() → play()` sequence
 * on a user gesture.
 */
export class SndhPlayer extends Player {
  /**
   * Mutable internal copy of the playback info. The public `info` getter
   * exposes a readonly view. `subsong` is updated on `selectSong`; the
   * other fields are immutable for the life of the player.
   */
  private readonly _info: {
    -readonly [K in keyof SndhPlayerInfo]: SndhPlayerInfo[K];
  };

  private currentTimeSec = 0;
  private durationSec: number | null = null;
  private playing = false;
  private endedFired = false;
  /**
   * Per-subsong durations (seconds) parsed from the SNDH TIME tag.
   * Empty when the file doesn't carry one. Keyed 0-based even though
   * subsong numbers are 1-based — so `durations[subsong - 1]`.
   */
  private readonly durations: readonly number[];

  private constructor(
    ctx: AudioContext,
    ownsContext: boolean,
    node: AudioWorkletNode,
    info: SndhPlayerInfo,
    durations: readonly number[],
    initialDurationSec: number | null,
  ) {
    super(ctx, ownsContext, node);
    this._info = { ...info };
    this.durations = durations;
    this.durationSec = initialDurationSec;
    this.installMessageDispatcher();
  }

  static async create(options: SndhPlayerCreateOptions): Promise<SndhPlayer> {
    const ownsContext = !options.audioContext;
    const ctx = options.audioContext ?? new AudioContext();

    const song =
      options.song ??
      (options.sndhBytes
        ? parseSndh(new Uint8Array(options.sndhBytes))
        : (() => {
            throw new Error('cawtooth: SndhPlayer.create requires either sndhBytes or song');
          })());

    await ctx.audioWorklet.addModule(options.workletUrl.toString());

    const wasmResp = await fetch(options.wasmUrl.toString());
    if (!wasmResp.ok) {
      throw new Error(
        `cawtooth: failed to fetch sndh wasm: ${wasmResp.status} ${wasmResp.statusText}`,
      );
    }
    const wasmBytes = await wasmResp.arrayBuffer();

    const node = new AudioWorkletNode(ctx, SNDH_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const ready = new Promise<SndhReadyMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            'cawtooth: SNDH worklet did not respond within 10s. ' +
              'The worklet processor may not have loaded, or the init message did not arrive.',
          ),
        );
      }, 10_000);

      node.port.onmessage = (ev: MessageEvent<FromSndhWorkletMessage>) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve(msg);
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          reject(new Error(`cawtooth SNDH worklet error: ${msg.message}`));
        }
      };

      node.port.onmessageerror = (ev) => {
        clearTimeout(timer);
        reject(new Error(`cawtooth: message deserialization failed: ${String(ev)}`));
      };
    });

    const initMsg: ToSndhWorkletMessage = {
      type: 'init',
      wasmBytes,
      song,
      clockFrequency: options.clockFrequency,
      ymClockFrequency: options.ymClockFrequency,
      subsong: options.subsong,
    };
    node.port.postMessage(initMsg, [wasmBytes]);

    const ready_ = await ready;
    const info: SndhPlayerInfo = {
      format: 'sndh',
      title: ready_.title,
      composer: ready_.composer,
      ripper: ready_.ripper,
      converter: ready_.converter,
      year: ready_.year,
      subsongCount: ready_.subsongCount,
      subsong: ready_.subsong,
      clockFrequency: ready_.clockFrequency,
      playInterval: ready_.playInterval,
    };
    return new SndhPlayer(ctx, ownsContext, node, info, song.durations, ready_.durationSec);
  }

  get format(): 'sndh' {
    return 'sndh';
  }

  get info(): SndhPlayerInfo {
    return this._info;
  }

  get currentTime(): number {
    return this.currentTimeSec;
  }

  get duration(): number | null {
    return this.durationSec;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * Switch to a different subsong (1-based). Updates `info.subsong` so
   * consumers reading the field see current state. Preserves the
   * `playing` / `paused` state. The TIME-tag duration for the new
   * subsong is applied immediately so callers can read `.duration`
   * without waiting for the next progress message.
   */
  selectSong(subsong: number): void {
    const msg: ToSndhWorkletMessage = { type: 'selectSong', subsong };
    this.node.port.postMessage(msg);
    this._info.subsong = subsong;
    this.currentTimeSec = 0;
    this.durationSec = this.durationForSubsong(subsong);
    this.endedFired = false;
  }

  /**
   * TIME-tag duration in seconds for `subsong` (1-based), or `null`
   * when the file has no entry / the entry is the spec's "unknown"
   * zero. Useful for populating subsong-picker labels with durations.
   */
  durationForSubsong(subsong: number): number | null {
    if (subsong < 1 || subsong > this.durations.length) return null;
    const sec = this.durations[subsong - 1] ?? 0;
    return sec > 0 ? sec : null;
  }

  play(): void {
    this.node.port.postMessage({ type: 'play' } satisfies ToSndhWorkletMessage);
    this.playing = true;
  }

  pause(): void {
    this.node.port.postMessage({ type: 'pause' } satisfies ToSndhWorkletMessage);
    this.playing = false;
  }

  stop(): void {
    this.node.port.postMessage({ type: 'stop' } satisfies ToSndhWorkletMessage);
    this.playing = false;
    this.currentTimeSec = 0;
    this.endedFired = false;
  }

  /**
   * Tell the worklet how long the currently-initialized subsong is (in
   * seconds). The worklet fires `ended` once elapsed audio reaches this
   * threshold. Pass `null` to clear — the most common case being
   * "TIME-tag duration was 0 / the SNDH header didn't include one".
   *
   * Idempotent; overwrites any previous value.
   */
  setSubsongDurationSec(sec: number | null): void {
    this.node.port.postMessage({ type: 'setDuration', durationSec: sec });
    this.durationSec = sec;
    this.endedFired = false;
  }

  /**
   * Subscribe to per-voice PCM taps. Returns an unsubscribe function.
   *
   * The first listener activates per-voice output on the worklet; the
   * last to unsubscribe turns it off. While active, the worklet allocates
   * a fresh Float32 buffer per audio block and transfers it across.
   *
   * `data` is 3 voices × numFrames, frame-interleaved:
   * `[f0_v0, f0_v1, f0_v2, f1_v0, ...]`.
   * Do not mutate — other subscribers observe the same buffer.
   */
  onChannels(listener: ChannelsListener): () => void {
    this.channelListeners.add(listener);
    if (this.channelListeners.size === 1) {
      const msg: ToSndhWorkletMessage = { type: 'subscribeChannels' };
      this.node.port.postMessage(msg);
    }
    return () => {
      const wasPresent = this.channelListeners.delete(listener);
      if (wasPresent && this.channelListeners.size === 0) {
        const msg: ToSndhWorkletMessage = { type: 'unsubscribeChannels' };
        this.node.port.postMessage(msg);
      }
    };
  }

  private installMessageDispatcher(): void {
    this.node.port.onmessage = (ev: MessageEvent<FromSndhWorkletMessage>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'channels': {
          for (const cb of this.channelListeners) {
            cb(msg.data, msg.numFrames);
          }
          return;
        }
        case 'progress': {
          this.currentTimeSec = msg.currentTimeSec;
          this.durationSec = msg.durationSec;
          const info = {
            currentTimeSec: msg.currentTimeSec,
            durationSec: msg.durationSec,
          };
          for (const cb of this.progressListeners) cb(info);
          return;
        }
        case 'ended': {
          if (this.endedFired) return;
          this.endedFired = true;
          for (const cb of this.endedListeners) cb();
          return;
        }
        case 'error': {
          console.error('cawtooth SNDH worklet:', msg.message);
          return;
        }
        case 'ready':
          return;
      }
    };
  }
}
