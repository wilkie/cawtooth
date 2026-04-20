// Minimal type declarations for AudioWorkletGlobalScope APIs.
// These aren't in lib.dom.d.ts — they're scoped to the worklet global.

declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor & {
    process: (
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ) => boolean;
  },
): void;
