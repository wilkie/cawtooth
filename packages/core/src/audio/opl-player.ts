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

    console.log('[cawtooth] loading worklet module:', options.workletUrl.toString());
    await ctx.audioWorklet.addModule(options.workletUrl.toString());
    console.log('[cawtooth] worklet module loaded');

    // Worklets can't fetch(). Main thread fetches the raw bytes and hands
    // them to the worklet via a transferable ArrayBuffer — a pre-compiled
    // WebAssembly.Module can't cross the agent-cluster boundary into
    // AudioWorkletGlobalScope, so we compile on the worklet side.
    console.log('[cawtooth] fetching wasm:', options.wasmUrl.toString());
    const wasmResp = await fetch(options.wasmUrl.toString());
    if (!wasmResp.ok) {
      throw new Error(`cawtooth: failed to fetch wasm: ${wasmResp.status} ${wasmResp.statusText}`);
    }
    const wasmBytes = await wasmResp.arrayBuffer();
    console.log('[cawtooth] wasm fetched, bytes=', wasmBytes.byteLength);

    const node = new AudioWorkletNode(ctx, OPL_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    console.log('[cawtooth] AudioWorkletNode created');

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            'cawtooth: worklet did not respond within 10s. ' +
              'The worklet processor may not have loaded, or the init message did not arrive. ' +
              'Check the browser console for worklet-side errors.',
          ),
        );
      }, 10_000);

      // Using onmessage (not addEventListener) so the port is implicitly
      // started without a separate .start() call.
      node.port.onmessage = (ev: MessageEvent<FromWorkletMessage>) => {
        const msg = ev.data;
        console.log('[cawtooth] message from worklet:', msg);
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
    console.log('[cawtooth] posting init to worklet (transferring wasm bytes)');
    node.port.postMessage(initMsg, [wasmBytes]);
    await ready;
    console.log('[cawtooth] worklet ready');

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
