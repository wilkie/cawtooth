import type { SidChipModel, SidSamplingMethod } from '../chip/resid-sid.js';
import type { ChannelsListener } from './opl-player.js';
import { Player, type PsidPlayerInfo } from './player.js';
import { parsePsid } from '../formats/psid/parser.js';
import type { PsidSong } from '../formats/psid/types.js';
import { PSID_PROCESSOR_NAME } from '../worklet/psid-processor-name.js';
import type {
  FromPsidWorkletMessage,
  PsidReadyMessage,
  ToPsidWorkletMessage,
} from '../worklet/psid-messages.js';

export interface PsidPlayerCreateOptions {
  /** URL of the bundled PSID worklet script (dist/worklet/psid-processor.js). */
  workletUrl: string | URL;
  /** URL of the sidplay wasm module (packages/core/wasm/sidplay.wasm). */
  wasmUrl: string | URL;
  /**
   * Raw .sid file bytes OR an already-parsed PsidSong. Raw bytes are
   * parsed on the main thread (AudioWorkletGlobalScope doesn't reliably
   * expose TextDecoder, which the parser needs for Windows-1252 strings).
   */
  sidBytes?: ArrayBuffer;
  song?: PsidSong;
  /** Optional existing AudioContext. Player creates one if omitted. */
  audioContext?: AudioContext;
  /** Explicit model override. Defaults to the PSID flag's hint. */
  model?: SidChipModel;
  /** Explicit clock override. Defaults to PAL for PAL/unknown, NTSC for NTSC. */
  clockFrequency?: number;
  /** reSID sampling method. Defaults to 'resample'. */
  samplingMethod?: SidSamplingMethod;
  /** Subsong to start on. 1-based; defaults to PSID startSong. */
  subsong?: number;
}

/**
 * Main-thread handle for PSID playback through the sidplay AudioWorklet.
 *
 * Like every cawtooth player, the player is **paused-at-zero** after
 * `create()` returns. The caller must call `play()` to start audio. This
 * matches `OplPlayer` and `CawtoothPlayer.load()` so a generic UI can
 * always issue the same `resumeAudio() → play()` sequence on a user gesture.
 */
export class PsidPlayer extends Player {
  /**
   * Mutable internal copy of the playback info. The public `info` getter
   * exposes a readonly view. `subsong` is updated on `selectSong`; the
   * other fields are immutable for the life of the player (they describe
   * the loaded tune, which doesn't change without disposing + recreating).
   */
  private readonly _info: {
    -readonly [K in keyof PsidPlayerInfo]: PsidPlayerInfo[K];
  };

  private currentTimeSec = 0;
  private durationSec: number | null = null;
  private playing = false;
  private endedFired = false;

  private constructor(
    ctx: AudioContext,
    ownsContext: boolean,
    node: AudioWorkletNode,
    info: PsidPlayerInfo,
  ) {
    super(ctx, ownsContext, node);
    this._info = { ...info };
    this.installMessageDispatcher();
  }

