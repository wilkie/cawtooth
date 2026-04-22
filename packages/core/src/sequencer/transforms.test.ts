import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { dedupRegisterEventStream, windowedDedupRegisterEventStream } from './transforms.js';
import { NukedOpl3Chip } from '../chip/nuked-opl3.js';
import { createNukedOpl3Imports } from '../chip/loader.js';
import { parseHerad } from '../formats/herad/parser.js';
import { renderHeradToStream } from '../formats/herad/render.js';
import { renderToPcm } from '../audio/export.js';
import type { RegisterEventStream, TimedRegisterStream } from './types.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function makeStream(
  entries: ReadonlyArray<readonly [reg: number, val: number, delay: number]>,
): RegisterEventStream {
  const regs = new Uint16Array(entries.length);
  const values = new Uint8Array(entries.length);
  const delayTicks = new Uint32Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    regs[i] = entries[i][0];
    values[i] = entries[i][1];
    delayTicks[i] = entries[i][2];
  }
  return { regs, values, delayTicks };
}

describe('dedupRegisterEventStream', () => {
  it('preserves a stream with no duplicates', () => {
    const stream = makeStream([
      [0x20, 0x01, 5],
      [0x21, 0x02, 3],
      [0xa0, 0x41, 0],
    ]);
    const out = dedupRegisterEventStream(stream);
    expect(Array.from(out.regs)).toEqual([0x20, 0x21, 0xa0]);
    expect(Array.from(out.values)).toEqual([0x01, 0x02, 0x41]);
    expect(Array.from(out.delayTicks)).toEqual([5, 3, 0]);
  });

  it('collapses consecutive same-value writes to the same register', () => {
    const stream = makeStream([
      [0x20, 0x01, 5],
      [0x20, 0x01, 3], // no-op: same reg, same value
      [0x20, 0x01, 2], // no-op
      [0xa0, 0x41, 0],
    ]);
    const out = dedupRegisterEventStream(stream);
    expect(Array.from(out.regs)).toEqual([0x20, 0xa0]);
    // Event 0 carried delay 5; the two skipped events contributed 3 + 2 = 5
    // absorbed into event 0's delay → total 10. Then the 0xA0 event fires.
    expect(Array.from(out.delayTicks)).toEqual([10, 0]);
  });

  it('does NOT collapse same-value writes to DIFFERENT registers', () => {
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0x21, 0x01, 0], // same VALUE but different REGISTER — not a no-op
      [0x22, 0x01, 0],
    ]);
    const out = dedupRegisterEventStream(stream);
    expect(Array.from(out.regs)).toEqual([0x20, 0x21, 0x22]);
  });

  it('does NOT collapse different-value writes to the same register', () => {
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0x20, 0x02, 0],
      [0x20, 0x01, 0], // back to the original value — still a real change
    ]);
    const out = dedupRegisterEventStream(stream);
    // All three emitted: value changed each time.
    expect(Array.from(out.regs)).toEqual([0x20, 0x20, 0x20]);
    expect(Array.from(out.values)).toEqual([0x01, 0x02, 0x01]);
  });

  it('tracks per-register state independently', () => {
    const stream = makeStream([
      [0x20, 0x01, 1],
      [0x21, 0x01, 1], // different reg, becomes 0x21=1 → emitted
      [0x20, 0x01, 1], // 0x20 still 1 → no-op
      [0x21, 0x01, 1], // 0x21 still 1 → no-op
      [0x22, 0x05, 0],
    ]);
    const out = dedupRegisterEventStream(stream);
    expect(Array.from(out.regs)).toEqual([0x20, 0x21, 0x22]);
    expect(Array.from(out.values)).toEqual([0x01, 0x01, 0x05]);
    // Delays: 0x20=1, 0x21=1, then two no-ops absorbed into last emitted
    // (0x21) delay (+1 + +1 = +2 → 3), then 0x22 fires at trailing 0.
    expect(Array.from(out.delayTicks)).toEqual([1, 3, 0]);
  });

  it('preserves total duration', () => {
    const stream = makeStream([
      [0x20, 0x01, 5],
      [0x20, 0x01, 3],
      [0x20, 0x01, 2],
      [0x21, 0x02, 7],
      [0x21, 0x02, 4],
    ]);
    const total = (s: RegisterEventStream): number =>
      Array.from(s.delayTicks).reduce((n, d) => n + d, 0);
    expect(total(dedupRegisterEventStream(stream))).toBe(total(stream));
  });

  it('returns an empty stream for empty input', () => {
    const empty: RegisterEventStream = {
      regs: new Uint16Array(0),
      values: new Uint8Array(0),
      delayTicks: new Uint32Array(0),
    };
    const out = dedupRegisterEventStream(empty);
    expect(out.regs.length).toBe(0);
  });
});

