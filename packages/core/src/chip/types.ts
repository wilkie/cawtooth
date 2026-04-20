/**
 * Common shape for any OPL-family chip adapter.
 *
 * Chips are pure state machines: consumers feed register writes and pull
 * samples. Timing and format parsing live in higher layers.
 */
export interface OplChip {
  readonly sampleRate: number;

  writeRegister(reg: number, value: number): void;

  /**
   * Fill the output buffer with stereo interleaved samples in [-1, 1].
   * The number of frames generated is `output.length / 2`.
   */
  generate(output: Float32Array): void;

  reset(): void;

  dispose(): void;
}

export interface OplRegisterWrite {
  reg: number;
  value: number;
}