  static async create(options: PsidPlayerCreateOptions): Promise<PsidPlayer> {
    const ownsContext = !options.audioContext;
    const ctx = options.audioContext ?? new AudioContext();

    const song =
      options.song ??
      (options.sidBytes
        ? parsePsid(new Uint8Array(options.sidBytes))
        : (() => {
            throw new Error('cawtooth: PsidPlayer.create requires either sidBytes or song');
          })());

    await ctx.audioWorklet.addModule(options.workletUrl.toString());

    const wasmResp = await fetch(options.wasmUrl.toString());
    if (!wasmResp.ok) {
      throw new Error(
        `cawtooth: failed to fetch sidplay wasm: ${wasmResp.status} ${wasmResp.statusText}`,
      );
    }
    const wasmBytes = await wasmResp.arrayBuffer();

    const node = new AudioWorkletNode(ctx, PSID_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const ready = new Promise<PsidReadyMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            'cawtooth: PSID worklet did not respond within 10s. ' +
              'The worklet processor may not have loaded, or the init message did not arrive.',
          ),
        );
      }, 10_000);

      node.port.onmessage = (ev: MessageEvent<FromPsidWorkletMessage>) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve(msg);
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          reject(new Error(`cawtooth PSID worklet error: ${msg.message}`));
        }
      };

      node.port.onmessageerror = (ev) => {
        clearTimeout(timer);
        reject(new Error(`cawtooth: message deserialization failed: ${String(ev)}`));
      };
    });

    const initMsg: ToPsidWorkletMessage = {
      type: 'init',
      wasmBytes,
      song,
      model: options.model,
      clockFrequency: options.clockFrequency,
      samplingMethod: options.samplingMethod,
      subsong: options.subsong,
    };
    // Only wasmBytes is transferred; the parsed song rides a structured
    // clone (its Uint8Array payload is copied into the worklet's heap).
    node.port.postMessage(initMsg, [wasmBytes]);

    const ready_ = await ready;
    const info: PsidPlayerInfo = {
      format: 'psid',
      name: ready_.name,
      author: ready_.author,
      released: ready_.released,
      songs: ready_.songs,
      subsong: ready_.subsong,
      model: ready_.model,
      clockFrequency: ready_.clockFrequency,
      playInterval: ready_.playInterval,
    };
    return new PsidPlayer(ctx, ownsContext, node, info);
  }

  get format(): 'psid' {
    return 'psid';
  }

  get info(): PsidPlayerInfo {
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
   * `playing` / `paused` state — switching while playing keeps playing,
   * switching while paused stays paused.
   *
   * Note: `info.playInterval` is NOT re-queried from the worklet after a
   * subsong change, even though CIA-speed subsongs can have different
   * timer periods. Consumers that need the exact post-switch interval
   * should recompute it (parse the PSID header locally) or wait until
   * we add a post-init ack message.
   */
  selectSong(subsong: number): void {
    const msg: ToPsidWorkletMessage = { type: 'selectSong', subsong };
    this.node.port.postMessage(msg);
    this._info.subsong = subsong;
    this.currentTimeSec = 0;
    this.endedFired = false;
  }

  play(): void {
    this.node.port.postMessage({ type: 'play' } satisfies ToPsidWorkletMessage);
    this.playing = true;
  }

  pause(): void {
    this.node.port.postMessage({ type: 'pause' } satisfies ToPsidWorkletMessage);
    this.playing = false;
  }

  stop(): void {
    this.node.port.postMessage({ type: 'stop' } satisfies ToPsidWorkletMessage);
    this.playing = false;
    this.currentTimeSec = 0;
    this.endedFired = false;
  }

  /**
   * Tell the worklet how long the currently-initialized subsong is (in
   * seconds). The worklet fires `ended` once elapsed audio reaches this
   * threshold. Pass `null` to clear — the most common case being "HVSC
   * Songlengths isn't loaded yet, so we don't know".
   *
   * Idempotent; overwrites any previous value.
   */
  setSubsongDurationSec(sec: number | null): void {
    this.node.port.postMessage({ type: 'setDuration', durationSec: sec });
    this.durationSec = sec;
    // A new duration may "uncross" the end boundary — let `ended` fire
    // again if/when the new threshold is reached.
    this.endedFired = false;
  }

  /**
   * Subscribe to per-voice PCM taps. Returns an unsubscribe function.
   *
   * The first listener activates per-voice output on the worklet; the
   * last to unsubscribe turns it off. While active, the worklet allocates
   * a fresh Float32 buffer per audio block and transfers it across —
   * cheap enough for scope / FFT visualization at the audio block rate.
   *
   * `data` is 9 voices × numFrames, frame-interleaved:
   * `[f0_sid1_v1, f0_sid1_v2, f0_sid1_v3, f0_sid2_v1, ..., f0_sid3_v3,
   *   f1_sid1_v1, ...]`. Single-/dual-SID tunes zero-fill unused slots.
   * Do not mutate — other subscribers observe the same buffer.
   */
  onChannels(listener: ChannelsListener): () => void {
    this.channelListeners.add(listener);
    if (this.channelListeners.size === 1) {
      const msg: ToPsidWorkletMessage = { type: 'subscribeChannels' };
      this.node.port.postMessage(msg);
    }
    return () => {
      const wasPresent = this.channelListeners.delete(listener);
      if (wasPresent && this.channelListeners.size === 0) {
        const msg: ToPsidWorkletMessage = { type: 'unsubscribeChannels' };
        this.node.port.postMessage(msg);
      }
    };
  }

  private installMessageDispatcher(): void {
    this.node.port.onmessage = (ev: MessageEvent<FromPsidWorkletMessage>) => {
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
          console.error('cawtooth PSID worklet:', msg.message);
          return;
        }
        case 'ready':
          return;
      }
    };
  }
}
