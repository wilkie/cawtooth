import type { OplRegisterWrite } from '../chip/types.js';

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

export interface WriteMessage {
  type: 'write';
  reg: number;
  value: number;
}

export interface WritesMessage {
  type: 'writes';
  writes: readonly OplRegisterWrite[];
}

export interface ResetMessage {
  type: 'reset';
}

export type ToWorkletMessage = InitMessage | WriteMessage | WritesMessage | ResetMessage;

export interface ReadyMessage {
  type: 'ready';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type FromWorkletMessage = ReadyMessage | ErrorMessage;
