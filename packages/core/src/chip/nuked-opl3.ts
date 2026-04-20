import type { OplChip } from './types.js';
import { asNukedOpl3Exports, type NukedOpl3Exports } from './loader.js';

const INT16_TO_FLOAT = 1 / 32768;
const INITIAL_SCRATCH_FRAMES = 1024;

/**
 * TypeScript adapter around the Nuked-OPL3 wasm build.
 *
 * One instance owns one chip struct inside the wasm linear memory plus a
 * scratch int16 buffer used to collect native samples before converting to
 * Float32. Multiple chips can share one wasm instance safely — each has its
 * own chipPtr and scratchPtr.
 */
export class NukedOpl3Chip implements OplChip {
  readonly sampleRate: number;

  private readonly exports: NukedOpl3Exports;
  private readonly chipPtr: number;
  private scratchPtr: number;
  private scratchFrames: number;
  private disposed = false;

  constructor(instance: WebAssembly.Instance, sampleRate: number) {
    this.exports = asNukedOpl3Exports(instance);
    this.sampleRate = sampleRate;

    // Standalone wasm modules expose _initialize() for one-time static init.
    this.exports._initialize?.();

    const chipPtr = this.exports.cawtooth_opl_create(sampleRate);
    if (!chipPtr) {
      throw new Error('cawtooth: failed to allocate OPL3 chip');
    }
    this.chipPtr = chipPtr;

    this.scratchFrames = INITIAL_SCRATCH_FRAMES;
    this.scratchPtr = this.exports.malloc(this.scratchFrames * 2 * 2);
    if (!this.scratchPtr) {
      this.exports.cawtooth_opl_destroy(chipPtr);
      throw new Error('cawtooth: failed to allocate sample scratch buffer');
    }
  }

  writeRegister(reg: number, value: number): void {
    this.exports.cawtooth_opl_write(this.chipPtr, reg, value);
  }

  generate(output: Float32Array): void {
    const numFrames = output.length >>> 1;
    if (numFrames === 0) {
      return;
    }

    if (numFrames > this.scratchFrames) {
      this.exports.free(this.scratchPtr);
      this.scratchFrames = numFrames;
      this.scratchPtr = this.exports.malloc(numFrames * 2 * 2);
      if (!this.scratchPtr) {
        throw new Error('cawtooth: failed to grow sample scratch buffer');
      }
    }

    this.exports.cawtooth_opl_generate(this.chipPtr, this.scratchPtr, numFrames);

    // Re-acquire the view each call: wasm memory may have been detached
    // and replaced if anything triggered a grow between calls.
    const view = new Int16Array(this.exports.memory.buffer, this.scratchPtr, numFrames * 2);
    for (let i = 0; i < view.length; i++) {
      output[i] = view[i] * INT16_TO_FLOAT;
    }
  }

  reset(): void {
    this.exports.cawtooth_opl_reset(this.chipPtr, this.sampleRate);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.exports.free(this.scratchPtr);
    this.exports.cawtooth_opl_destroy(this.chipPtr);
  }
}
