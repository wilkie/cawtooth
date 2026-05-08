import type { SndhSong } from '../formats/sndh/types.js';

/**
 * Initialize the worklet with the sndh wasm + an already-parsed SNDH
 * song. Parsing happens on the main thread because AudioWorkletGlobalScope
 * doesn't reliably have TextDecoder (needed to decode the SNDH metadata,
 * which is Windows-1252 ASCII-with-extras).
 *
 * The song's `binary` Uint8Array rides a structured clone (typically
 * a few KB); the wasm bytes transfer.
 */
export interface SndhInitMessage {
  type: 'init';
  /** Raw sndh.wasm bytes (transferred). */
  wasmBytes: ArrayBuffer;
  /** Pre-parsed SNDH song (cloned). */
  song: SndhSong;
  /** 68000 clock override. Defaults to PAL Atari ST. */
  clockFrequency?: number;
  /** YM2149 clock override. Defaults to 2 MHz. */
  ymClockFrequency?: number;
  /** Subsong to start on. 1-based; falls back to {@link SndhSong.defaultSubsong}. */
  subsong?: number;
}

/** Switch subsong within the already-loaded tune. Calls the init routine. */
export interface SndhSelectSongMessage {
  type: 'selectSong';
  subsong: number;
}

/** Begin / resume playback. After init, no audio is produced until this fires. */
export interface SndhPlayMessage {
  type: 'play';
}

/**
 * Halt audio production while preserving CPU + chip state. `currentTime`
 * stops advancing; a subsequent `play` resumes from the same point.
 */
export interface SndhPauseMessage {
  type: 'pause';
}

/**
 * Halt and rewind: re-runs the tune's init routine on the current subsong
 * (which resets all m68k state) and resets the YM. `currentTime` goes
 * back to 0. Audio stays silent until `play` fires again.
 */
export interface SndhStopMessage {
  type: 'stop';
}

/** Begin emitting per-voice PCM taps via SndhChannelsMessage once per block. */
export interface SndhSubscribeChannelsMessage {
  type: 'subscribeChannels';
}

/** Stop emitting per-voice taps. */
export interface SndhUnsubscribeChannelsMessage {
  type: 'unsubscribeChannels';
}

/**
 * Set (or clear) the known duration for the current subsong. The worklet
 * uses this to fire a one-shot `ended` message once elapsed time passes
 * the threshold. Pass `null` to suppress end-detection.
 */
export interface SndhSetDurationMessage {
  type: 'setDuration';
  durationSec: number | null;
}

export type ToSndhWorkletMessage =
  | SndhInitMessage
  | SndhSelectSongMessage
  | SndhPlayMessage
  | SndhPauseMessage
  | SndhStopMessage
  | SndhSubscribeChannelsMessage
  | SndhUnsubscribeChannelsMessage
  | SndhSetDurationMessage;

/** Fired once the worklet has loaded the tune and run init. */
export interface SndhReadyMessage {
  type: 'ready';
  /** Title/composer/year strings from the SNDH header. */
  title: string;
  composer: string;
  ripper: string;
  converter: string;
  year: string;
  /** Subsong count and the active subsong. */
  subsongCount: number;
  subsong: number;
  /** Resolved 68000 clock the runtime is using. */
  clockFrequency: number;
  /** m68k cycles between play-routine invocations. */
  playInterval: number;
  /**
   * Active subsong's TIME-tag duration in seconds, or `null` when the
   * SNDH file has no `TIME` tag or the entry is zero (which the spec
   * interprets as "unknown / indefinite"). Callers may override this
   * via {@link SndhSetDurationMessage} if they have a better source.
   */
  durationSec: number | null;
}

export interface SndhErrorMessage {
  type: 'error';
  message: string;
}

/**
 * Per-voice PCM block, emitted once per process() call while at least one
 * subscriber is active. `data` is a fresh Float32Array transferred to the
 * main thread; layout is frame-interleaved `[f0_v0, f0_v1, f0_v2, f1_v0,
 * ...]`, length `numFrames * 3`.
 */
export interface SndhChannelsMessage {
  type: 'channels';
  data: Float32Array;
  numFrames: number;
}

/** Progress tick — throttled to ~20 Hz on the worklet side. */
export interface SndhProgressMessage {
  type: 'progress';
  currentTimeSec: number;
  durationSec: number | null;
}

/** Fired once per subsong when the caller-supplied duration has elapsed. */
export interface SndhEndedMessage {
  type: 'ended';
}

export type FromSndhWorkletMessage =
  | SndhReadyMessage
  | SndhErrorMessage
  | SndhChannelsMessage
  | SndhProgressMessage
  | SndhEndedMessage;
