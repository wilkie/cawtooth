import type { SidChipModel, SidSamplingMethod } from '../chip/resid-sid.js';

/** One SID register write — 8-bit offset (0x00–0x1F) plus 8-bit value. */
export interface SidRegisterWrite {
  reg: number;
  value: number;
}

export interface SidInitMessage {
  type: 'init';
  /**
   * Raw reSID wasm bytes. Compiled inside the worklet.
   *
   * A pre-compiled WebAssembly.Module cannot be structured-cloned from the
   * main thread into AudioWorkletGlobalScope — they live in different agent
   * clusters. ArrayBuffer, by contrast, is transferable.
   */
  wasmBytes: ArrayBuffer;
  /** Host clock frequency in Hz. PAL C64 = 985248, NTSC C64 = 1022727. */
  clockFrequency: number;
  /** Chip revision. */
  model: SidChipModel;
  /** reSID sampling strategy. */
  samplingMethod: SidSamplingMethod;
}

export interface SidWriteMessage {
  type: 'write';
  reg: number;
  value: number;
}

export interface SidWritesMessage {
  type: 'writes';
  writes: readonly SidRegisterWrite[];
}

export interface SidResetMessage {
  type: 'reset';
}

/** Begin emitting per-voice PCM taps via SidChannelsMessage once per block. */
export interface SidSubscribeChannelsMessage {
  type: 'subscribeChannels';
}

/** Stop emitting per-voice taps. */
export interface SidUnsubscribeChannelsMessage {
  type: 'unsubscribeChannels';
}

export type ToSidWorkletMessage =
  | SidInitMessage
  | SidWriteMessage
  | SidWritesMessage
  | SidResetMessage
  | SidSubscribeChannelsMessage
  | SidUnsubscribeChannelsMessage;

export interface SidReadyMessage {
  type: 'ready';
}

export interface SidErrorMessage {
  type: 'error';
  message: string;
}

/**
 * Per-voice PCM block emitted once per process() call while at least one
 * subscriber is active. `data` is 3 voices × numFrames, frame-interleaved
 * ([f0_v0, f0_v1, f0_v2, f1_v0, ...]), transferred zero-copy.
 */
export interface SidChannelsMessage {
  type: 'channels';
  data: Float32Array;
  numFrames: number;
}

export type FromSidWorkletMessage = SidReadyMessage | SidErrorMessage | SidChannelsMessage;
