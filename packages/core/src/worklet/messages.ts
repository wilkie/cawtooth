import type { OplRegisterWrite } from '../chip/types.js';
import type { RegisterEventStream, RegisterStreamTiming } from '../sequencer/types.js';

export interface InitMessage {
  type: 'init';
  /**
   * Raw wasm bytes. Compiled inside the worklet.
   *
   * A pre-compiled WebAssembly.Module cannot be structured-cloned from the
   * main thread into AudioWorkletGlobalScope — they live in different agent
   * clusters, and WebAssembly.Module is bound to its creating cluster.
   * ArrayBuffer, by contrast, is transferable across that boundary.
   */
  wasmBytes: ArrayBuffer;
}

/** Direct register write, bypassing the sequencer. */
export interface WriteMessage {
  type: 'write';
  reg: number;
  value: number;
}

/** Batched direct register writes, bypassing the sequencer. */
export interface WritesMessage {
  type: 'writes';
  writes: readonly OplRegisterWrite[];
}

/** Zero the OPL chip state (silences any held notes immediately). */
export interface ResetMessage {
  type: 'reset';
}

/** Replace the sequencer's current event stream. Does not auto-play. */
export interface LoadStreamMessage {
  type: 'loadStream';
  stream: RegisterEventStream;
  timing: RegisterStreamTiming;
}

/** Begin / resume sequencer playback. */
export interface PlayMessage {
  type: 'play';
}

/** Halt sequencer time advancement without silencing the chip. */
export interface PauseMessage {
  type: 'pause';
}

/** Stop sequencer, rewind to song start, reset chip. */
export interface StopMessage {
  type: 'stop';
}

/** Begin emitting per-voice PCM taps via `ChannelsMessage` once per block. */
export interface SubscribeChannelsMessage {
  type: 'subscribeChannels';
}

/** Stop emitting per-voice taps. */
export interface UnsubscribeChannelsMessage {
  type: 'unsubscribeChannels';
}

export type ToWorkletMessage =
  | InitMessage
  | WriteMessage
  | WritesMessage
  | ResetMessage
  | LoadStreamMessage
  | PlayMessage
  | PauseMessage
  | StopMessage
  | SubscribeChannelsMessage
  | UnsubscribeChannelsMessage;

export interface ReadyMessage {
  type: 'ready';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

/**
 * Per-voice PCM block, emitted by the worklet once per `process()` call while
 * at least one main-thread consumer is subscribed via `subscribeChannels`.
 *
 * `data` is a freshly allocated Float32Array transferred into the main thread
 * (zero-copy). Layout is frame-interleaved:
 * `[f0_ch0, f0_ch1, ..., f0_ch17, f1_ch0, ...]`, length `numFrames * 18`.
 */
export interface ChannelsMessage {
  type: 'channels';
  data: Float32Array;
  numFrames: number;
}

export type FromWorkletMessage = ReadyMessage | ErrorMessage | ChannelsMessage;
