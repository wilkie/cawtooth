import { AyumiChip, AY_VOICE_COUNT } from '../chip/ayumi-chip.js';
import { createAyumiImports } from '../chip/ayumi-loader.js';
import { RegisterSequencer } from '../sequencer/register-sequencer.js';
import type { ToAyWorkletMessage, FromAyWorkletMessage } from './ay-messages.js';
import { AY_PROCESSOR_NAME } from './ay-processor-name.js';

/** Minimum seconds between consecutive `progress` messages. */
const PROGRESS_INTERVAL_SEC = 1 / 20;

class CawtoothAyProcessor extends AudioWorkletProcessor {
  private chip: AyumiChip | null = null;
  private sequencer: RegisterSequencer | null = null;
  private interleaved: Float32Array | null = null;
  private channelsSubscribed = false;
  /** Latches the `ended` edge so we only post it once per loaded stream. */
  private endedFired = false;
  private lastProgressAtSec = 0;

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
          this.sequencer = new RegisterSequencer(this.chip);
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
      case 'loadStream': {
        this.sequencer?.loadStream(msg.stream, msg.timing);
        this.endedFired = false;
        this.lastProgressAtSec = 0;
        return;
      }
      case 'play': {
        this.sequencer?.play();
        return;
      }
      case 'pause': {
        this.sequencer?.pause();
        return;
      }
      case 'stop': {
        this.sequencer?.stop();
        this.endedFired = false;
        this.lastProgressAtSec = 0;
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

    // Drive through the sequencer when one is available so loaded streams
    // (loadStream + play) advance time and fire events. Direct register
    // writes (the tone-demo path) still affect the chip — they just bypass
    // the sequencer entirely. When no stream is loaded, the sequencer's
    // generate() simply asks the chip for samples without firing anything.
    const renderer = this.sequencer ?? this.chip;

    if (this.channelsSubscribed) {
      // Fresh allocation per block so we can transfer zero-copy.
      const channels = new Float32Array(numFrames * AY_VOICE_COUNT);
      renderer.generateWithChannels(scratch, channels);
      this.post({ type: 'channels', data: channels, numFrames }, [channels.buffer]);
    } else {
      renderer.generate(scratch);
    }

    // Ayumi natively produces stereo (it has a per-channel pan stage),
    // so we de-interleave the scratch into the worklet's planar L/R.
    for (let i = 0, j = 0; i < numFrames; i++, j += 2) {
      left[i] = scratch[j];
      right[i] = scratch[j + 1];
    }

    if (this.sequencer && this.sequencer.isPlaying) {
      const currentTimeSec = this.sequencer.currentTime;
      const durationSec = this.sequencer.duration;
      if (currentTimeSec - this.lastProgressAtSec >= PROGRESS_INTERVAL_SEC) {
        this.post({
          type: 'progress',
          currentTimeSec,
          durationSec: durationSec > 0 ? durationSec : null,
        });
        this.lastProgressAtSec = currentTimeSec;
      }
      if (!this.endedFired && this.sequencer.isFinished) {
        this.endedFired = true;
        this.post({ type: 'ended' });
      }
    }

    return true;
  }
}

registerProcessor(AY_PROCESSOR_NAME, CawtoothAyProcessor);
