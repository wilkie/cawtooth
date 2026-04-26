import { NukedOpl3Chip } from '../chip/nuked-opl3.js';
import { createNukedOpl3Imports } from '../chip/loader.js';
import { OPL_CHANNEL_COUNT } from '../chip/types.js';
import { RegisterSequencer } from '../sequencer/register-sequencer.js';
import type { ToWorkletMessage, FromWorkletMessage } from './messages.js';
import { OPL_PROCESSOR_NAME } from './opl-processor-name.js';

/** Minimum seconds between consecutive `progress` messages. */
const PROGRESS_INTERVAL_SEC = 1 / 20;

class CawtoothOplProcessor extends AudioWorkletProcessor {
  private chip: NukedOpl3Chip | null = null;
  private sequencer: RegisterSequencer | null = null;
  private interleaved: Float32Array | null = null;
  private channelsSubscribed = false;
  /** Latches the `ended` edge so we only post it once per loaded stream. */
  private endedFired = false;
  /** Elapsed time at the last `progress` we posted. */
  private lastProgressAtSec = 0;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToWorkletMessage>) => this.handle(ev.data);
  }

  private post(msg: FromWorkletMessage, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
      this.port.postMessage(msg, transfer);
    } else {
      this.port.postMessage(msg);
    }
  }

  private handle(msg: ToWorkletMessage): void {
    switch (msg.type) {
      case 'init': {
        try {
          const module = new WebAssembly.Module(msg.wasmBytes);
          const instance = new WebAssembly.Instance(module, createNukedOpl3Imports());
          this.chip = new NukedOpl3Chip(instance, sampleRate);
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
    if (!output || output.length < 2 || !this.sequencer) {
      return true;
    }

    const left = output[0];
    const right = output[1];
    const numFrames = left.length;
    const interleavedLen = numFrames * 2;

    if (!this.interleaved || this.interleaved.length < interleavedLen) {
      this.interleaved = new Float32Array(interleavedLen);
    }
    const stereoScratch = this.interleaved.subarray(0, interleavedLen);

    if (this.channelsSubscribed) {
      // Allocate a fresh per-voice buffer each block so it can be transferred
      // to the main thread with zero-copy. Ownership passes on post; we never
      // touch this buffer again from the worklet side.
      const channels = new Float32Array(numFrames * OPL_CHANNEL_COUNT);
      this.sequencer.generateWithChannels(stereoScratch, channels);
      this.post({ type: 'channels', data: channels, numFrames }, [channels.buffer]);
    } else {
      this.sequencer.generate(stereoScratch);
    }

    for (let i = 0, j = 0; i < numFrames; i++, j += 2) {
      left[i] = stereoScratch[j];
      right[i] = stereoScratch[j + 1];
    }

    // Progress / ended signalling. Only tick when the sequencer is
    // actually playing — paused time shouldn't advance `currentTime` or
    // cross the end boundary.
    if (this.sequencer.isPlaying) {
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

registerProcessor(OPL_PROCESSOR_NAME, CawtoothOplProcessor);
