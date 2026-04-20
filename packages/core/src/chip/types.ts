/**
 * Number of per-voice channels an OPL3 chip exposes.
 *
 * OPL2 physically has only 9 melodic channels, but because our emulator is
 * OPL3 compiled in OPL3 mode, the channel buffer is always 18 wide — channels
 * 9–17 simply stay silent when running OPL2 content.
 */
export const OPL_CHANNEL_COUNT = 18;

/**
 * Common shape for any OPL-family chip adapter.
 *
 * Chips are pure state machines: consumers feed register writes and pull
 * samples. Timing and format parsing live in higher layers. Per-voice taps
 * are a first-class feature — any OPL chip can expose per-operator output
 * structurally, so the interface requires it rather than bolting it on.
 */
export interface OplChip {
  readonly sampleRate: number;

  writeRegister(reg: number, value: number): void;

  /**
   * Fill the output buffer with stereo interleaved samples in [-1, 1].
   * The number of frames generated is `output.length / 2`.
   */
  generate(output: Float32Array): void;

  /**
   * Fill both a stereo output buffer AND a per-voice buffer in one pass.
   *
   * `channelsOutput` is frame-interleaved: `[f0_ch0, f0_ch1, ..., f0_ch17,
   * f1_ch0, ...]`, total length `numFrames * OPL_CHANNEL_COUNT`.
   * Per-voice values ignore the chip's pan/route mask — they track what each
   * voice is producing, whether or not it ends up in the mix.
   */
  generateWithChannels(stereoOutput: Float32Array, channelsOutput: Float32Array): void;

  reset(): void;

  dispose(): void;
}

export interface OplRegisterWrite {
  reg: number;
  value: number;
}
