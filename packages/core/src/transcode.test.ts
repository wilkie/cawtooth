import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseOpl } from './transcode.js';
import { encodeImf } from './formats/imf/encoder.js';
import { encodeDro } from './formats/dro/encoder.js';
import type { RegisterEventStream, TimedRegisterStream } from './sequencer/types.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build a tiny but realistic stream — three OPL register writes with
 * non-zero delays — used as the input for round-trip tests through the
 * encoders. Same data shape the parsers produce.
 */
function makeTinyStream(): TimedRegisterStream {
  const regs = new Uint16Array([0x20, 0xa0, 0xb0]);
  const values = new Uint8Array([0x01, 0x41, 0x32]);
  const delayTicks = new Uint32Array([10, 20, 30]);
  const stream: RegisterEventStream = { regs, values, delayTicks };
  return { stream, tickRate: 700 };
}

describe('parseOpl', () => {
  it('round-trips an IMF stream and applies the default tick rate', () => {
    const original = makeTinyStream();
    // encodeImf accepts either a TimedRegisterStream or just the stream
    // wrapper — IMF on disk doesn't store a tick rate, so we hand the
    // tick rate back in via options at parseOpl time.
    const bytes = encodeImf(original);

    const parsed = parseOpl(bytes, { filename: 'tune.imf' });
    expect(parsed).not.toBeNull();
    expect(parsed!.tickRate).toBe(700);
    expect(Array.from(parsed!.stream.regs)).toEqual(Array.from(original.stream.regs));
    expect(Array.from(parsed!.stream.values)).toEqual(Array.from(original.stream.values));
    expect(Array.from(parsed!.stream.delayTicks)).toEqual(Array.from(original.stream.delayTicks));
  });

  it('honours an explicit tickRate override for IMF', () => {
    const bytes = encodeImf(makeTinyStream());
    const parsed = parseOpl(bytes, { filename: 'tune.imf', tickRate: 560 });
    expect(parsed?.tickRate).toBe(560);
  });

  it('round-trips a DRO and uses its embedded tick rate (1000 Hz)', () => {
    // DRO encodes wall-clock delays in milliseconds, so its tick rate is
    // always 1000 — the parser pulls this out of the file, not options.
    const bytes = encodeDro(makeTinyStream());
    const parsed = parseOpl(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.tickRate).toBe(1000);
    // Stream contents survive the round-trip; only the timing axis is
    // re-quantized to ms (so we don't compare delayTicks exactly).
    expect(Array.from(parsed!.stream.regs)).toEqual([0x20, 0xa0, 0xb0]);
    expect(Array.from(parsed!.stream.values)).toEqual([0x01, 0x41, 0x32]);
  });

  it('parses an HSQ-compressed HERAD song into a register stream', async () => {
    // SAVAGE.HSQ is one of the smaller HERAD samples bundled with the
    // herad demo — small enough to keep this test snappy. The renderer
    // produces a stream whose tickRate is derived from the song's speed.
    const path = resolve(here, '../../../examples/herad/data/SAVAGE.HSQ');
    const bytes = await readFile(path);
    const parsed = parseOpl(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.tickRate).toBeGreaterThan(0);
    expect(parsed!.stream.regs.length).toBeGreaterThan(0);
  });

  it('returns null for PSID bytes (non-OPL format)', () => {
    // Minimal 4-byte PSID magic is enough for detectFormat — parseOpl
    // doesn't actually try to parse it, so this stays valid even though
    // the rest of a real PSID header is missing.
    const bytes = new Uint8Array([0x50, 0x53, 0x49, 0x44, 0, 0, 0, 0]);
    expect(parseOpl(bytes)).toBeNull();
  });

  it('honours an explicit format override (skips detection entirely)', () => {
    // IMF has no magic, so without `format` an unhinted call would
    // throw. Passing format='imf' bypasses sniffing.
    const bytes = encodeImf(makeTinyStream());
    const parsed = parseOpl(bytes, { format: 'imf' });
    expect(parsed?.tickRate).toBe(700);
  });

  it('accepts ArrayBuffer input as well as Uint8Array', () => {
    const bytes = encodeImf(makeTinyStream());
    // Copy into a fresh ArrayBuffer so the test isn't relying on the
    // Uint8Array's existing buffer alias.
    const buf = new ArrayBuffer(bytes.length);
    new Uint8Array(buf).set(bytes);
    const parsed = parseOpl(buf, { filename: 'tune.imf' });
    expect(parsed).not.toBeNull();
    expect(parsed!.stream.regs.length).toBe(3);
  });

  it('throws when bytes are unrecognized and no filename or format is given', () => {
    const bytes = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => parseOpl(bytes)).toThrow(/could not detect format/);
  });
});
