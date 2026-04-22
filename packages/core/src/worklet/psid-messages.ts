import type { SidChipModel, SidSamplingMethod } from '../chip/resid-sid.js';
import type { PsidSong } from '../formats/psid/types.js';

/**
 * Initialize the worklet with the sidplay wasm + an already-parsed PSID
 * song. Parsing happens on the main thread because AudioWorkletGlobalScope
 * doesn't reliably have TextDecoder (needed to decode the tune's
 * Windows-1252 metadata strings).
 *
 * The song's Uint8Array payload rides a structured clone, the wasm bytes
 * transfer. For a typical PSID this is ≤ 64 KB of cloning — cheap.
 */
export interface PsidInitMessage {
  type: 'init';
  /** Raw sidplay.wasm bytes (transferred). */
  wasmBytes: ArrayBuffer;
  /** Pre-parsed PSID song (cloned). */
  song: PsidSong;
  /** Explicit model override. If absent, auto-picked from PSID flags. */
  model?: SidChipModel;
  /** Explicit clock override. If absent, auto-picked from PSID flags. */
  clockFrequency?: number;
  /** reSID sampling method. Defaults to 'resample'. */
  samplingMethod?: SidSamplingMethod;
  /** Subsong to start on. 1-based; falls back to song.startSong. */
  subsong?: number;
}

/** Switch subsong within the already-loaded tune. Calls the init routine. */
export interface PsidSelectSongMessage {
  type: 'selectSong';
  subsong: number;
}

/** Stop playback (silence the chip + hold the CPU). */
export interface PsidStopMessage {
  type: 'stop';
}

/** Resume playback after a stop. */
export interface PsidResumeMessage {
  type: 'resume';
}

/** Begin emitting per-voice PCM taps via PsidChannelsMessage once per block. */
export interface PsidSubscribeChannelsMessage {
  type: 'subscribeChannels';
}

/** Stop emitting per-voice taps. */
export interface PsidUnsubscribeChannelsMessage {
  type: 'unsubscribeChannels';
}

export type ToPsidWorkletMessage =
  | PsidInitMessage
  | PsidSelectSongMessage
  | PsidStopMessage
  | PsidResumeMessage
  | PsidSubscribeChannelsMessage
  | PsidUnsubscribeChannelsMessage;

/** Fired once the worklet has parsed the PSID, loaded the tune, and run init. */
export interface PsidReadyMessage {
  type: 'ready';
  /** Title/author/released strings from the PSID header. */
  name: string;
  author: string;
  released: string;
  /** Subsong count and the active subsong. */
  songs: number;
  subsong: number;
  /** Resolved model + clock the runtime is using. */
  model: SidChipModel;
  clockFrequency: number;
  /**
   * Resolved CPU cycles between play-routine invocations for the active
   * subsong. Either the PAL/NTSC vblank period or a CIA Timer A value
   * programmed by the tune's init routine (if the PSID speed bit says so).
   */
  playInterval: number;
}

export interface PsidErrorMessage {
  type: 'error';
  message: string;
}

/**
 * Per-voice PCM block, emitted by the worklet once per process() call
 * while at least one subscriber is active. `data` is a fresh Float32Array
 * transferred into the main thread; layout is frame-interleaved
 * `[f0_v0, f0_v1, f0_v2, f1_v0, ...]`, length `numFrames * 3`.
 */
export interface PsidChannelsMessage {
  type: 'channels';
  data: Float32Array;
  numFrames: number;
}

export type FromPsidWorkletMessage = PsidReadyMessage | PsidErrorMessage | PsidChannelsMessage;
