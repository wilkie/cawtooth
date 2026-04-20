import type { OplRegisterWrite } from '../chip/types.js';
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
 * Main-thread handle for driving the OPL worklet.
 *
 * Construction is async because we need to register the worklet module,
 * fetch and compile the wasm, ship the compiled module into the worklet,
 * and wait for it to report ready.
 */
export class OplPlayer {
  private constructor(
    private readonly ctx: AudioContext,
    private readonly ownsContext: boolean,
    private readonly node: AudioWorkletNode,
  ) {}

  static async create(options: OplPlayerOptions): Promise<OplPlayer> {
    const ownsContext = !options.audioContext;
    const ctx = options.audioContext ?? new AudioContext();

    await ctx.audioWorklet.addModule(options.workletUrl.toString());

    // Worklets can't fetch() — the main thread fetches and compiles, then
    // transfers the compiled WebAssembly.Module to the worklet.
    const wasmResp = await fetch(options.wasmUrl.toString());
    if (!wasmResp.ok) {
      throw new Error(`cawtooth: failed to fetch wasm: ${wasmResp.status} ${wasmResp.statusText}`);
    }
    const wasmModule =
      'compileStreaming' in WebAssembly
        ? await WebAssembly.compileStreaming(wasmResp)
        : await WebAssembly.compile(await wasmResp.arrayBuffer());

    const node = new AudioWorkletNode(ctx, OPL_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const ready = new Promise<void>((resolve, reject) => {
      const onMessage = (ev: MessageEvent<FromWorkletMessage>) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          node.port.removeEventListener('message', onMessage as EventListener);
          resolve();
        } else if (msg.type === 'error') {
          node.port.removeEventListener('message', onMessage as EventListener);
          reject(new Error(`cawtooth worklet error: ${msg.message}`));
        }
      };
      node.port.addEventListener('message', onMessage as EventListener);
      node.port.start();
    });

    const initMsg: ToWorkletMessage = { type: 'init', module: wasmModule };
    node.port.postMessage(initMsg);
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

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  async dispose(): Promise<void> {
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
}
