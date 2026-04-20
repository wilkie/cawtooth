import { parseImf } from './parser.js';

/**
 * Build a raw IMF event stream (no type-1 header) from a list of events.
 * Each event is 4 bytes: reg, val, delayLow, delayHigh.
 */
function eventBytes(events: Array<{ reg: number; val: number; delay: number }>): Uint8Array {
  const out = new Uint8Array(events.length * 4);
  events.forEach(({ reg, val, delay }, i) => {
    out[i * 4] = reg & 0xff;
    out[i * 4 + 1] = val & 0xff;
    out[i * 4 + 2] = delay & 0xff;
    out[i * 4 + 3] = (delay >> 8) & 0xff;
  });
  return out;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function u16le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

function nullTerminated(s: string): Uint8Array {
  const out = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  out[s.length] = 0;
  return out;
}

describe('parseImf', () => {
  it('parses a type-0 (no header) stream', () => {
    const bytes = eventBytes([
      { reg: 0xa0, val: 0x41, delay: 0 },
      { reg: 0xb0, val: 0x32, delay: 100 },
      { reg: 0xb0, val: 0x12, delay: 0 },
    ]);

    const song = parseImf(bytes);

    expect(song.variant).toBe('type0');
    expect(Array.from(song.stream.regs)).toEqual([0xa0, 0xb0, 0xb0]);
    expect(Array.from(song.stream.values)).toEqual([0x41, 0x32, 0x12]);
    expect(Array.from(song.stream.delayTicks)).toEqual([0, 100, 0]);
  });

  it('parses a type-1 stream with a length header', () => {
    const events = eventBytes([
      { reg: 0x20, val: 0x01, delay: 0 },
      { reg: 0xa0, val: 0x41, delay: 50 },
      { reg: 0xb0, val: 0x32, delay: 200 },
    ]);
    const bytes = concat(u16le(events.length), events);

    const song = parseImf(bytes);

    expect(song.variant).toBe('type1');
    expect(song.stream.regs.length).toBe(3);
    expect(Array.from(song.stream.delayTicks)).toEqual([0, 50, 200]);
  });

  it('falls back to type-0 when the declared type-1 length overruns the file', () => {
    // Header claims 12 bytes of events but only 2 events (8 bytes) follow.
    // Auto-detection can't trust the header here, so it reads the whole
    // file as raw events. The first 2 bytes are then interpreted as the
    // first event's reg+val pair, not as a length.
    const events = eventBytes([
      { reg: 0x10, val: 0x20, delay: 0 },
      { reg: 0x30, val: 0x40, delay: 10 },
    ]);
    const bytes = concat(u16le(12), events);

    const song = parseImf(bytes);

    expect(song.variant).toBe('type0');
  });

  it('clips when the caller forces type-1 and the header overstates the length', () => {
    // Same overstated file, but the caller insists it's type-1. We trust
    // the intent and play what fits.
    const events = eventBytes([
      { reg: 0x10, val: 0x20, delay: 0 },
      { reg: 0x30, val: 0x40, delay: 10 },
    ]);
    const bytes = concat(u16le(12), events);

    const song = parseImf(bytes, { variant: 'type1' });

    expect(song.variant).toBe('type1');
    expect(song.stream.regs.length).toBe(2);
    expect(Array.from(song.stream.regs)).toEqual([0x10, 0x30]);
  });

  it('reads trailing metadata after the event stream', () => {
    const events = eventBytes([{ reg: 0xa0, val: 0x41, delay: 0 }]);
    const metadata = concat(
      new Uint8Array([0x1a]),
      nullTerminated('Song Title'),
      nullTerminated('Bobby Prince'),
      nullTerminated('Test Remarks'),
    );
    const bytes = concat(u16le(events.length), events, metadata);

    const song = parseImf(bytes);

    expect(song.title).toBe('Song Title');
    expect(song.source).toBe('Bobby Prince');
    expect(song.remarks).toBe('Test Remarks');
  });

  it('tolerates missing 0x1A marker before metadata', () => {
    const events = eventBytes([{ reg: 0xa0, val: 0x41, delay: 0 }]);
    const metadata = concat(
      nullTerminated('No Marker'),
      nullTerminated('Composer'),
      nullTerminated(''),
    );
    const bytes = concat(u16le(events.length), events, metadata);

    const song = parseImf(bytes);

    expect(song.title).toBe('No Marker');
    expect(song.source).toBe('Composer');
  });

  it('ignores a trailing partial event', () => {
    // 8 bytes of valid events + 2 extra bytes that don't form a complete event.
    const events = eventBytes([
      { reg: 0xa0, val: 0x41, delay: 0 },
      { reg: 0xb0, val: 0x32, delay: 100 },
    ]);
    const bytes = concat(events, new Uint8Array([0x99, 0x88]));

    const song = parseImf(bytes);

    // 2 complete events; trailing 2 bytes become metadata leftovers rather than events.
    expect(song.stream.regs.length).toBe(2);
  });

  it('handles an empty file as type-0 with zero events', () => {
    const song = parseImf(new Uint8Array(0));
    expect(song.variant).toBe('type0');
    expect(song.stream.regs.length).toBe(0);
  });

  it('respects forced variant option', () => {
    // Bytes that would auto-detect as type-1 (first u16 is a multiple of 4
    // that fits within the file). Forcing type-0 should read them as events.
    const firstU16AsEventsLen = 4;
    const events = eventBytes([{ reg: 0xa0, val: 0x41, delay: 0 }]);
    const bytes = concat(u16le(firstU16AsEventsLen), events);

    const auto = parseImf(bytes);
    expect(auto.variant).toBe('type1');

    const forced = parseImf(bytes, { variant: 'type0' });
    expect(forced.variant).toBe('type0');
    // 6 bytes total → 1 complete event (bytes 0-3); the remaining 2 bytes are trailing.
    expect(forced.stream.regs.length).toBe(1);
  });
});
