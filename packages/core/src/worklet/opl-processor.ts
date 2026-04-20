import { NukedOpl3Chip } from '../chip/nuked-opl3.js';
import { createNukedOpl3Imports } from '../chip/loader.js';
import type { ToWorkletMessage, FromWorkletMessage } from './messages.js';
import { OPL_PROCESSOR_NAME } from './opl-processor-name.js';

console.log('[cawtooth worklet] module loaded at top level');

class CawtoothOplProcessor extends AudioWorkletProcessor {
  private chip: NukedOpl3Chip | null = null;
  private interleaved: Float32Array | null = null;

  constructor() {
    super();
    console.log('[cawtooth worklet] processor constructed, sampleRate=', sampleRate);
    this.port.onmessage = (ev: MessageEvent<ToWorkletMessage>) => {
      console.log('[cawtooth worklet] message received:', ev.data?.type);
      this.handle(ev.data);
    };
    this.port.onmessageerror = (ev) => {
      console.error('[cawtooth worklet] messageerror:', ev);
    };
  }

  private post(msg: FromWorkletMessage): void {
    console.log('[cawtooth worklet] posting back:', msg.type);
    this.port.postMessage(msg);
  }

  private handle(msg: ToWorkletMessage): void {
    switch (msg.type) {
      case 'init': {
        try {
          console.log('[cawtooth worklet] compiling wasm, bytes=', msg.wasmBytes.byteLength);
          const module = new WebAssembly.Module(msg.wasmBytes);
          console.log('[cawtooth worklet] instantiating wasm');
          const instance = new WebAssembly.Instance(module, createNukedOpl3Imports());
          console.log('[cawtooth worklet] creating chip');
          this.chip = new NukedOpl3Chip(instance, sampleRate);
          console.log('[cawtooth worklet] chip ready');
          this.post({ type: 'ready' });
        } catch (err) {
          console.error('[cawtooth worklet] init failed:', err);
          this.post({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'write': {
        this.chip?.writeRegister(msg.reg, msg.value);
        return;
      }
      case 'writes': {
        const chip = this.chip;
        if (!chip) return;
        for (const w of msg.writes) {
          chip.writeRegister(w.reg, w.value);
        }
        return;
      }
      case 'reset': {
        this.chip?.reset();
        return;
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length < 2 || !this.chip) {
      return true;
    }

    const left = output[0];
    const right = output[1];
    const numFrames = left.length;
    const interleavedLen = numFrames * 2;

    if (!this.interleaved || this.interleaved.length < interleavedLen) {
      this.interleaved = new Float32Array(interleavedLen);
    }
    const scratch = this.interleaved;

    this.chip.generate(scratch.subarray(0, interleavedLen));

    for (let i = 0, j = 0; i < numFrames; i++, j += 2) {
      left[i] = scratch[j];
      right[i] = scratch[j + 1];
    }
    return true;
  }
}

try {
  registerProcessor(OPL_PROCESSOR_NAME, CawtoothOplProcessor);
  console.log('[cawtooth worklet] registerProcessor OK:', OPL_PROCESSOR_NAME);
} catch (err) {
  console.error('[cawtooth worklet] registerProcessor failed:', err);
}
