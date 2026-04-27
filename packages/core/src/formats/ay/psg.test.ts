import { describe, expect, it } from '@jest/globals';
import { parsePsg } from './psg.js';

/** Build a minimal PSG header with the given tick rate byte. */
function header(rateByte = 0): number[] {
  return [
    0x50,
    0x53,
    0x47,
    0x1a, // magic
    0x10, // version (informational)
    rateByte, // frame rate (0 = default 50 Hz)
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // reserved
  ];
}

function bytes(...parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

describe('parsePsg', () => {
  it('rejects files smaller than the 16-byte header', () => {
    expect(() => parsePsg(new Uint8Array(8))).toThrow(/too short/);
  });

  it('rejects files without the PSG\\x1A magic', () => {
    const bad = new Uint8Array(32);
    bad[0] = 0x42; // 'B'
    expect(() => parsePsg(bad)).toThrow(/magic/);
  });

  it('defaults to 50 Hz when the rate byte is 0', () => {
    const file = bytes(header(0), [0x00, 0x12, 0xff, 0xfd]);
    expect(parsePsg(file).tickRate).toBe(50);
  });

  it('reads a non-zero rate byte verbatim (e.g. 60 Hz)', () => {
    const file = bytes(header(60), [0x00, 0x12, 0xff, 0xfd]);
    expect(parsePsg(file).tickRate).toBe(60);
  });

  it('emits one event per (reg, value) pair with delay=0 inside a frame', () => {
    // Single frame: write R0=0x12, R1=0x34, then end-of-frame, then EOM.
    const file = bytes(header(), [0x00, 0x12, 0x01, 0x34, 0xff, 0xfd]);
    const song = parsePsg(file);
    expect(Array.from(song.stream.regs)).toEqual([0, 1]);
    expect(Array.from(song.stream.values)).toEqual([0x12, 0x34]);
    // First event is sibling to second (no delay between them); the
    // trailing 0xFF tick attaches to the second event's delay.
    expect(Array.from(song.stream.delayTicks)).toEqual([0, 1]);
  });

  it('attaches accumulated 0xFF delays to the previous event', () => {
    // R0=1, frame, frame, frame, R1=2, EOM
    // Three frame markers between events → previous event's delay = 3.
    const file = bytes(header(), [0x00, 0x01, 0xff, 0xff, 0xff, 0x01, 0x02, 0xfd]);
    const song = parsePsg(file);
    expect(Array.from(song.stream.delayTicks)).toEqual([3, 0]);
  });

  it('expands 0xFE n into n*4 ticks of delay', () => {
    // R0=1, FE 5 (= 20 frames), R1=2, EOM
    const file = bytes(header(), [0x00, 0x01, 0xfe, 0x05, 0x01, 0x02, 0xfd]);
    const song = parsePsg(file);
    expect(Array.from(song.stream.delayTicks)).toEqual([20, 0]);
  });

  it('combines 0xFE and 0xFF deltas into one pending delay', () => {
    // R0=1, FE 2 (=8), FF (+1), FF (+1), R1=2, EOM → delay=10
    const file = bytes(header(), [0x00, 0x01, 0xfe, 0x02, 0xff, 0xff, 0x01, 0x02, 0xfd]);
    const song = parsePsg(file);
    expect(Array.from(song.stream.delayTicks)).toEqual([10, 0]);
  });

  it('treats trailing frames after the last write as end-padding', () => {
    // R0=1, FF FF, EOM → final event carries 2 frames of tail.
    const file = bytes(header(), [0x00, 0x01, 0xff, 0xff, 0xfd]);
    const song = parsePsg(file);
    expect(Array.from(song.stream.delayTicks)).toEqual([2]);
  });

  it('tolerates EOF without an explicit 0xFD terminator', () => {
    const file = bytes(header(), [0x00, 0x01, 0xff]);
    const song = parsePsg(file);
    expect(Array.from(song.stream.regs)).toEqual([0]);
    expect(Array.from(song.stream.delayTicks)).toEqual([1]);
  });

  it('rejects a file with no register writes', () => {
    const file = bytes(header(), [0xff, 0xff, 0xfd]);
    expect(() => parsePsg(file)).toThrow(/no register writes/);
  });

  it('rejects a truncated 0xFE skip opcode', () => {
    const file = bytes(header(), [0xfe]); // missing the count byte
    expect(() => parsePsg(file)).toThrow(/truncated 0xFE/);
  });

  it('rejects a register write missing its value byte', () => {
    const file = bytes(header(), [0x00]); // reg without value
    expect(() => parsePsg(file)).toThrow(/truncated register write/);
  });

  it('masks register addresses to 4 bits', () => {
    // 0x70 should be treated as register 0 (capture tools occasionally
    // set the upper nibble to flags; we ignore them).
    const file = bytes(header(), [0x70, 0x42, 0xff, 0xfd]);
    const song = parsePsg(file);
    expect(song.stream.regs[0]).toBe(0);
    expect(song.stream.values[0]).toBe(0x42);
  });

  it('returns sensible defaults for metadata not encoded in the file', () => {
    const file = bytes(header(), [0x00, 0x01, 0xff, 0xfd]);
    const song = parsePsg(file);
    expect(song.container).toBe('psg');
    expect(song.model).toBe('AY-3-8910');
    expect(song.clockFrequency).toBe(1773400);
    expect(song.title).toBe('');
    expect(song.author).toBe('');
    expect(song.loop).toBe(false);
  });
});
