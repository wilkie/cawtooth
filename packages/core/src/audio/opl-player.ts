import type { OplRegisterWrite } from '../chip/types.js';
import type { RegisterEventStream, RegisterStreamTiming } from '../sequencer/types.js';
import { OPL_PROCESSOR_NAME } from '../worklet/opl-processor-name.js';
import type { FromWorkletMessage, ToWorkletMessage } from '../worklet/messages.js';
import { Player, type OplPlayerInfo } from './player.js';

export interface OplPlayerOptions {
  /** URL to the bundled worklet script (dist/worklet/opl-processor.js). */
  workletUrl: string | URL;
  /** URL to the Nuked-OPL3 wasm module. */
  wasmUrl: string | URL;
  /** Optional existing AudioContext. If omitted, the player creates one. */
  audioContext?: AudioContext;
}

/**
 * Optional metadata to attach to the loaded stream. Surfaced via the
 * player's `info` getter so a generic UI can show title/composer/etc.
 * without knowing what container the bytes came from. CawtoothPlayer.load()
 * fills these in from the parsed song; standalone callers can pass them
 * explicitly or omit them entirely (defaults are empty strings).
 */
export interface OplLoadStreamMetadata {
  container?: 'imf' | 'dro' | 'herad' | 'unknown';
  variant?: string;
  title?: string;
  source?: string;
  remarks?: string;
}

/**
 * Callback invoked once per audio block while at least one channel subscription
 * is active.
 *
 * `data` is frame-interleaved per-voice PCM (18 voices × numFrames Float32).
 * The buffer is transferred from the worklet — ownership is shared among all
 * current subscribers for that one call. **Do not mutate `data`**; other
 * subscribers will observe the changes, and the buffer is discarded after the
 * callback chain returns.
 */
export type ChannelsListener = (data: Float32Array, numFrames: number) => void;

/**
 * Main-thread handle for driving the OPL worklet.
 *
 * Construction is async because we need to register the worklet module,
 * fetch and compile the wasm, ship the compiled module into the worklet,
 * and wait for it to report ready.
 */
export class OplPlayer extends Player {
  /**
   * Cached info for the most recent loadStream call. Starts as an empty
   * shell so `info` is always defined; gets filled in once a stream is
   * loaded. The mutable shape is internal — callers see a readonly view.
   */
  private _info: {
    -readonly [K in keyof OplPlayerInfo]: OplPlayerInfo[K];
  } = {
    format: 'opl',
    container: 'unknown',
    variant: '',
    title: '',
    source: '',
    remarks: '',
    tickRate: 0,
    events: 0,
    loop: false,
  };

  /** Current cached time / duration from the worklet's progress ticks. */
  private currentTimeSec = 0;
  private durationSec: number | null = null;
  private playing = false;
  /** Latches `ended` so we don't re-fire across listener-set churn. */
  private endedFired = false;

  private constructor(ctx: AudioContext, ownsContext: boolean, node: AudioWorkletNode) {
    super(ctx, ownsContext, node);
    this.installMessageDispatcher();
  }

