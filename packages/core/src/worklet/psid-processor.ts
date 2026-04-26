import { PSID_MAX_VOICE_COUNT, SidTune } from '../formats/psid/runtime.js';
import { createSidplayImports } from '../formats/psid/sidplay-loader.js';
import type {
  FromPsidWorkletMessage,
  ToPsidWorkletMessage,
} from './psid-messages.js';
import { PSID_PROCESSOR_NAME } from './psid-processor-name.js';

/** Minimum seconds between consecutive `progress` messages. */
const PROGRESS_INTERVAL_SEC = 1 / 20;

class CawtoothPsidProcessor extends AudioWorkletProcessor {
  private tune: SidTune | null = null;
  private interleaved: Float32Array | null = null;
  /**
   * False after init/stop until the main thread sends `play`. Matches the
   * OPL worklet model so `Player.play()` works the same across formats.
   */
  private playing = false;
  /**
   * Active subsong tracked here so `stop` can re-run the tune's init
   * routine without the main thread re-sending the subsong number.
   */
  private currentSubsong: number | null = null;
  private channelsSubscribed = false;
  /** Samples produced since the current subsong was initialized. */
  private samplesSinceInit = 0;
  /** Caller-supplied duration in seconds, or null for "unknown / don't detect end". */
  private durationSec: number | null = null;
  /** Suppresses repeat `ended` messages for a subsong that overruns its duration. */
  private endedFired = false;
  /** Last elapsed-time value we posted a progress message at. */
  private lastProgressAtSec = 0;

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
          this.currentSubsong = subsong;
          this.playing = false;
          this.resetProgress();
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
          this.currentSubsong = msg.subsong;
          // `playing` is intentionally preserved: switching subsongs while
          // active continues to play; switching while paused stays paused.
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
            // Re-running init rewinds the CPU emulator and the tune's
            // internal state to the start of the active subsong. The
            // tune's init routine usually clears SID registers, but we
            // also explicitly reset to be safe (some tunes leave a
            // pre-existing waveform key-on intact across init).
            this.tune.initSong(this.currentSubsong);
            this.tune.resetSid();
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
        // considered ended anymore (e.g. caller extended it). Reset
        // the latch so `ended` can fire again if/when we pass the new
        // threshold.
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

    // Advance elapsed-time counter and emit progress / ended events.
    // Only counts while actively playing — paused time doesn't drain the
    // duration budget.
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
    if (
      !this.endedFired &&
      this.durationSec !== null &&
      elapsedSec >= this.durationSec
    ) {
      this.endedFired = true;
      this.post({ type: 'ended' });
    }

    return true;
  }
}

registerProcessor(PSID_PROCESSOR_NAME, CawtoothPsidProcessor);