describe('windowedDedupRegisterEventStream', () => {
  it('collapses slide-like runs of same-reg writes within the window', () => {
    // Simulate a slide on voice 0's 0xA0 register: 4 writes, 1 tick apart.
    // With window=2 ticks, all four cluster together and only the last survives.
    // Delays of skipped events accumulate onto the preceding kept event.
    const stream = makeStream([
      [0xa0, 0x10, 1],
      [0xa0, 0x11, 1],
      [0xa0, 0x12, 1],
      [0xa0, 0x13, 0],
    ]);
    const out = windowedDedupRegisterEventStream(stream, 2);
    // First 3 are skipped; 4th (0x13) is the survivor. Their delays
    // (1+1+1=3) absorb into a synthetic leading no-op.
    expect(Array.from(out.regs)).toEqual([0, 0xa0]);
    expect(Array.from(out.values)).toEqual([0, 0x13]);
    expect(Array.from(out.delayTicks)).toEqual([3, 0]);
  });

  it('does NOT collapse when the gap exceeds the window', () => {
    const stream = makeStream([
      [0xa0, 0x10, 5], // 5 ticks later
      [0xa0, 0x11, 0], // outside a window of 2
    ]);
    const out = windowedDedupRegisterEventStream(stream, 2);
    expect(out.regs.length).toBe(2);
  });

  it('preserves the key-on transition on 0xB0 even within the window', () => {
    // A note-on followed closely by a note-off MUST not collapse — even if
    // their tick gap is within the window — because the key-on bit (0x20)
    // differs. Merging would drop the note.
    const stream = makeStream([
      [0xb0, 0x32, 1], // key-on (bit 5 set)
      [0xb0, 0x12, 0], // key-off (bit 5 clear)
    ]);
    const out = windowedDedupRegisterEventStream(stream, 10);
    expect(Array.from(out.regs)).toEqual([0xb0, 0xb0]);
    expect(Array.from(out.values)).toEqual([0x32, 0x12]);
  });

  it('DOES collapse 0xB0 writes that share the same key-on state', () => {
    // Slide-style re-emission: both writes have bit 5 set. Collapse safely.
    const stream = makeStream([
      [0xb0, 0x32, 1], // key-on + block 4 + fnum-hi 2
      [0xb0, 0x35, 0], // key-on + block 5 + fnum-hi 1 — still key-on
    ]);
    const out = windowedDedupRegisterEventStream(stream, 10);
    expect(Array.from(out.regs)).toEqual([0, 0xb0]);
    expect(Array.from(out.values)).toEqual([0, 0x35]);
  });

  it('protects key-on on OPL3 upper-bank 0x1B0 registers too', () => {
    const stream = makeStream([
      [0x1b1, 0x32, 0], // upper bank, voice 10, key-on
      [0x1b1, 0x12, 0], // key-off
    ]);
    const out = windowedDedupRegisterEventStream(stream, 10);
    expect(out.regs.length).toBe(2);
  });

  it('tracks per-register windows independently', () => {
    const stream = makeStream([
      [0xa0, 0x10, 1],
      [0x40, 0x05, 1], // different reg — its own window
      [0xa0, 0x11, 1], // 0xA0 gap from event 0 = 2; within window=2
      [0x40, 0x06, 0], // 0x40 gap from event 1 = 1; within window=2
    ]);
    const out = windowedDedupRegisterEventStream(stream, 2);
    // Both leading events were skipped, leaving a 2-tick gap before the
    // first emitted write. We synthesise a reg=0 no-op to carry that
    // leading delay. Then 0xA0=0x11 and 0x40=0x06 survive, each holding
    // the last value written to its register.
    expect(Array.from(out.regs)).toEqual([0, 0xa0, 0x40]);
    expect(Array.from(out.values)).toEqual([0, 0x11, 0x06]);
    expect(Array.from(out.delayTicks)).toEqual([2, 1, 0]);
  });

  it('preserves total duration', () => {
    const stream = makeStream([
      [0xa0, 0x10, 3],
      [0xa0, 0x11, 2],
      [0xa0, 0x12, 5],
      [0x40, 0x01, 1],
    ]);
    const total = (s: RegisterEventStream): number =>
      Array.from(s.delayTicks).reduce((n, d) => n + d, 0);
    expect(total(windowedDedupRegisterEventStream(stream, 10))).toBe(total(stream));
  });

  it('rejects negative window sizes', () => {
    const stream = makeStream([[0xa0, 0x10, 0]]);
    expect(() => windowedDedupRegisterEventStream(stream, -1)).toThrow();
  });
});

/*
 * The strongest guarantee: deduped streams produce bit-identical audio
 * samples. A write to a register with its current value is a true no-op
 * on the OPL (envelopes don't retrigger, phase doesn't reset), so the
 * emulator's sample output must match the undeduped stream exactly.
 */
