// Shared constant so main-thread code can reference the processor name
// without importing the worklet module itself (which calls registerProcessor
// at top-level — a side effect that only makes sense inside a worklet scope).
export const OPL_PROCESSOR_NAME = 'cawtooth-opl';
