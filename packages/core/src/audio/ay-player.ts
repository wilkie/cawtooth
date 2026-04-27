import { type AyChipModel, AY_CLOCK_ZX } from '../chip/ayumi-chip.js';
import type { ChannelsListener } from './opl-player.js';
import { Player, type AyPlayerInfo } from './player.js';
import type { RegisterEventStream, RegisterStreamTiming } from '../sequencer/types.js';
import { AY_PROCESSOR_NAME } from '../worklet/ay-processor-name.js';
import type {
  AyRegisterWrite,
  FromAyWorkletMessage,
  ToAyWorkletMessage,
} from '../worklet/ay-messages.js';

export interface AyPlayerOptions {
  /** URL to the bundled AY worklet script (dist/worklet/ay-processor.js). */
  workletUrl: string | URL;
  /** URL to the Ayumi wasm module. */
  wasmUrl: string | URL;
  /** Optional existing AudioContext. If omitted, the player creates one. */
  audioContext?: AudioContext;
  /** Host clock frequency in Hz. Defaults to ZX Spectrum (1.7734 MHz). */
  clockFrequency?: number;
  /** Chip variant. Defaults to AY-3-8910. */
  model?: AyChipModel;
  /**
   * Per-channel pan position in [0, 1]. Defaults to ABC stereo
   * ([0.0, 0.5, 1.0]) — the standard ZX Spectrum convention.
   */
  pan?: readonly [number, number, number];
}

/**
 * Optional metadata to attach to the loaded stream. Surfaced via the
 * player's `info` getter so a generic UI can show title/author/etc.
 * without knowing what container the bytes came from. CawtoothPlayer.load()
 * fills these in from the parsed song; standalone callers can pass them
 * explicitly or omit them entirely (defaults are empty strings).
 */
export interface AyLoadStreamMetadata {
  container?: 'psg' | 'vtx' | 'ym' | 'asc' | 'unknown';
  variant?: string;
  title?: string;
  author?: string;
  comment?: string;
}

/**
 * Main-thread handle for driving the AY worklet.
 *
 * Two modes share one player:
 *   - **Direct register writes** (`writeRegister` / `writeRegisters` /
 *     `reset`) bypass the sequencer — used by the ay-tone demo and any
 *     other low-level register-pokers.
 *   - **Stream playback** (`loadStream` + `play` / `pause` / `stop`) feeds
 *     the worklet's RegisterSequencer for register-dump formats like
 *     `.psg`, `.vtx`, `.ym`. The transport surface inherited from
 *     `Player` only takes effect once a stream is loaded — calling
 *     `play()` with no stream loaded is a harmless no-op.
 *
 * After `create()` returns the player is **paused-at-zero** (no stream,
 * no audio production). Mirrors OplPlayer / PsidPlayer.
 */
export class AyPlayer extends Player {
  private readonly _info: {
    -readonly [K in keyof AyPlayerInfo]: AyPlayerInfo[K];
  };

  private currentTimeSec = 0;
  private durationSec: number | null = null;
  private playing = false;
  private endedFired = false;

  private constructor(
    ctx: AudioContext,
    ownsContext: boolean,
    node: AudioWorkletNode,
    info: AyPlayerInfo,
  ) {
    super(ctx, ownsContext, node);
    this._info = { ...info };
    this.installMessageDispatcher();
  }