describe('dedupRegisterEventStream — sample-identical rendering', () => {
  let wasmModule: WebAssembly.Module;

  beforeAll(async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const wasmPath = resolve(here, '../../wasm/nuked-opl3.wasm');
    wasmModule = await WebAssembly.compile(await readFile(wasmPath));
  });

  function makeChip(): NukedOpl3Chip {
    const instance = new WebAssembly.Instance(wasmModule, createNukedOpl3Imports());
    return new NukedOpl3Chip(instance, 48000);
  }

  async function renderBoth(
    timed: TimedRegisterStream,
  ): Promise<{ original: Float32Array; deduped: Float32Array }> {
    const dedupedStream: TimedRegisterStream = {
      stream: dedupRegisterEventStream(timed.stream),
      tickRate: timed.tickRate,
    };
    const chipA = makeChip();
    const chipB = makeChip();
    try {
      const original = renderToPcm(timed, { chip: chipA, maxDurationSec: 2, tailSec: 0.25 });
      const deduped = renderToPcm(dedupedStream, { chip: chipB, maxDurationSec: 2, tailSec: 0.25 });
      return { original, deduped };
    } finally {
      chipA.dispose();
      chipB.dispose();
    }
  }

  it('produces byte-identical PCM on a stream with redundant writes (synthetic)', async () => {
    // Set up a simple tone with deliberately redundant program-change writes.
    const regs = [
      0x20, 0x01, 0x40, 0x00, 0x60, 0xf0, 0x80, 0x77,
      // The next 4 writes are identical to the previous 4 — pure no-ops.
      0x20, 0x01, 0x40, 0x00, 0x60, 0xf0, 0x80, 0x77,
      // Now a real change + a note-on.
      0xa0, 0x41, 0xb0, 0x32,
    ];
    const r = new Uint16Array(regs.length / 2);
    const v = new Uint8Array(regs.length / 2);
    const d = new Uint32Array(regs.length / 2);
    for (let i = 0; i < regs.length / 2; i++) {
      r[i] = regs[i * 2];
      v[i] = regs[i * 2 + 1];
    }
    d[d.length - 1] = 40; // 40 ticks trailing at 40 Hz = 1 second
    const timed: TimedRegisterStream = {
      stream: { regs: r, values: v, delayTicks: d },
      tickRate: 40,
    };

    const { original, deduped } = await renderBoth(timed);
    expect(deduped.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      if (deduped[i] !== original[i]) {
        throw new Error(`sample ${i} differs: original=${original[i]} deduped=${deduped[i]}`);
      }
    }
  });

  it.each([
    ['WORMINTR.HSQ', undefined],
    ['SAVAGE.HSQ', undefined],
    ['ALARME.HSQ', 'v2'],
  ] as const)('produces byte-identical PCM for %s', async (file, variant) => {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, '../../../../examples/herad/data', file);
    if (!(await fileExists(path))) {
      console.warn(`[transforms test] skipping ${file} — not present`);
      return;
    }
    const bytes = new Uint8Array(await readFile(path));
    const song = parseHerad(bytes, variant ? { variant } : {});
    const timed = renderHeradToStream(song);
    const { original, deduped } = await renderBoth(timed);
    // Render only the first ~2 seconds to keep the test fast.
    expect(deduped.length).toBe(original.length);
    // Full sample-for-sample comparison. One mismatch = dedup is lossy.
    let firstDiff = -1;
    for (let i = 0; i < original.length; i++) {
      if (deduped[i] !== original[i]) {
        firstDiff = i;
        break;
      }
    }
    if (firstDiff !== -1) {
      throw new Error(
        `${file}: dedup changed audio — first differing sample at index ${firstDiff} ` +
          `(original=${original[firstDiff]}, deduped=${deduped[firstDiff]}).`,
      );
    }
  });
});

/*
 * Integration check: how much redundancy do real HERAD streams have?
 *
 * Observed shrink factors when Phase C renderer is in its current form
 * (values may drift as we optimise the renderer itself):
 *   - WORMINTR.HSQ  ~ 30% — most ticks are packed, little slide
 *   - SAVAGE.HSQ    ~ 33% — lots of slide, but many emit differing values
 *   - DETRITUS.HSQ  ~ 36%
 *   - ALARME.HSQ    ~ 35%
 *
 * These are enough for small songs like WORMINTR (64 KB → 45 KB, under
 * IMF type-1's 65 KB ceiling) but not for the larger songs (SAVAGE at
 * 205 KB still comes to ~138 KB post-dedup). For those, callers must use
 * WLF (type-0, no size limit) or another format.
 */
describe('dedupRegisterEventStream — HERAD real-file impact', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, '../../../../examples/herad/data');

  it.each([
    ['WORMINTR.HSQ', undefined, 0.25],
    ['SAVAGE.HSQ', undefined, 0.3],
    ['DETRITUS.HSQ', undefined, 0.3],
    ['ALARME.HSQ', 'v2', 0.3],
  ] as const)(
    '%s shrinks by at least %d fraction after dedup',
    async (file, variant, minShrink) => {
      const path = resolve(dataDir, file);
      if (!(await fileExists(path))) {
        console.warn(`[transforms test] skipping ${file} — not present`);
        return;
      }
      const bytes = new Uint8Array(await readFile(path));
      const song = parseHerad(bytes, variant ? { variant } : {});
      const { stream } = renderHeradToStream(song);
      const deduped = dedupRegisterEventStream(stream);
      const shrink = 1 - deduped.regs.length / stream.regs.length;
      expect(shrink).toBeGreaterThanOrEqual(minShrink);
    },
  );
});
