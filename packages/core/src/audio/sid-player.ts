import { SID_CLOCK_PAL, type SidChipModel, type SidSamplingMethod } from '../chip/resid-sid.js';
import type { ChannelsListener } from './opl-player.js';
import { SID_PROCESSOR_NAME } from '../worklet/sid-processor-name.js';
import type {
  FromSidWorkletMessage,
  SidRegisterWrite,
  ToSidWorkletMessage,
} from '../worklet/sid-messages.js';

export interface SidPlayerOptions {
  /** URL to the bundled SID worklet script (dist/worklet/sid-processor.js). */
  workletUrl: string | URL;
  /** URL to the reSID wasm module. */
  wasmUrl: string | URL;
  /** Optional existing AudioContext. If omitted, the player creates one. */
  audioContext?: AudioContext;
  /** Host clock frequency in Hz. Defaults to PAL C64 (985248). */
  clockFrequency?: number;
  /** Chip revision. Defaults to MOS6581. */
  model?: SidChipModel;
  /** reSID resampling quality. Defaults to 'resample'. */
  samplingMethod?: SidSamplingMethod;
}

/**
 * Main-thread handle for driving the SID worklet.
 *
 * Parallel to OplPlayer: registers the worklet module, ships the wasm bytes
 * across the agent-cluster boundary via a transferable ArrayBuffer, waits
 * for the worklet to report ready, then exposes register-write and reset
 * message passing. SID format playback lives at a higher layer — this class
 * is deliberately minimal so the tone example and future players can share
 * the same audio path.
 */
export class SidPlayer {
  private readonly channelListeners = new Set<ChannelsListener>();

  private constructor(
    private readonly ctx: AudioContext,
    private readonly ownsContext: boolean,
    private readonly node: AudioWorkletNode,
  ) {
    this.installMessageDispatcher();
  }

  static async create(options: SidPlayerOptions): Promise<SidPlayer> {
    const ownsContext = !options.audioContext;
    const ctx = options.audioContext ?? new AudioContext();

    await ctx.audioWorklet.addModule(options.workletUrl.toString());

    const wasmResp = await fetch(options.wasmUrl.toString());
    if (!wasmResp.ok) {
      throw new Error(
        `cawtooth: failed to fetch SID wasm: ${wasmResp.status} ${wasmResp.statusText}`,
      );
    }
    const wasmBytes = await wasmResp.arrayBuffer();

    const node = new AudioWorkletNode(ctx, SID_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            'cawtooth: SID worklet did not respond within 10s. ' +
              'The worklet processor may not have loaded, or the init message did not arrive.',
          ),
        );
      }, 10_000);

      node.port.onmessage = (ev: MessageEvent<FromSidWorkletMessage>) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          reject(new Error(`cawtooth SID worklet error: ${msg.message}`));
        }
      };

      node.port.onmessageerror = (ev) => {
        clearTimeout(timer);
        reject(new Error(`cawtooth: message deserialization failed: ${String(ev)}`));
      };
    });

    const initMsg: ToSidWorkletMessage = {
      type: 'init',
      wasmBytes,
      clockFrequency: options.clockFrequency ?? SID_CLOCK_PAL,
      model: options.model ?? 'MOS6581',
      samplingMethod: options.samplingMethod ?? 'resample',
    };
    node.port.postMessage(initMsg, [wasmBytes]);
    await ready;

    return new SidPlayer(ctx, ownsContext, node);
  }

  get audioContext(): AudioContext {
    return this.ctx;
  }

  get output(): AudioWorkletNode {
    return this.node;
  }

  writeRegister(reg: number, value: number): void {
    const msg: ToSidWorkletMessage = { type: 'write', reg, value };
    this.node.port.postMessage(msg);
  }

  writeRegisters(writes: readonly SidRegisterWrite[]): void {
    const msg: ToSidWorkletMessage = { type: 'writes', writes };
    this.node.port.postMessage(msg);
  }

  reset(): void {
    const msg: ToSidWorkletMessage = { type: 'reset' };
    this.node.port.postMessage(msg);
  }

  /**
   * Subscribe to per-voice PCM taps for scope / analysis. Returns an
   * unsubscribe function. Channels buffer is 3 voices × numFrames,
   * frame-interleaved ([f0_v0, f0_v1, f0_v2, f1_v0, ...]). Same shape
   * as OplPlayer.onChannels / PsidPlayer.onChannels.
   */
  onChannels(listener: ChannelsListener): () => void {
    this.channelListeners.add(listener);
    if (this.channelListeners.size === 1) {
      const msg: ToSidWorkletMessage = { type: 'subscribeChannels' };
      this.node.port.postMessage(msg);
    }
    return () => {
      const wasPresent = this.channelListeners.delete(listener);
      if (wasPresent && this.channelListeners.size === 0) {
        const msg: ToSidWorkletMessage = { type: 'unsubscribeChannels' };
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
    this.node.port.onmessage = (ev: MessageEvent<FromSidWorkletMessage>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'channels': {
          for (const cb of this.channelListeners) {
            cb(msg.data, msg.numFrames);
          }
          return;
        }
        case 'error': {
          console.error('cawtooth SID worklet:', msg.message);
          return;
        }
        case 'ready':
          return;
      }
    };
  }
}