  static async create(options: OplPlayerOptions): Promise<OplPlayer> {
    const ownsContext = !options.audioContext;
    const ctx = options.audioContext ?? new AudioContext();

    await ctx.audioWorklet.addModule(options.workletUrl.toString());

    // Worklets can't fetch(). Main thread fetches the raw bytes and hands
    // them to the worklet via a transferable ArrayBuffer — a pre-compiled
    // WebAssembly.Module can't cross the agent-cluster boundary into
    // AudioWorkletGlobalScope, so we compile on the worklet side.
    const wasmResp = await fetch(options.wasmUrl.toString());
    if (!wasmResp.ok) {
      throw new Error(`cawtooth: failed to fetch wasm: ${wasmResp.status} ${wasmResp.statusText}`);
    }
    const wasmBytes = await wasmResp.arrayBuffer();

    const node = new AudioWorkletNode(ctx, OPL_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            'cawtooth: worklet did not respond within 10s. ' +
              'The worklet processor may not have loaded, or the init message did not arrive.',
          ),
        );
      }, 10_000);

      node.port.onmessage = (ev: MessageEvent<FromWorkletMessage>) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          reject(new Error(`cawtooth worklet error: ${msg.message}`));
        }
      };

      node.port.onmessageerror = (ev) => {
        clearTimeout(timer);
        reject(new Error(`cawtooth: message deserialization failed: ${String(ev)}`));
      };
    });

    const initMsg: ToWorkletMessage = { type: 'init', wasmBytes };
    node.port.postMessage(initMsg, [wasmBytes]);
    await ready;

    return new OplPlayer(ctx, ownsContext, node);
  }

  get format(): 'opl' {
    return 'opl';
  }

  get info(): OplPlayerInfo {
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
    const msg: ToWorkletMessage = { type: 'write', reg, value };
    this.node.port.postMessage(msg);
  }

  writeRegisters(writes: readonly OplRegisterWrite[]): void {
    const msg: ToWorkletMessage = { type: 'writes', writes };
    this.node.port.postMessage(msg);
  }

  reset(): void {
    const msg: ToWorkletMessage = { type: 'reset' };
    this.node.port.postMessage(msg);
  }

  /**
   * Replace the sequencer's current event stream. Does not auto-play — call
   * `play()` to begin.
   *
   * The stream's typed arrays are structured-cloned across to the worklet, so
   * the caller's copy remains usable after this returns.
   *
   * `metadata` populates `info` so a UI can render title/composer/etc.
   * without knowing the source format. Defaults are empty strings.
   */
  loadStream(
    stream: RegisterEventStream,
    timing: RegisterStreamTiming,
    metadata?: OplLoadStreamMetadata,
  ): void {
    const msg: ToWorkletMessage = { type: 'loadStream', stream, timing };
    this.node.port.postMessage(msg);

    this._info.container = metadata?.container ?? 'unknown';
    this._info.variant = metadata?.variant ?? '';
    this._info.title = metadata?.title ?? '';
    this._info.source = metadata?.source ?? '';
    this._info.remarks = metadata?.remarks ?? '';
    this._info.tickRate = timing.tickRate;
    this._info.events = stream.regs.length;
    this._info.loop = timing.loop ?? false;

    // A new stream resets time + clears the ended latch.
    this.currentTimeSec = 0;
    this.durationSec = null;
    this.endedFired = false;
    this.playing = false;
  }

  play(): void {
    this.node.port.postMessage({ type: 'play' } satisfies ToWorkletMessage);
    this.playing = true;
  }

  pause(): void {
    this.node.port.postMessage({ type: 'pause' } satisfies ToWorkletMessage);
    this.playing = false;
  }

  stop(): void {
    this.node.port.postMessage({ type: 'stop' } satisfies ToWorkletMessage);
    this.playing = false;
    this.currentTimeSec = 0;
    this.endedFired = false;
  }

  /**
   * Subscribe to per-voice PCM taps. Returns an unsubscribe function.
   *
   * The first listener automatically activates per-voice output on the
   * worklet; the last to unsubscribe turns it off. While active, the worklet
   * allocates a fresh buffer per block and transfers it across — cheap enough
   * for visualization (oscilloscopes, FFT) at the full audio callback rate.
   */
  onChannels(listener: ChannelsListener): () => void {
    this.channelListeners.add(listener);
    if (this.channelListeners.size === 1) {
      const msg: ToWorkletMessage = { type: 'subscribeChannels' };
      this.node.port.postMessage(msg);
    }
    return () => {
      const wasPresent = this.channelListeners.delete(listener);
      if (wasPresent && this.channelListeners.size === 0) {
        const msg: ToWorkletMessage = { type: 'unsubscribeChannels' };
        this.node.port.postMessage(msg);
      }
    };
  }

  private installMessageDispatcher(): void {
    // Replaces the init-time onmessage handler (which only cared about
    // ready/error). From here on, the port carries channel-tap data and any
    // late-arriving errors.
    this.node.port.onmessage = (ev: MessageEvent<FromWorkletMessage>) => {
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
          // Note: `playing` is intentionally NOT flipped here. The chip
          // may still be sustaining notes from the last events, and the
          // user may want to keep audio flowing (e.g. so a tail-out is
          // captured) until they explicitly pause/stop. `ended` is a
          // signal, not a state transition.
          for (const cb of this.endedListeners) cb();
          return;
        }
        case 'error': {
          // Surface unexpected worklet-side errors to console rather than
          // silently dropping them.
          console.error('cawtooth worklet:', msg.message);
          return;
        }
        case 'ready':
          return;
      }
    };
  }
}
