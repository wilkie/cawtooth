import { AyumiChip, AY_VOICE_COUNT } from '../chip/ayumi-chip.js';
import { createAyumiImports } from '../chip/ayumi-loader.js';
import type { ToAyWorkletMessage, FromAyWorkletMessage } from './ay-messages.js';
import { AY_PROCESSOR_NAME } from './ay-processor-name.js';

class CawtoothAyProcessor extends AudioWorkletProcessor {
  private chip: AyumiChip | null = null;
  private interleaved: Float32Array | null = null;
  private channelsSubscribed = false;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToAyWorkletMessage>) => this.handle(ev.data);
  }

  private post(msg: FromAyWorkletMessage, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
      this.port.postMessage(msg, transfer);
    } else {
      this.port.postMessage(msg);
    }
  }

  private handle(msg: ToAyWorkletMessage): void {
    switch (msg.type) {
      case 'init': {
        try {
          const module = new WebAssembly.Module(msg.wasmBytes);
          const instance = new WebAssembly.Instance(module, createAyumiImports());
          this.chip = new AyumiChip(instance, {
            sampleRate,
            clockFrequency: msg.clockFrequency,
            model: msg.model,
            pan: msg.pan,
          });
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
      case 'subscribeChannels': {
        this.channelsSubscribed = true;
        return;
      }
      case 'unsubscribeChannels': {
        this.channelsSubscribed = false;
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
    const scratch = this.interleaved.subarray(0, interleavedLen);

    if (this.channelsSubscribed) {
      // Fresh allocation per block so we can transfer zero-copy.
      const channels = new Float32Array(numFrames * AY_VOICE_COUNT);
      this.chip.generateWithChannels(scratch, channels);
      this.post({ type: 'channels', data: channels, numFrames }, [channels.buffer]);
    } else {
      this.chip.generate(scratch);
    }

    // Ayumi natively produces stereo (it has a per-channel pan stage),
    // so we de-interleave the scratch into the worklet's planar L/R.
    for (let i = 0, j = 0; i < numFrames; i++, j += 2) {
      left[i] = scratch[j];
      right[i] = scratch[j + 1];
    }
    return true;
  }
}

registerProcessor(AY_PROCESSOR_NAME, CawtoothAyProcessor);
