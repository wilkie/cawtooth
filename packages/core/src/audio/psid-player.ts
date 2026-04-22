import type { SidChipModel, SidSamplingMethod } from '../chip/resid-sid.js';
import type { ChannelsListener } from './opl-player.js';
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

/** Metadata and active-subsong info surfaced from the PSID header on ready. */
export interface PsidPlaybackInfo {
  name: string;
  author: string;
  released: string;
  songs: number;
  subsong: number;
  model: SidChipModel;
  clockFrequency: number;
  /** CPU cycles between play-routine calls (vblank or CIA-driven). */
  playInterval: number;
}

/**
 * Main-thread handle for PSID playback through the sidplay AudioWorklet.
 *
 * Parallel to OplPlayer / SidPlayer: registers the worklet module, fetches
 * + transfers the wasm bytes and the .sid bytes, waits for the worklet to
 * finish parsing and initializing the tune, then surfaces the metadata.
 */
export class PsidPlayer {
  private readonly channelListeners = new Set<ChannelsListener>();

  private constructor(
    private readonly ctx: AudioContext,
    private readonly ownsContext: boolean,
    private readonly node: AudioWorkletNode,
    readonly info: PsidPlaybackInfo,
  ) {
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
    const info: PsidPlaybackInfo = {
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

  get audioContext(): AudioContext {
    return this.ctx;
  }

  get output(): AudioWorkletNode {
    return this.node;
  }

  /**
   * Switch to a different subsong (1-based). Updates `info.subsong` so
   * consumers reading the field see current state rather than whichever
   * subsong the player started on.
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
    this.info.subsong = subsong;
  }

  /** Halt playback and silence the chip. */
  stop(): void {
    const msg: ToPsidWorkletMessage = { type: 'stop' };
    this.node.port.postMessage(msg);
  }

  /**
   * Resume playback after stop. Note: this doesn't re-run init, so the
   * tune picks up from wherever its play routine's internal state was.
   * For a true restart, call `selectSong(currentSubsong)` instead.
   */
  resume(): void {
    const msg: ToPsidWorkletMessage = { type: 'resume' };
    this.node.port.postMessage(msg);
  }

  /**
   * Subscribe to per-voice PCM taps. Returns an unsubscribe function.
   *
   * The first listener activates per-voice output on the worklet; the
   * last to unsubscribe turns it off. While active, the worklet allocates
   * a fresh Float32 buffer per audio block and transfers it across —
   * cheap enough for scope / FFT visualization at the audio block rate.
   *
   * `data` is 3 voices × numFrames, frame-interleaved:
   * `[f0_v0, f0_v1, f0_v2, f1_v0, ...]`. Do not mutate — other
   * subscribers observe the same buffer for that one call.
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
    this.node.port.onmessage = (ev: MessageEvent<FromPsidWorkletMessage>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'channels': {
          for (const cb of this.channelListeners) {
            cb(msg.data, msg.numFrames);
          }
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
