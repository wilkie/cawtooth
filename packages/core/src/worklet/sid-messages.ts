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

export type ToSidWorkletMessage =
  | SidInitMessage
  | SidWriteMessage
  | SidWritesMessage
  | SidResetMessage;

export interface SidReadyMessage {
  type: 'ready';
}

export interface SidErrorMessage {
  type: 'error';
  message: string;
}

export type FromSidWorkletMessage = SidReadyMessage | SidErrorMessage;
