import { NukedOpl3Chip } from '../chip/nuked-opl3.js';
import { createNukedOpl3Imports } from '../chip/loader.js';
import type { ToWorkletMessage, FromWorkletMessage } from './messages.js';
import { OPL_PROCESSOR_NAME } from './opl-processor-name.js';

class CawtoothOplProcessor extends AudioWorkletProcessor {
  private chip: NukedOpl3Chip | null = null;
  private interleaved: Float32Array | null = null;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToWorkletMessage>) => this.handle(ev.data);
  }

  private post(msg: FromWorkletMessage): void {
    this.port.postMessage(msg);
  }

  private handle(msg: ToWorkletMessage): void {
    switch (msg.type) {
      case 'init': {
        try {
          const instance = new WebAssembly.Instance(msg.module, createNukedOpl3Imports());
          this.chip = new NukedOpl3Chip(instance, sampleRate);
          this.post({ type: 'ready' });
        } catch (err) {
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

registerProcessor(OPL_PROCESSOR_NAME, CawtoothOplProcessor);
