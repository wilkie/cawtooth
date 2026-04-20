import { encodeDro } from './encoder.js';
import { parseDro } from './parser.js';
import { encodeImf } from '../imf/encoder.js';
import { parseImf } from '../imf/parser.js';
import type { RegisterEventStream, TimedRegisterStream } from '../../sequencer/types.js';

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

function timed(stream: RegisterEventStream, tickRate = 1000): TimedRegisterStream {
  return { stream, tickRate };
}

describe('encodeDro', () => {
  it('produces a valid v2 file that parseDro accepts', () => {
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0xa0, 0x41, 50],
      [0xb0, 0x32, 0],
    ]);
    const bytes = encodeDro(timed(stream));
    const parsed = parseDro(bytes);
    expect(parsed.variant).toBe('v2');
  });

  it('round-trips register sequence and delays when tickRate is 1 ms', () => {
    // Using tickRate=1000 Hz means ticks == ms, so rounding is exact.
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0xa0, 0x41, 50],
      [0x40, 0x10, 0],
      [0xb0, 0x32, 250],
    ]);
    const bytes = encodeDro(timed(stream, 1000));
    const parsed = parseDro(bytes);
    expect(Array.from(parsed.stream.regs)).toEqual(Array.from(stream.regs));
    expect(Array.from(parsed.stream.values)).toEqual(Array.from(stream.values));
    expect(Array.from(parsed.stream.delayTicks)).toEqual(Array.from(stream.delayTicks));
  });

  it('encodes OPL3 upper-bank writes with the high-bit cmd flag', () => {
    const stream = makeStream([
      [0x105, 0x01, 0], // upper bank
      [0x20, 0x01, 0], // lower bank
    ]);
    const bytes = encodeDro(timed(stream));
    const parsed = parseDro(bytes);
    expect(parsed.hardware).toBe('opl3');
    expect(parsed.stream.regs[0]).toBe(0x105);
    expect(parsed.stream.regs[1]).toBe(0x20);
  });

  it('reports opl2 hardware when no upper-bank writes are present', () => {
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0xa0, 0x41, 10],
    ]);
    const bytes = encodeDro(timed(stream));
    const parsed = parseDro(bytes);
    expect(parsed.hardware).toBe('opl2');
  });

  it('splits long delays into long + short delay pairs', () => {
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0xa0, 0x41, 3000], // trailing delay > 256 ms, forces a long-delay pair
    ]);
    const bytes = encodeDro(timed(stream, 1000));
    const parsed = parseDro(bytes);
    // 3000 ms is encoded as (long, 10) → 2816 ms, then (short, 183) → 184 ms.
    // The parser attaches it to the final event (round-trip preserved).
    expect(Array.from(parsed.stream.delayTicks)).toEqual([0, 3000]);
  });

  it('computes the total-duration header field', () => {
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0xa0, 0x41, 100],
      [0x40, 0x10, 200],
      [0xb0, 0x32, 0],
    ]);
    const bytes = encodeDro(timed(stream, 1000));
    const parsed = parseDro(bytes);
    expect(parsed.durationMs).toBe(300);
  });

  it('converts tick units to milliseconds via tickRate', () => {
    // tickRate=500 Hz means each tick is 2 ms. Trailing delay on the
    // final event, so it lands on that event post-parse.
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0xa0, 0x41, 50], // 50 ticks * 2 ms = 100 ms
    ]);
    const bytes = encodeDro(timed(stream, 500));
    const parsed = parseDro(bytes);
    expect(Array.from(parsed.stream.delayTicks)).toEqual([0, 100]);
  });
});

describe('IMF ↔ DRO cross-format', () => {
  it('encodes then decodes across formats preserving event sequence', () => {
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0xa0, 0x41, 100],
      [0xb0, 0x32, 0],
      [0x40, 0x10, 50],
    ]);

    // Go IMF → bytes → stream, then stream → DRO → bytes → stream.
    // Both encodings should preserve the event sequence; the delay units
    // pass through correctly because we provide matching tickRates (1 kHz
    // = 1 ms per tick, so IMF's u16 delays and DRO's millisecond delays
    // align exactly).
    const imfBytes = encodeImf(timed(stream, 1000));
    const viaImf = parseImf(imfBytes).stream;
    expect(Array.from(viaImf.regs)).toEqual(Array.from(stream.regs));

    const droBytes = encodeDro(timed(viaImf, 1000));
    const viaDro = parseDro(droBytes).stream;
    expect(Array.from(viaDro.regs)).toEqual(Array.from(stream.regs));
    expect(Array.from(viaDro.values)).toEqual(Array.from(stream.values));
    expect(Array.from(viaDro.delayTicks)).toEqual(Array.from(stream.delayTicks));
  });
});
