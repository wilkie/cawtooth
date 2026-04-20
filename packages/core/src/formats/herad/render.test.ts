import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { NukedOpl3Chip } from '../../chip/nuked-opl3.js';
import { OPL_CHANNEL_COUNT } from '../../chip/types.js';
import { createNukedOpl3Imports } from '../../chip/loader.js';
import { RegisterSequencer } from '../../sequencer/register-sequencer.js';
import { parseHeradTrack } from './events.js';
import { parseHerad } from './parser.js';
import { renderHeradToStream } from './render.js';

const SAMPLE_RATE = 48000;

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function peak(buf: Float32Array, start = 0, end = buf.length): number {
  let p = 0;
  for (let i = start; i < end; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

describe('parseHeradTrack', () => {
  it('decodes a short VLQ delay + note-on + note-off sequence', () => {
    // Layout: [delay=10][0x90=noteOn][note=60][vel=100][delay=5][0x80=noteOff][note=60][vel=64][0xFF end]
    const bytes = new Uint8Array([0x0a, 0x90, 60, 100, 0x05, 0x80, 60, 64, 0xff]);
    const events = parseHeradTrack(bytes, { variant: 'v1' });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      delayTicks: 10,
      event: { type: 'noteOn', note: 60, velocity: 100 },
    });
    expect(events[1]).toEqual({
      delayTicks: 5,
      event: { type: 'noteOff', note: 60, velocity: 64 },
    });
  });

  it('reads multi-byte VLQ delays (high bit = continuation)', () => {
    // Delay = 0x81 0x40 → 1 * 128 + 64 = 192.
    const bytes = new Uint8Array([0x81, 0x40, 0x90, 60, 100, 0xff]);
    const events = parseHeradTrack(bytes, { variant: 'v1' });
    expect(events[0].delayTicks).toBe(192);
  });

  it('v2 note-off omits the velocity byte', () => {
    const bytes = new Uint8Array([0x00, 0x80, 60, 0xff]);
    const events = parseHeradTrack(bytes, { variant: 'v2' });
    expect(events).toHaveLength(1);
    expect(events[0].event).toEqual({ type: 'noteOff', note: 60, velocity: 0 });
  });

  it('skips 2 bytes for unused 0xA0 and 0xB0 statuses', () => {
    const bytes = new Uint8Array([0, 0xa0, 0x11, 0x22, 0, 0xb0, 0x33, 0x44, 0, 0x90, 60, 64, 0xff]);
    const events = parseHeradTrack(bytes, { variant: 'v1' });
    expect(events).toHaveLength(3);
    expect(events[0].event.type).toBe('unused');
    expect(events[1].event.type).toBe('unused');
    expect(events[2].event).toEqual({ type: 'noteOn', note: 60, velocity: 64 });
  });

  it('terminates on 0xFF without emitting an event for it', () => {
    const bytes = new Uint8Array([0, 0x90, 60, 64, 0, 0xff, 0x99, 0x99]);
    const events = parseHeradTrack(bytes, { variant: 'v1' });
    expect(events).toHaveLength(1); // only the note-on; the 0xFF stops parsing
  });
});

