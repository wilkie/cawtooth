import type { AyChipModel } from '../chip/ayumi-chip.js';

/** One AY register write — 4-bit address (R0–R15) + 8-bit value. */
export interface AyRegisterWrite {
  reg: number;
  value: number;
}

export interface AyInitMessage {
  type: 'init';
  /**
   * Raw Ayumi wasm bytes. Compiled inside the worklet — pre-compiled
   * WebAssembly.Module values cannot cross the agent-cluster boundary
   * into AudioWorkletGlobalScope.
   */
  wasmBytes: ArrayBuffer;
  /** Host clock frequency in Hz (e.g. 1773400 for ZX Spectrum). */
  clockFrequency: number;
  /** Chip variant. AY-3-8910 (16-step env) or YM2149 (32-step env). */
  model: AyChipModel;
  /**
   * Per-channel pan position in [0, 1]. Defaults to ABC stereo
   * ([0.0, 0.5, 1.0]) when omitted.
   */
  pan?: readonly [number, number, number];
}

export interface AyWriteMessage {
  type: 'write';
  reg: number;
  value: number;
}

export interface AyWritesMessage {
  type: 'writes';
  writes: readonly AyRegisterWrite[];
}

export interface AyResetMessage {
  type: 'reset';
}

export interface AySubscribeChannelsMessage {
  type: 'subscribeChannels';
}

export interface AyUnsubscribeChannelsMessage {
  type: 'unsubscribeChannels';
}

export type ToAyWorkletMessage =
  | AyInitMessage
  | AyWriteMessage
  | AyWritesMessage
  | AyResetMessage
  | AySubscribeChannelsMessage
  | AyUnsubscribeChannelsMessage;

export interface AyReadyMessage {
  type: 'ready';
}

export interface AyErrorMessage {
  type: 'error';
  message: string;
}

/**
 * Per-voice PCM block emitted once per process() call while at least
 * one subscriber is active. `data` is 3 voices × numFrames,
 * frame-interleaved ([f0_v0, f0_v1, f0_v2, f1_v0, ...]), transferred
 * zero-copy. Values are pre-pan, pre-mix DAC samples scaled to
 * roughly [-1, 1] — useful for scope visualization.
 */
export interface AyChannelsMessage {
  type: 'channels';
  data: Float32Array;
  numFrames: number;
}

export type FromAyWorkletMessage = AyReadyMessage | AyErrorMessage | AyChannelsMessage;
