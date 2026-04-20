/**
 * Format-agnostic register-event stream.
 *
 * Parallel typed arrays (SoA) so the whole stream is transferable across a
 * MessagePort with zero copy and zero GC churn. Every format parser in the
 * library produces this shape; the sequencer consumes it.
 *
 * Each index `i` describes one event:
 *   - `regs[i]`        — OPL register number to write (supports OPL3 bank 1 > 0xff)
 *   - `values[i]`      — byte value to write
 *   - `delayTicks[i]`  — ticks to wait AFTER writing this event before the next.
 *                        The last element's delay is treated as end-of-song padding
 *                        (or loop-point delay if looping is enabled).
 *
 * Tick rate is not part of the buffer itself — it travels alongside, since the
 * same byte stream can legitimately play back at multiple rates (e.g. IMF files
 * of unknown provenance).
 */
export interface RegisterEventStream {
  readonly regs: Uint16Array;
  readonly values: Uint8Array;
  readonly delayTicks: Uint32Array;
}

export interface RegisterStreamTiming {
  /** Ticks per second. Common IMF values: 560 (Keen), 700 (Wolf3D), 280. */
  tickRate: number;
  /** Loop back to event 0 when the stream ends. Default false. */
  loop?: boolean;
}

/** Convenience holder pairing a stream with its timing. */
export interface TimedRegisterStream extends RegisterStreamTiming {
  stream: RegisterEventStream;
}