  static async create(options: AyPlayerOptions): Promise<AyPlayer> {
    const ownsContext = !options.audioContext;
    const ctx = options.audioContext ?? new AudioContext();

    await ctx.audioWorklet.addModule(options.workletUrl.toString());

    const wasmResp = await fetch(options.wasmUrl.toString());
    if (!wasmResp.ok) {
      throw new Error(
        `cawtooth: failed to fetch AY wasm: ${wasmResp.status} ${wasmResp.statusText}`,
      );
    }
    const wasmBytes = await wasmResp.arrayBuffer();

    const node = new AudioWorkletNode(ctx, AY_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            'cawtooth: AY worklet did not respond within 10s. ' +
              'The worklet processor may not have loaded, or the init message did not arrive.',
          ),
        );
      }, 10_000);

      node.port.onmessage = (ev: MessageEvent<FromAyWorkletMessage>) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          reject(new Error(`cawtooth AY worklet error: ${msg.message}`));
        }
      };

      node.port.onmessageerror = (ev) => {
        clearTimeout(timer);
        reject(new Error(`cawtooth: message deserialization failed: ${String(ev)}`));
      };
    });

    const clockFrequency = options.clockFrequency ?? AY_CLOCK_ZX;
    const model = options.model ?? 'AY-3-8910';

    const initMsg: ToAyWorkletMessage = {
      type: 'init',
      wasmBytes,
      clockFrequency,
      model,
      pan: options.pan,
    };
    node.port.postMessage(initMsg, [wasmBytes]);
    await ready;

    const info: AyPlayerInfo = {
      format: 'ay',
      container: 'unknown',
      variant: '',
      title: '',
      author: '',
      comment: '',
      model,
      clockFrequency,
      tickRate: 0,
      events: 0,
      loop: false,
    };

    return new AyPlayer(ctx, ownsContext, node, info);
  }

  get format(): 'ay' {
    return 'ay';
  }

  get info(): AyPlayerInfo {
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

  writeRegister(reg: number, value: number): void {
    const msg: ToAyWorkletMessage = { type: 'write', reg, value };
    this.node.port.postMessage(msg);
  }

  writeRegisters(writes: readonly AyRegisterWrite[]): void {
    const msg: ToAyWorkletMessage = { type: 'writes', writes };
    this.node.port.postMessage(msg);
  }

  reset(): void {
    const msg: ToAyWorkletMessage = { type: 'reset' };
    this.node.port.postMessage(msg);
  }

  /**
   * Replace the sequencer's current event stream. Does not auto-play —
   * call `play()` to begin. The stream's typed arrays are
   * structured-cloned across to the worklet, so the caller's copy
   * remains usable after this returns.
   *
   * `metadata` populates `info` so a UI can render title/author/etc.
   * without knowing the source format.
   */
  loadStream(
    stream: RegisterEventStream,
    timing: RegisterStreamTiming,
    metadata?: AyLoadStreamMetadata,
  ): void {
    const msg: ToAyWorkletMessage = { type: 'loadStream', stream, timing };
    this.node.port.postMessage(msg);

    this._info.container = metadata?.container ?? 'unknown';
    this._info.variant = metadata?.variant ?? '';
    this._info.title = metadata?.title ?? '';
    this._info.author = metadata?.author ?? '';
    this._info.comment = metadata?.comment ?? '';
    this._info.tickRate = timing.tickRate;
    this._info.events = stream.regs.length;
    this._info.loop = timing.loop ?? false;

    this.currentTimeSec = 0;
    this.durationSec = null;
    this.endedFired = false;
    this.playing = false;
  }

  play(): void {
    this.node.port.postMessage({ type: 'play' } satisfies ToAyWorkletMessage);
    this.playing = true;
  }

  pause(): void {
    this.node.port.postMessage({ type: 'pause' } satisfies ToAyWorkletMessage);
    this.playing = false;
  }

  stop(): void {
    this.node.port.postMessage({ type: 'stop' } satisfies ToAyWorkletMessage);
    this.playing = false;
    this.currentTimeSec = 0;
    this.endedFired = false;
  }

  /**
   * Subscribe to per-voice PCM taps. Returns an unsubscribe function.
   * 3 voices × numFrames, frame-interleaved. Same shape as SidPlayer's
   * channel taps; same auto-subscribe-first / auto-unsubscribe-last
   * lifecycle.
   */
  onChannels(listener: ChannelsListener): () => void {
    this.channelListeners.add(listener);
    if (this.channelListeners.size === 1) {
      const msg: ToAyWorkletMessage = { type: 'subscribeChannels' };
      this.node.port.postMessage(msg);
    }
    return () => {
      const wasPresent = this.channelListeners.delete(listener);
      if (wasPresent && this.channelListeners.size === 0) {
        const msg: ToAyWorkletMessage = { type: 'unsubscribeChannels' };
        this.node.port.postMessage(msg);
      }
    };
  }

  private installMessageDispatcher(): void {
    this.node.port.onmessage = (ev: MessageEvent<FromAyWorkletMessage>) => {
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
          console.error('cawtooth AY worklet:', msg.message);
          return;
        }
        case 'ready':
          return;
      }
    };
  }
}
