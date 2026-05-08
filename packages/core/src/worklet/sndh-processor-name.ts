// Shared constant so main-thread code can reference the processor name
// without importing the worklet module itself (registerProcessor runs at
// top-level and only makes sense inside AudioWorkletGlobalScope).
export const SNDH_PROCESSOR_NAME = 'cawtooth-sndh';
