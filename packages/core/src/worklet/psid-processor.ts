import { PSID_MAX_VOICE_COUNT, SidTune } from '../formats/psid/runtime.js';
import { createSidplayImports } from '../formats/psid/sidplay-loader.js';
import type {
  FromPsidWorkletMessage,
  ToPsidWorkletMessage,
} from './psid-messages.js';
import { PSID_PROCESSOR_NAME } from './psid-processor-name.js';

class CawtoothPsidProcessor extends AudioWorkletProcessor {
  private tune: SidTune | null = null;
  private interleaved: Float32Array | null = null;
  private playing = true;
  private channelsSubscribed = false;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToPsidWorkletMessage>) => this.handle(ev.data);
  }

  private post(msg: FromPsidWorkletMessage, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
      this.port.postMessage(msg, transfer);
    } else {
      this.port.postMessage(msg);
    }
  }

  private handle(msg: ToPsidWorkletMessage): void {
    switch (msg.type) {
      case 'init': {
        try {
          const module = new WebAssembly.Module(msg.wasmBytes);
          const instance = new WebAssembly.Instance(module, createSidplayImports());
          this.tune?.dispose();
          this.tune = new SidTune(instance, msg.song, {
            sampleRate,
            model: msg.model,
            clockFrequency: msg.clockFrequency,
            samplingMethod: msg.samplingMethod,
          });
          const subsong = msg.subsong ?? msg.song.startSong;
          this.tune.initSong(subsong);
          this.playing = true;
          this.post({
            type: 'ready',
            name: msg.song.name,
            author: msg.song.author,
            released: msg.song.released,
            songs: msg.song.songs,
            subsong,
            model: this.tune.model,
            clockFrequency: this.tune.clockFrequency,
            playInterval: this.tune.effectivePlayInterval,
          });
        } catch (err) {
          this.post({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'selectSong': {
        try {
          this.tune?.initSong(msg.subsong);
          this.playing = true;
        } catch (err) {
          this.post({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'stop': {
        this.playing = false;
        // Reset the SID so the chip is silent while we're stopped.
        this.tune?.resetSid();
        return;
      }
      case 'resume': {
        this.playing = true;
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
    if (!output || output.length < 2 || !this.tune) {
      return true;
    }

    const left = output[0];
    const right = output[1];
    const numFrames = left.length;

    if (!this.playing) {
      left.fill(0);
      right.fill(0);
      return true;
    }

    const interleavedLen = numFrames * 2;
    if (!this.interleaved || this.interleaved.length < interleavedLen) {
      this.interleaved = new Float32Array(interleavedLen);
    }
    const scratch = this.interleaved.subarray(0, interleavedLen);

    if (this.channelsSubscribed) {
      // Fresh allocation per block so we can transfer with zero-copy.
      // Ownership passes on post; we never touch this buffer again on
      // the worklet side.
      const channels = new Float32Array(numFrames * PSID_MAX_VOICE_COUNT);
      this.tune.generateWithChannels(scratch, channels);
      this.post({ type: 'channels', data: channels, numFrames }, [channels.buffer]);
    } else {
      this.tune.generate(scratch);
    }

    for (let i = 0, j = 0; i < numFrames; i++, j += 2) {
      left[i] = scratch[j];
      right[i] = scratch[j + 1];
    }
    return true;
  }
}

registerProcessor(PSID_PROCESSOR_NAME, CawtoothPsidProcessor);
