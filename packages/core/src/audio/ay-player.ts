import { type AyChipModel, AY_CLOCK_ZX } from '../chip/ayumi-chip.js';
import type { ChannelsListener } from './opl-player.js';
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
 * Main-thread handle for driving the AY worklet.
 *
 * Parallel to SidPlayer: a low-level register-write surface for the
 * AY-3-8910 / YM2149 chip emulator, deliberately minimal so the AY-tone
 * example and (eventually) AY format players can share the same audio
 * path. Format-aware playback will land in a follow-up phase that adds
 * `loadStream` (for register-dump formats like .vtx, .ym, .psg) and
 * possibly a separate AyTunePlayer for Z80-bytecode .ay files.
 *
 * AyPlayer does NOT extend the abstract `Player` base — it has no
 * concept of a tune, transport, or progress. The Phase 2 register-dump
 * support will combine these surfaces into one class (the OplPlayer
 * pattern).
 */
export class AyPlayer {
  private readonly channelListeners = new Set<ChannelsListener>();

  private constructor(
    private readonly ctx: AudioContext,
    private readonly ownsContext: boolean,
    private readonly node: AudioWorkletNode,
  ) {
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

    const initMsg: ToAyWorkletMessage = {
      type: 'init',
      wasmBytes,
      clockFrequency: options.clockFrequency ?? AY_CLOCK_ZX,
      model: options.model ?? 'AY-3-8910',
      pan: options.pan,
    };
    node.port.postMessage(initMsg, [wasmBytes]);
    await ready;

    return new AyPlayer(ctx, ownsContext, node);
  }

  get audioContext(): AudioContext {
    return this.ctx;
  }

  get output(): AudioWorkletNode {
    return this.node;
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

  async resumeAudio(): Promise<void> {
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
    this.node.port.onmessage = (ev: MessageEvent<FromAyWorkletMessage>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'channels': {
          for (const cb of this.channelListeners) {
            cb(msg.data, msg.numFrames);
          }
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