describe('renderHeradToStream — real files', () => {
  let wasmModule: WebAssembly.Module;
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, '../../../../../examples/hsq/data');

  beforeAll(async () => {
    const wasmPath = resolve(here, '../../../wasm/nuked-opl3.wasm');
    wasmModule = await WebAssembly.compile(await readFile(wasmPath));
  });

  async function loadSong(filename: string, variant?: 'v1' | 'v2') {
    const path = resolve(dataDir, filename);
    if (!(await fileExists(path))) return null;
    const bytes = new Uint8Array(await readFile(path));
    return parseHerad(bytes, variant ? { variant } : {});
  }

  function makeChipDrivenBy(stream: ReturnType<typeof renderHeradToStream>) {
    const instance = new WebAssembly.Instance(wasmModule, createNukedOpl3Imports());
    const chip = new NukedOpl3Chip(instance, SAMPLE_RATE);
    const seq = new RegisterSequencer(chip);
    seq.loadStream(stream.stream, { tickRate: stream.tickRate });
    seq.play();
    return { chip, seq };
  }

  it('SAVAGE.HSQ renders and produces audible output', async () => {
    const song = await loadSong('SAVAGE.HSQ');
    if (!song) return;
    const stream = renderHeradToStream(song);

    // The stream should have a sensible tick rate (~40 Hz at wSpeed=0x497).
    const expectedTickRate = (200.299 * 256) / song.speed;
    expect(stream.tickRate).toBeCloseTo(expectedTickRate, 2);

    // Program changes + note-ons mean far more than a dozen register writes.
    expect(stream.stream.regs.length).toBeGreaterThan(100);

    const { chip, seq } = makeChipDrivenBy(stream);
    // 3 seconds is enough to fire through most of SAVAGE's initial
    // orchestration (program changes → note-ons on multiple voices).
    const out = new Float32Array(SAMPLE_RATE * 3 * 2);
    seq.generate(out);

    expect(peak(out)).toBeGreaterThan(0.01);
    chip.dispose();
  });

  it('WORMINTR.HSQ isolates activity across multiple voices', async () => {
    const song = await loadSong('WORMINTR.HSQ');
    if (!song) return;
    const stream = renderHeradToStream(song);
    const { chip, seq } = makeChipDrivenBy(stream);

    const numFrames = SAMPLE_RATE * 3;
    const stereo = new Float32Array(numFrames * 2);
    const channels = new Float32Array(numFrames * OPL_CHANNEL_COUNT);
    seq.generateWithChannels(stereo, channels);

    expect(peak(stereo)).toBeGreaterThan(0.01);

    // Count voices that produce any output. For OPL2 content we expect 9
    // melodic voices available; at least a few should fire within 3 seconds.
    let activeVoices = 0;
    for (let v = 0; v < 9; v++) {
      let voicePeak = 0;
      for (let f = 0; f < numFrames; f++) {
        const a = Math.abs(channels[f * OPL_CHANNEL_COUNT + v]);
        if (a > voicePeak) voicePeak = a;
      }
      if (voicePeak > 0.005) activeVoices++;
    }
    expect(activeVoices).toBeGreaterThan(1);
    chip.dispose();
  });

  it('WORMINTR.AGD performs chip init and uses upper-bank voices', async () => {
    const song = await loadSong('WORMINTR.AGD');
    if (!song) return;
    expect(song.isAgd).toBe(true);
    const stream = renderHeradToStream(song);

    // Chip init (per AdPlug rewind): reg 0x01=0x20 (wave select enable),
    // 0xBD=0 (no percussion), 0x08=0x40 (note-sel), and for AGD 0x105=1
    // (OPL3 enable) and 0x104=0 (disable 4-op). They all fire at tick 0 and
    // appear at the top of the stream.
    const initRegs = new Set<number>();
    for (let i = 0; i < 6; i++) initRegs.add(stream.stream.regs[i]);
    expect(initRegs.has(0x01)).toBe(true);
    expect(initRegs.has(0xbd)).toBe(true);
    expect(initRegs.has(0x08)).toBe(true);
    expect(initRegs.has(0x105)).toBe(true);
    expect(initRegs.has(0x104)).toBe(true);

    // At least one non-init upper-bank write confirms voices 9+ are used.
    let upperBankWrites = 0;
    for (let i = 0; i < stream.stream.regs.length; i++) {
      const r = stream.stream.regs[i];
      if (r >= 0x100 && r !== 0x105 && r !== 0x104) {
        upperBankWrites++;
      }
    }
    expect(upperBankWrites).toBeGreaterThan(0);

    const { chip, seq } = makeChipDrivenBy(stream);
    const out = new Float32Array(SAMPLE_RATE * 2 * 2);
    seq.generate(out);
    expect(peak(out)).toBeGreaterThan(0.005);
    chip.dispose();
  });

  it('OPL2 chip init writes appear at the top of every stream', async () => {
    const song = await loadSong('WORMINTR.HSQ');
    if (!song) return;
    const stream = renderHeradToStream(song);
    // First 3 writes should be the OPL2 init pair (0x01/0xBD/0x08).
    const firstThree = new Set<number>();
    for (let i = 0; i < 3; i++) firstThree.add(stream.stream.regs[i]);
    expect(firstThree.has(0x01)).toBe(true);
    expect(firstThree.has(0xbd)).toBe(true);
    expect(firstThree.has(0x08)).toBe(true);
  });

  it('ALARME.HSQ parses and renders when forced to v2', async () => {
    const song = await loadSong('ALARME.HSQ', 'v2');
    if (!song) return;
    expect(song.variant).toBe('v2');
    const stream = renderHeradToStream(song);
    expect(stream.stream.regs.length).toBeGreaterThan(100);
    const { chip, seq } = makeChipDrivenBy(stream);
    const out = new Float32Array(SAMPLE_RATE * 3 * 2);
    seq.generate(out);
    expect(peak(out)).toBeGreaterThan(0.005);
    chip.dispose();
  });

  it('velocity macros scale output smoothly, preserving dynamics', async () => {
    // Regression check for the old macro math, which clamped the register
    // to 0 or 63 with any non-trivial sensitivity and flattened dynamics.
    // We construct a minimal instrument with mod_out=20 and a positive
    // sensitivity, render note-ons at varying velocities, and verify the
    // 0x40 writes land in a continuous range — not pinned at the extremes.
    //
    // Build a synthetic HERAD song with one track and one patch.
    const tracks: Uint8Array[] = [];
    const events: number[] = [];
    // Program change to instrument 0.
    events.push(0, 0xc0, 0);
    // Note-ons at velocities 0, 32, 64, 96, 127 with a 1-tick delay between.
    for (const vel of [0, 32, 64, 96, 127]) {
      events.push(1, 0x90, 60, vel);
    }
    events.push(0, 0xff);
    tracks.push(new Uint8Array(events));

    // Instrument: mode=0 SDB1; mod_out=20 at offset 10; mc_mod_out_vel=10 at
    // offset 30. Everything else zero.
    const raw = new Uint8Array(40);
    raw[10] = 20; // mod_out
    raw[30] = 10; // mc_mod_out_vel (positive sensitivity)

    const song = {
      variant: 'v1' as const,
      isAgd: false,
      speed: 0x0100,
      loopStart: 0,
      loopEnd: 0,
      loopCount: 0,
      tracks,
      instruments: [{ kind: 'patch' as const, mode: 0 as const, raw }],
    };

    const stream = renderHeradToStream(song);

    // Collect writes to register 0x40 (modulator output, slot 0). After the
    // initial program-change write, each note-on adds one velocity-scaled
    // write. We expect 6: 1 from programChange + 5 from note-ons.
    const modOutWrites: number[] = [];
    for (let i = 0; i < stream.stream.regs.length; i++) {
      if (stream.stream.regs[i] === 0x40) {
        modOutWrites.push(stream.stream.values[i] & 0x3f);
      }
    }
    expect(modOutWrites.length).toBeGreaterThanOrEqual(6);

    // The 5 velocity-scaled values (skipping index 0 from the programChange)
    // should be monotonically non-increasing — louder velocity → lower
    // register value → louder output. Also: NONE should pin at 0 or 63,
    // confirming the dynamic range actually uses the middle of the scale.
    const scaled = modOutWrites.slice(1, 6);
    for (let i = 1; i < scaled.length; i++) {
      expect(scaled[i]).toBeLessThanOrEqual(scaled[i - 1]);
    }
    // First value (velocity 0) is the quietest, last (127) is the loudest.
    expect(scaled[0]).toBeGreaterThan(scaled[scaled.length - 1]);
    // None should have saturated.
    for (const v of scaled) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(63);
    }
  });

  it('songs with slide instruments emit intermediate pitch updates', async () => {
    // Find a song whose renderer output includes multiple 0xB0 writes on the
    // same voice between note-on and note-off, which is what slide produces.
    // SAVAGE is a reliable choice — Dune's music uses HERAD slides heavily.
    const song = await loadSong('SAVAGE.HSQ');
    if (!song) return;
    const stream = renderHeradToStream(song);

    // Count 0xB0 writes for voice 0 (reg 0xB0 low bank).
    let b0Writes = 0;
    for (let i = 0; i < stream.stream.regs.length; i++) {
      if (stream.stream.regs[i] === 0xb0) b0Writes++;
    }
    // Without slide: one 0xB0 per note-on and note-off → ~(2 × note count).
    // With slide: every tick of a held slide adds a 0xB0 write. If slides
    // exist in the song, we'll see substantially more 0xB0 writes than
    // note events alone would produce.
    expect(b0Writes).toBeGreaterThan(100);
  });
});
