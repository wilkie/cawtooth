/**
 * Pure transforms over `RegisterEventStream`.
 *
 * These functions produce new streams that are semantically equivalent to
 * their input (same audible chip behavior, same total duration) but
 * cleaned up in some way — typically smaller.
 */

import type { RegisterEventStream } from './types.js';

/**
 * Drop consecutive writes to the same register with the same value.
 *
 * On a real OPL chip, writing a value that already matches the register's
 * current contents is a no-op: the envelope doesn't retrigger, the phase
 * doesn't reset, nothing changes. So these writes can be removed losslessly.
 *
 * Why this matters for our pipeline: HERAD rendering emits a huge amount
 * of redundancy. Slides re-emit the 0xA0/0xB0 frequency pair every tick,
 * and consecutive ticks often round to the same F-number — identical
 * writes. Program changes re-emit all 11 operator regs every time, even
 * when most are unchanged from the previous patch. A typical HERAD song
 * shrinks 40–60% after this pass, which is often enough to bring it under
 * IMF type-1's 65,535-byte ceiling.
 *
 * Timing is preserved: each skipped event's `delayTicks` is added to the
 * `delayTicks` of the last event we actually emitted, so subsequent events
 * still fire at the right ticks.
 *
 * A note on dispose-before-first-write: if the very first event of the
 * stream were a "no-op" we couldn't rewrite it that way because no prior
 * state exists — but this case can't happen, because `lastValue.get(reg)`
 * is `undefined` for the first write to any given register, so it always
 * compares unequal and always gets emitted.
 */
/**
 * **Lossy.** Collapse writes to the same register within a time window,
 * keeping only the most recent value. Unlike `dedupRegisterEventStream`,
 * which requires values to match, this drops intermediate values too — on
 * the assumption that a listener won't distinguish individual writes less
 * than `windowTicks` apart.
 *
 * Primary use: HERAD pitch slides re-emit `0xA0`/`0xB0` every HERAD tick
 * (~25 ms at the typical 40 Hz). Collapsing closely-spaced slide updates
 * keeps the overall pitch curve while cutting event count substantially.
 * A 1-tick window removes redundant writes at the chip's update rate;
 * larger windows increasingly step-quantize pitches.
 *
 * **Key-on safeguard**: writes to `0xB0`–`0xB8` (and the OPL3 upper bank
 * `0x1B0`–`0x1B8`) are NEVER collapsed when their key-on bit (0x20)
 * differs — that bit is the semantic note-on/note-off boundary and
 * merging across it would drop or duplicate notes. Slide updates during a
 * single note keep the bit steady at 0x20, so they still collapse.
 *
 * The output is semantically close but not audio-identical to the input.
 * Compose with `dedupRegisterEventStream` for both windowed-lossy and
 * value-lossless passes — they're orthogonal.
 *
 * @param windowTicks - Time window in the stream's tick unit. 0 collapses
 *   only writes at exactly the same tick; larger values merge further.
 */
export function windowedDedupRegisterEventStream(
  stream: RegisterEventStream,
  windowTicks: number,
): RegisterEventStream {
  if (windowTicks < 0) {
    throw new Error(`cawtooth: windowTicks must be non-negative (got ${windowTicks})`);
  }

  const n = stream.regs.length;
  if (n === 0) {
    return {
      regs: new Uint16Array(0),
      values: new Uint8Array(0),
      delayTicks: new Uint32Array(0),
    };
  }

  // Pass 1: absolute tick of each event (cumulative delay up to it).
  const absTick = new Uint32Array(n);
  let t = 0;
  for (let i = 0; i < n; i++) {
    absTick[i] = t;
    t += stream.delayTicks[i];
  }

  // Pass 2: mark events for deletion. For each register we keep the
  // "pending" event (most recent not yet committed). When a new write to
  // the same reg arrives within the window AND the 0xB0 key-on bit
  // matches, we skip the pending (its value is being superseded). Anything
  // outside the window gets committed by default.
  const skip = new Uint8Array(n);
  const pending = new Map<number, number>();

  for (let i = 0; i < n; i++) {
    const reg = stream.regs[i];
    const prevIdx = pending.get(reg);
    if (prevIdx !== undefined) {
      const gap = absTick[i] - absTick[prevIdx];
      if (gap <= windowTicks && keyOnCompatible(reg, stream.values[prevIdx], stream.values[i])) {
        skip[prevIdx] = 1;
      }
    }
    pending.set(reg, i);
  }

  // Pass 3: emit surviving events, absorbing skipped events' delays into
  // the preceding emit. A run of skipped leading events gets a synthetic
  // no-op prefix (reg=0, val=0) to preserve timing before the first real
  // write.
  const regs: number[] = [];
  const values: number[] = [];
  const delays: number[] = [];
  let absorbedDelay = 0;

  for (let i = 0; i < n; i++) {
    if (skip[i]) {
      absorbedDelay += stream.delayTicks[i];
      continue;
    }
    if (delays.length > 0) {
      delays[delays.length - 1] += absorbedDelay;
    } else if (absorbedDelay > 0) {
      regs.push(0);
      values.push(0);
      delays.push(absorbedDelay);
    }
    absorbedDelay = 0;
    regs.push(stream.regs[i]);
    values.push(stream.values[i]);
    delays.push(stream.delayTicks[i]);
  }
  if (absorbedDelay > 0 && delays.length > 0) {
    delays[delays.length - 1] += absorbedDelay;
  }

  return {
    regs: new Uint16Array(regs),
    values: new Uint8Array(values),
    delayTicks: new Uint32Array(delays),
  };
}

/**
 * For 0xB0–0xB8 (with or without the OPL3 bank bit), the key-on bit
 * (0x20) is the semantic note boundary. Collapsing across it would drop a
 * note-on or note-off — catastrophic, not merely stepped. All other
 * registers are safe to collapse regardless of values.
 */
function keyOnCompatible(reg: number, prevVal: number, newVal: number): boolean {
  const base = reg & 0xff;
  if (base >= 0xb0 && base <= 0xb8) {
    return (prevVal & 0x20) === (newVal & 0x20);
  }
  return true;
}

export function dedupRegisterEventStream(stream: RegisterEventStream): RegisterEventStream {
  const lastValue = new Map<number, number>();
  const regs: number[] = [];
  const values: number[] = [];
  const delays: number[] = [];

  for (let i = 0; i < stream.regs.length; i++) {
    const reg = stream.regs[i];
    const val = stream.values[i];
    const delay = stream.delayTicks[i];

    if (lastValue.get(reg) === val) {
      // True no-op. Absorb its delay into the preceding emitted event so
      // subsequent events still fire at the right tick.
      if (delays.length > 0) {
        delays[delays.length - 1] += delay;
      }
      // `else`: we hit a no-op before any event was emitted. This is
      // impossible (see doc comment), so we don't need a branch.
      continue;
    }

    regs.push(reg);
    values.push(val);
    delays.push(delay);
    lastValue.set(reg, val);
  }

  return {
    regs: new Uint16Array(regs),
    values: new Uint8Array(values),
    delayTicks: new Uint32Array(delays),
  };
}
