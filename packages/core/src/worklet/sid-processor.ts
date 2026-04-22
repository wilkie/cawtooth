import { SidChip, SID_VOICE_COUNT } from '../chip/resid-sid.js';
import { createReSidImports } from '../chip/resid-loader.js';
import type { ToSidWorkletMessage, FromSidWorkletMessage } from './sid-messages.js';
import { SID_PROCESSOR_NAME } from './sid-processor-name.js';

class CawtoothSidProcessor extends AudioWorkletProcessor {
  private chip: SidChip | null = null;
  private interleaved: Float32Array | null = null;
  private channelsSubscribed = false;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToSidWorkletMessage>) => this.handle(ev.data);
  }

  private post(msg: FromSidWorkletMessage, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
      this.port.postMessage(msg, transfer);
    } else {
      this.port.postMessage(msg);
    }
  }

  private handle(msg: ToSidWorkletMessage): void {
    switch (msg.type) {
      case 'init': {
        try {
          const module = new WebAssembly.Module(msg.wasmBytes);
          const instance = new WebAssembly.Instance(module, createReSidImports());
          this.chip = new SidChip(instance, {
            sampleRate,
            clockFrequency: msg.clockFrequency,
            model: msg.model,
            samplingMethod: msg.samplingMethod,
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
      const channels = new Float32Array(numFrames * SID_VOICE_COUNT);
      this.chip.generateWithChannels(scratch, channels);
      this.post({ type: 'channels', data: channels, numFrames }, [channels.buffer]);
    } else {
      this.chip.generate(scratch);
    }

    // SidChip duplicates its mono sample into both stereo lanes, so both
    // output channels get the same data.
    for (let i = 0, j = 0; i < numFrames; i++, j += 2) {
      left[i] = scratch[j];
      right[i] = scratch[j + 1];
    }
    return true;
  }
}

registerProcessor(SID_PROCESSOR_NAME, CawtoothSidProcessor);
