import type { OplRegisterWrite } from '../chip/types.js';

export interface InitMessage {
  type: 'init';
  module: WebAssembly.Module;
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
