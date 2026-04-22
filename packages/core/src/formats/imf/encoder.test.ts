import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { encodeImf } from './encoder.js';
import { parseImf } from './parser.js';
import type { RegisterEventStream, TimedRegisterStream } from '../../sequencer/types.js';

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

function timed(stream: RegisterEventStream, tickRate = 700): TimedRegisterStream {
  return { stream, tickRate };
}

describe('encodeImf', () => {
  it('round-trips a hand-crafted type-1 stream through parseImf', () => {
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0xa0, 0x41, 100],
      [0xb0, 0x32, 0],
      [0xb0, 0x12, 50],
    ]);
    const bytes = encodeImf(timed(stream));
    const parsed = parseImf(bytes);
    expect(parsed.variant).toBe('type1');
    expect(Array.from(parsed.stream.regs)).toEqual([0x20, 0xa0, 0xb0, 0xb0]);
    expect(Array.from(parsed.stream.values)).toEqual([0x01, 0x41, 0x32, 0x12]);
    expect(Array.from(parsed.stream.delayTicks)).toEqual([0, 100, 0, 50]);
  });

  it('writes type-0 (no length prefix) on demand', () => {
    const stream = makeStream([[0x20, 0x01, 0]]);
    const bytes = encodeImf(timed(stream), { variant: 'type0' });
    expect(bytes.length).toBe(4); // one event, no header
    const parsed = parseImf(bytes);
    expect(parsed.variant).toBe('type0');
  });

  it('includes metadata in type-1 output when provided', () => {
    const stream = makeStream([[0x20, 0x01, 0]]);
    const bytes = encodeImf(timed(stream), {
      title: 'Test',
      source: 'Composer',
      remarks: 'Notes',
    });
    const parsed = parseImf(bytes);
    expect(parsed.title).toBe('Test');
    expect(parsed.source).toBe('Composer');
    expect(parsed.remarks).toBe('Notes');
  });

  it('splits delays larger than 65535 across multiple events', () => {
    const stream = makeStream([
      [0x20, 0x01, 100000], // needs splitting
      [0xa0, 0x41, 0],
    ]);
    const bytes = encodeImf(timed(stream), { variant: 'type0' });
    const parsed = parseImf(bytes, { variant: 'type0' });
    // Sum of delays after parsing should equal the original.
    let total = 0;
    for (const d of parsed.stream.delayTicks) total += d;
    // Cut the trailing 0 from the final event.
    // (Last event has delay 0 in the source.)
    expect(total).toBe(100000);
    // First original event (reg 0x20) should still carry the full first write.
    expect(parsed.stream.regs[0]).toBe(0x20);
    expect(parsed.stream.values[0]).toBe(0x01);
    // Intermediate no-op events have reg=0, val=0.
    const midNoops = Array.from(parsed.stream.regs).slice(1, -1);
    for (const reg of midNoops) expect(reg).toBe(0);
  });

  it('throws on OPL3 upper-bank writes by default', () => {
    const stream = makeStream([[0x105, 0x01, 0]]);
    expect(() => encodeImf(timed(stream))).toThrow(/upper-bank|OPL3/);
  });

  it('drops upper-bank writes when opl3: "drop" is set', () => {
    const stream = makeStream([
      [0x105, 0x01, 50],
      [0x20, 0x01, 0],
    ]);
    const bytes = encodeImf(timed(stream), { opl3: 'drop' });
    const parsed = parseImf(bytes);
    // Only the low-bank write survives — but its delay is preserved via a
    // preceding no-op.
    expect(parsed.stream.regs.length).toBeGreaterThanOrEqual(1);
    let saw0x20 = false;
    for (const r of parsed.stream.regs) if (r === 0x20) saw0x20 = true;
    expect(saw0x20).toBe(true);
    // The 0x105 write should NOT appear.
    for (const r of parsed.stream.regs) expect(r).not.toBe(0x105);
  });

  it('masks upper-bank writes to low bank when opl3: "mask" is set', () => {
    const stream = makeStream([[0x105, 0x01, 0]]);
    const bytes = encodeImf(timed(stream), { opl3: 'mask' });
    const parsed = parseImf(bytes);
    // The 0x105 (upper-bank) should be encoded as plain 0x05.
    expect(parsed.stream.regs[0]).toBe(0x05);
    expect(parsed.stream.values[0]).toBe(0x01);
  });

  describe('type-1 length overflow', () => {
    // Build a stream whose encoded event bytes exceed the u16 length
    // field. Each event is 4 bytes, so >16,384 events will overflow.
    function bigStream(numEvents: number): RegisterEventStream {
      const regs = new Uint16Array(numEvents);
      const values = new Uint8Array(numEvents);
      const delayTicks = new Uint32Array(numEvents);
      for (let i = 0; i < numEvents; i++) {
        regs[i] = 0x20 + (i & 0x0f);
        values[i] = i & 0xff;
      }
      return { regs, values, delayTicks };
    }

    it('throws when type-1 is forced and event bytes exceed 65,535', () => {
      const stream = bigStream(17000); // 68,000 bytes of events
      expect(() => encodeImf(timed(stream), { variant: 'type1' })).toThrow(/exceeds|65,535/);
    });

    it('falls back to type-0 with variant: auto when stream is too large', () => {
      const stream = bigStream(17000);
      const bytes = encodeImf(timed(stream), { variant: 'auto' });
      // Force type-0 parse — the auto-detection heuristic can coincidentally
      // misfire on a synthetic stream whose first bytes happen to look like
      // a valid type-1 header. What matters for this test is that the
      // encoder produced the raw event bytes with no length prefix.
      const parsed = parseImf(bytes, { variant: 'type0' });
      expect(parsed.stream.regs.length).toBe(17000);
      expect(bytes.length).toBe(17000 * 4); // no header prefix
    });

    it('throws with variant: auto when stream is too large AND metadata is requested', () => {
      const stream = bigStream(17000);
      expect(() =>
        encodeImf(timed(stream), { variant: 'auto', title: 'Too big for type-1' }),
      ).toThrow(/metadata/);
    });

    it('uses type-1 under variant: auto when the stream fits', () => {
      const stream = bigStream(100);
      const bytes = encodeImf(timed(stream), { variant: 'auto' });
      const parsed = parseImf(bytes);
      expect(parsed.variant).toBe('type1');
    });
  });

  describe('targetTickRate (delay resampling)', () => {
    it('passes delays through unchanged by default', () => {
      const stream = makeStream([
        [0x20, 0x01, 0],
        [0xa0, 0x41, 100],
      ]);
      const bytes = encodeImf(timed(stream, 40));
      const parsed = parseImf(bytes);
      expect(Array.from(parsed.stream.delayTicks)).toEqual([0, 100]);
    });

    it('upsamples HERAD ~40 Hz to WLF 700 Hz (17.5× multiplier)', () => {
      const stream = makeStream([
        [0x20, 0x01, 0],
        [0xa0, 0x41, 40], // 1 second at 40 Hz
      ]);
      const bytes = encodeImf(timed(stream, 40), { targetTickRate: 700 });
      const parsed = parseImf(bytes);
      // 40 * 700 / 40 = 700 ticks at 700 Hz = still 1 second real time.
      expect(Array.from(parsed.stream.delayTicks)).toEqual([0, 700]);
    });

    it('downsamples DRO 1000 Hz to IMF 560 Hz', () => {
      const stream = makeStream([
        [0x20, 0x01, 0],
        [0xa0, 0x41, 1000], // 1 second at 1 kHz
      ]);
      const bytes = encodeImf(timed(stream, 1000), { targetTickRate: 560 });
      const parsed = parseImf(bytes);
      // 1000 * 560 / 1000 = 560 ticks at 560 Hz = still 1 second real time.
      expect(Array.from(parsed.stream.delayTicks)).toEqual([0, 560]);
    });

    it('no-ops when source and target rates match', () => {
      const stream = makeStream([
        [0x20, 0x01, 0],
        [0xa0, 0x41, 100],
      ]);
      const bytes = encodeImf(timed(stream, 700), { targetTickRate: 700 });
      const parsed = parseImf(bytes);
      expect(Array.from(parsed.stream.delayTicks)).toEqual([0, 100]);
    });

    it('throws if targetTickRate is set but source has no tickRate', () => {
      const stream = makeStream([
        [0x20, 0x01, 0],
        [0xa0, 0x41, 100],
      ]);
      // { stream } with no tickRate.
      expect(() => encodeImf({ stream }, { targetTickRate: 560 })).toThrow(/tickRate/);
    });

    it('rounds resampled delays to the nearest integer tick', () => {
      // 100 * 700 / 43 = 1627.906... → rounds to 1628.
      const stream = makeStream([
        [0x20, 0x01, 0],
        [0xa0, 0x41, 100],
      ]);
      const bytes = encodeImf(timed(stream, 43), { targetTickRate: 700 });
      const parsed = parseImf(bytes);
      expect(parsed.stream.delayTicks[1]).toBe(1628);
    });
  });
});

describe('encodeImf — real files', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, '../../../../../examples/herad/data');

  it('round-trips real IMF content (structural: count + register sequence)', async () => {
    // IMF files aren't provided in the repo (they're game data), but if any
    // appear here we'll round-trip them. We piggyback on the HERAD samples
    // directory; use a generic name pattern.
    const path = resolve(dataDir, 'test.imf');
    if (!(await fileExists(path))) {
      console.warn('[imf encoder test] no test.imf present — skipping real-file roundtrip');
      return;
    }
    const bytes = new Uint8Array(await readFile(path));
    const parsed = parseImf(bytes);
    const reencoded = encodeImf({ stream: parsed.stream, tickRate: 700 });
    const reparsed = parseImf(reencoded);
    expect(reparsed.stream.regs.length).toBe(parsed.stream.regs.length);
    expect(Array.from(reparsed.stream.regs)).toEqual(Array.from(parsed.stream.regs));
    expect(Array.from(reparsed.stream.values)).toEqual(Array.from(parsed.stream.values));
    expect(Array.from(reparsed.stream.delayTicks)).toEqual(Array.from(parsed.stream.delayTicks));
  });
});
