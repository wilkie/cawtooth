import type { OplRegisterWrite } from '../chip/types.js';
import type { RegisterEventStream, RegisterStreamTiming } from '../sequencer/types.js';
import { OPL_PROCESSOR_NAME } from '../worklet/opl-processor-name.js';
import type { FromWorkletMessage, ToWorkletMessage } from '../worklet/messages.js';

export interface OplPlayerOptions {
  /** URL to the bundled worklet script (dist/worklet/opl-processor.js). */
  workletUrl: string | URL;
  /** URL to the Nuked-OPL3 wasm module. */
  wasmUrl: string | URL;
  /** Optional existing AudioContext. If omitted, the player creates one. */
  audioContext?: AudioContext;
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
export class OplPlayer {
  private readonly channelListeners = new Set<ChannelsListener>();

  private constructor(
    private readonly ctx: AudioContext,
    private readonly ownsContext: boolean,
    private readonly node: AudioWorkletNode,
  ) {
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

  get audioContext(): AudioContext {
    return this.ctx;
  }

  /** The worklet node. Route this wherever you like (analyser, gain, destination). */
  get output(): AudioWorkletNode {
    return this.node;
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
   */
  loadStream(stream: RegisterEventStream, timing: RegisterStreamTiming): void {
    const msg: ToWorkletMessage = { type: 'loadStream', stream, timing };
    this.node.port.postMessage(msg);
  }

  /** Begin / resume sequencer playback. */
  play(): void {
    const msg: ToWorkletMessage = { type: 'play' };
    this.node.port.postMessage(msg);
  }

  /** Halt sequencer time advancement. Chip state is preserved. */
  pause(): void {
    const msg: ToWorkletMessage = { type: 'pause' };
    this.node.port.postMessage(msg);
  }

  /** Stop sequencer, rewind to the start, and silence the chip. */
  stop(): void {
    const msg: ToWorkletMessage = { type: 'stop' };
    this.node.port.postMessage(msg);
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

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  async dispose(): Promise<void> {
    this.channelListeners.clear();
    try {
      this.node.disconnect();
    } catch {
      // Already disconnected — ignore.
    }
    this.node.port.close();
    if (this.ownsContext) {
      await this.ctx.close();
    }
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
