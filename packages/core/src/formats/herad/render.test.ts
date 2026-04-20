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

  it('WORMINTR.AGD enables OPL3 mode and uses upper-bank voices', async () => {
    const song = await loadSong('WORMINTR.AGD');
    if (!song) return;
    expect(song.isAgd).toBe(true);
    const stream = renderHeradToStream(song);

    // First write should be 0x105 = 1 (OPL3 enable) for an AGD song.
    expect(stream.stream.regs[0]).toBe(0x105);
    expect(stream.stream.values[0]).toBe(1);

    // At least one register write should target the upper bank (reg >= 0x100
    // AND != 0x105), confirming voices 9+ are actually used.
    let upperBankWrites = 0;
    for (let i = 0; i < stream.stream.regs.length; i++) {
      if (stream.stream.regs[i] >= 0x100 && stream.stream.regs[i] !== 0x105) {
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
});
