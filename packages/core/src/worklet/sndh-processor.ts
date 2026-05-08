import { SndhTune, SNDH_VOICE_COUNT } from '../formats/sndh/runtime.js';
import { createSndhImports } from '../formats/sndh/sndh-loader.js';
import type { FromSndhWorkletMessage, ToSndhWorkletMessage } from './sndh-messages.js';
import { SNDH_PROCESSOR_NAME } from './sndh-processor-name.js';

/** Minimum seconds between consecutive `progress` messages. */
const PROGRESS_INTERVAL_SEC = 1 / 20;

class CawtoothSndhProcessor extends AudioWorkletProcessor {
  private tune: SndhTune | null = null;
  private interleaved: Float32Array | null = null;
  /** False after init/stop until the main thread sends `play`. */
  private playing = false;
  /**
   * Active subsong tracked here so `stop` can re-run the tune's init
   * routine without the main thread re-sending the subsong number.
   */
  private currentSubsong: number | null = null;
  private channelsSubscribed = false;
  /** Samples produced since the current subsong was initialized. */
  private samplesSinceInit = 0;
  /** Caller-supplied duration in seconds, or null for "unknown". */
  private durationSec: number | null = null;
  /** Suppresses repeat `ended` messages for an overrunning subsong. */
  private endedFired = false;
  /** Last elapsed-time value we posted a progress message at. */
  private lastProgressAtSec = 0;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToSndhWorkletMessage>) => this.handle(ev.data);
  }

  private post(msg: FromSndhWorkletMessage, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
      this.port.postMessage(msg, transfer);
    } else {
      this.port.postMessage(msg);
    }
  }

  private handle(msg: ToSndhWorkletMessage): void {
    switch (msg.type) {
      case 'init': {
        try {
          const module = new WebAssembly.Module(msg.wasmBytes);
          const instance = new WebAssembly.Instance(module, createSndhImports());
          this.tune?.dispose();
          this.tune = new SndhTune(instance, msg.song, {
            sampleRate,
            clockFrequency: msg.clockFrequency,
            ymClockFrequency: msg.ymClockFrequency,
          });
          const subsong = msg.subsong ?? msg.song.defaultSubsong;
          this.tune.initSong(subsong);
          this.currentSubsong = subsong;
          this.playing = false;
          this.resetProgress();
          this.post({
            type: 'ready',
            title: msg.song.title,
            composer: msg.song.composer,
            ripper: msg.song.ripper,
            converter: msg.song.converter,
            year: msg.song.year,
            subsongCount: msg.song.subsongCount,
            subsong,
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
          this.currentSubsong = msg.subsong;
          // `playing` is preserved: switching subsongs while active
          // continues to play; switching while paused stays paused.
          this.resetProgress();
        } catch (err) {
          this.post({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'play': {
        this.playing = true;
        return;
      }
      case 'pause': {
        // Halt time without disturbing chip / CPU state. The processor
        // emits silence while paused (see process()) but a subsequent
        // `play` resumes from exactly where we left off.
        this.playing = false;
        return;
      }
      case 'stop': {
        try {
          this.playing = false;
          if (this.tune && this.currentSubsong !== null) {
            // Re-running init rewinds the m68k and the tune's internal
            // state to the start of the active subsong.
            this.tune.initSong(this.currentSubsong);
            this.tune.resetChip();
          }
          this.resetProgress();
        } catch (err) {
          this.post({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
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
      case 'setDuration': {
        this.durationSec = msg.durationSec;
        // New duration may mean a previously-ended subsong isn't
        // considered ended anymore (caller extended it). Reset the
        // latch so `ended` can fire again at the new threshold.
        this.endedFired = false;
        return;
      }
    }
  }

  private resetProgress(): void {
    this.samplesSinceInit = 0;
    this.lastProgressAtSec = 0;
    this.endedFired = false;
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
      const channels = new Float32Array(numFrames * SNDH_VOICE_COUNT);
      this.tune.generateWithChannels(scratch, channels);
      this.post({ type: 'channels', data: channels, numFrames }, [channels.buffer]);
    } else {
      this.tune.generate(scratch);
    }

    for (let i = 0, j = 0; i < numFrames; i++, j += 2) {
      left[i] = scratch[j];
      right[i] = scratch[j + 1];
    }

    // Advance elapsed-time counter and emit progress / ended events.
    // Only counts while actively playing — paused time doesn't drain
    // the duration budget.
    this.samplesSinceInit += numFrames;
    const elapsedSec = this.samplesSinceInit / sampleRate;
    if (elapsedSec - this.lastProgressAtSec >= PROGRESS_INTERVAL_SEC) {
      this.post({
        type: 'progress',
        currentTimeSec: elapsedSec,
        durationSec: this.durationSec,
      });
      this.lastProgressAtSec = elapsedSec;
    }
    if (!this.endedFired && this.durationSec !== null && elapsedSec >= this.durationSec) {
      this.endedFired = true;
      this.post({ type: 'ended' });
    }

    return true;
  }
}

registerProcessor(SNDH_PROCESSOR_NAME, CawtoothSndhProcessor);
