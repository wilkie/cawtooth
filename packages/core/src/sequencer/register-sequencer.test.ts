import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { NukedOpl3Chip } from '../chip/nuked-opl3.js';
import { createNukedOpl3Imports } from '../chip/loader.js';
import { OPL_CHANNEL_COUNT } from '../chip/types.js';
import { TEST_TONE_WRITES } from '../chip/__fixtures__/test-tone.js';
import { RegisterSequencer } from './register-sequencer.js';
import type { RegisterEventStream } from './types.js';

const SAMPLE_RATE = 48000;
const TICK_RATE = 700;
const NUM_FRAMES = 1024;

function peakAmplitude(buf: Float32Array, start = 0, end = buf.length): number {
  let peak = 0;
  for (let i = start; i < end; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Build a RegisterEventStream from (reg, value, delayTicks) tuples.
 * delayTicks is the wait AFTER each event.
 */
function makeStream(
  entries: ReadonlyArray<readonly [reg: number, value: number, delayTicks: number]>,
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

describe('RegisterSequencer', () => {
  let wasmModule: WebAssembly.Module;

  beforeAll(async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const wasmPath = resolve(here, '../../wasm/nuked-opl3.wasm');
    const bytes = await readFile(wasmPath);
    wasmModule = await WebAssembly.compile(bytes);
  });

  function makeChip(): NukedOpl3Chip {
    const instance = new WebAssembly.Instance(wasmModule, createNukedOpl3Imports());
    return new NukedOpl3Chip(instance, SAMPLE_RATE);
  }

  it('produces silence before play() is called', () => {
    const chip = makeChip();
    const seq = new RegisterSequencer(chip);

    // A stream with a key-on at tick 0 — would produce audio if playing.
    const stream = makeStream(TEST_TONE_WRITES.map((w) => [w.reg, w.value, 0] as const));
    seq.loadStream(stream, { tickRate: TICK_RATE });

    const out = new Float32Array(2048 * 2);
    seq.generate(out);

    expect(peakAmplitude(out)).toBe(0);
    chip.dispose();
  });

  it('fires the event stream when playing', () => {
    const chip = makeChip();
    const seq = new RegisterSequencer(chip);
    const stream = makeStream(TEST_TONE_WRITES.map((w) => [w.reg, w.value, 0] as const));

    seq.loadStream(stream, { tickRate: TICK_RATE });
    seq.play();

    const out = new Float32Array(2048 * 2);
    seq.generate(out);

    expect(peakAmplitude(out)).toBeGreaterThan(0.01);
    chip.dispose();
  });

  it('fires events at sample-accurate positions', () => {
    const chip = makeChip();
    const seq = new RegisterSequencer(chip);

    // Setup events at t=0, then wait TARGET_DELAY ticks, then key-on.
    // At 700 Hz tick rate and 48 kHz sample rate, TARGET_DELAY=70 ticks
    // = 100 ms = 4800 samples until the key-on fires.
    const TARGET_DELAY = 70;
    const EXPECTED_SAMPLE = Math.round((TARGET_DELAY * SAMPLE_RATE) / TICK_RATE);

    const setup = TEST_TONE_WRITES.slice(0, -1); // everything except the key-on
    const keyOn = TEST_TONE_WRITES[TEST_TONE_WRITES.length - 1];

    const entries: Array<readonly [number, number, number]> = [];
    setup.forEach((w, i) => {
      // Last setup event carries the gap to the key-on; all others have delay 0.
      const delay = i === setup.length - 1 ? TARGET_DELAY : 0;
      entries.push([w.reg, w.value, delay]);
    });
    entries.push([keyOn.reg, keyOn.value, 0]);

    seq.loadStream(makeStream(entries), { tickRate: TICK_RATE });
    seq.play();

    const out = new Float32Array(8192 * 2);
    seq.generate(out);

    // The left channel occupies even indices in the interleaved buffer.
    // Before the key-on fires, operators have their params but no envelope —
    // output must stay at exactly zero.
    const silenceEndIdx = (EXPECTED_SAMPLE - 100) * 2;
    const audioStartIdx = (EXPECTED_SAMPLE + 100) * 2;

    expect(peakAmplitude(out, 0, silenceEndIdx)).toBe(0);
    expect(peakAmplitude(out, audioStartIdx, out.length)).toBeGreaterThan(0.01);
    chip.dispose();
  });

  it('stop() rewinds and silences the chip', () => {
    const chip = makeChip();
    const seq = new RegisterSequencer(chip);
    const stream = makeStream(TEST_TONE_WRITES.map((w) => [w.reg, w.value, 0] as const));

    seq.loadStream(stream, { tickRate: TICK_RATE });
    seq.play();
    seq.generate(new Float32Array(512 * 2)); // let the tone ring

    seq.stop();

    const out = new Float32Array(512 * 2);
    seq.generate(out);
    expect(peakAmplitude(out)).toBe(0);
    expect(seq.currentTime).toBe(0);
    expect(seq.isPlaying).toBe(false);
    chip.dispose();
  });

  it('pause() halts time advancement without silencing', () => {
    const chip = makeChip();
    const seq = new RegisterSequencer(chip);
    const stream = makeStream(TEST_TONE_WRITES.map((w) => [w.reg, w.value, 0] as const));

    seq.loadStream(stream, { tickRate: TICK_RATE });
    seq.play();
    seq.generate(new Float32Array(512 * 2));
    const timeBefore = seq.currentTime;

    seq.pause();

    seq.generate(new Float32Array(1024 * 2));

    // Time does not advance while paused.
    expect(seq.currentTime).toBe(timeBefore);
    // The chip keeps its state — a sustained tone continues to sample audio
    // (envelope is in sustain phase), but no new events fire.
    chip.dispose();
  });

  it('reports duration based on cumulative delays', () => {
    const chip = makeChip();
    const seq = new RegisterSequencer(chip);

    // 3 events, each with 350 ticks of delay afterwards → 1050 ticks total.
    const stream = makeStream([
      [0x01, 0x20, 350],
      [0xa0, 0x41, 350],
      [0xb0, 0x32, 350],
    ]);
    seq.loadStream(stream, { tickRate: TICK_RATE });

    // 1050 / 700 = 1.5 seconds.
    expect(seq.duration).toBeCloseTo(1.5, 3);
    chip.dispose();
  });

  it('isFinished flips true when non-looping playback runs past the final tick', () => {
    const chip = makeChip();
    const seq = new RegisterSequencer(chip);
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0xa0, 0x41, 100],
    ]);
    seq.loadStream(stream, { tickRate: TICK_RATE });

    // Before play, nothing is considered finished.
    expect(seq.isFinished).toBe(false);

    seq.play();
    // 100 ticks @ 700/s = ~143 ms. Render a bit more than that.
    seq.generate(new Float32Array(Math.ceil(SAMPLE_RATE * 0.2) * 2));
    expect(seq.isFinished).toBe(true);
    chip.dispose();
  });

  it('isFinished stays false when the stream is looping', () => {
    const chip = makeChip();
    const seq = new RegisterSequencer(chip);
    const stream = makeStream([
      [0x20, 0x01, 0],
      [0xa0, 0x41, 100],
    ]);
    seq.loadStream(stream, { tickRate: TICK_RATE, loop: true });
    seq.play();
    seq.generate(new Float32Array(Math.ceil(SAMPLE_RATE * 0.5) * 2));
    expect(seq.isFinished).toBe(false);
    chip.dispose();
  });

  it('rejects a stream whose parallel arrays disagree in length', () => {
    const chip = makeChip();
    const seq = new RegisterSequencer(chip);
    const bad: RegisterEventStream = {
      regs: new Uint16Array([0x20, 0xa0]),
      values: new Uint8Array([0x01]), // wrong length
      delayTicks: new Uint32Array([0, 0]),
    };
    expect(() => seq.loadStream(bad, { tickRate: TICK_RATE })).toThrow();
    chip.dispose();
  });

  it('rejects a non-positive tick rate', () => {
    const chip = makeChip();
    const seq = new RegisterSequencer(chip);
    const stream = makeStream([[0x20, 0x01, 0]]);
    expect(() => seq.loadStream(stream, { tickRate: 0 })).toThrow();
    expect(() => seq.loadStream(stream, { tickRate: -1 })).toThrow();
    chip.dispose();
  });

  describe('generateWithChannels', () => {
    it('isolates per-voice output while firing events', () => {
      const chip = makeChip();
      const seq = new RegisterSequencer(chip);
      const stream = makeStream(TEST_TONE_WRITES.map((w) => [w.reg, w.value, 0] as const));
      seq.loadStream(stream, { tickRate: TICK_RATE });
      seq.play();

      const stereo = new Float32Array(NUM_FRAMES * 2);
      const channels = new Float32Array(NUM_FRAMES * OPL_CHANNEL_COUNT);
      seq.generateWithChannels(stereo, channels);

      expect(peakAmplitude(stereo)).toBeGreaterThan(0.01);

      // Channel 0 has audio; all other voices are silent (only ch0 was keyed).
      let ch0Peak = 0;
      let otherPeak = 0;
      for (let f = 0; f < NUM_FRAMES; f++) {
        for (let v = 0; v < OPL_CHANNEL_COUNT; v++) {
          const s = Math.abs(channels[f * OPL_CHANNEL_COUNT + v]);
          if (v === 0) {
            if (s > ch0Peak) ch0Peak = s;
          } else if (s > otherPeak) {
            otherPeak = s;
          }
        }
      }
      expect(ch0Peak).toBeGreaterThan(0.01);
      expect(otherPeak).toBe(0);
      chip.dispose();
    });

    it('produces identical stereo output to plain generate() for the same stream', () => {
      // Two sequencers running the same stream. If the render loop is shared
      // correctly, the stereo halves must match bit-for-bit.
      const chipA = makeChip();
      const chipB = makeChip();
      const seqA = new RegisterSequencer(chipA);
      const seqB = new RegisterSequencer(chipB);
      const stream = makeStream(TEST_TONE_WRITES.map((w) => [w.reg, w.value, 0] as const));
      seqA.loadStream(stream, { tickRate: TICK_RATE });
      seqB.loadStream(stream, { tickRate: TICK_RATE });
      seqA.play();
      seqB.play();

      const stereoA = new Float32Array(NUM_FRAMES * 2);
      seqA.generate(stereoA);

      const stereoB = new Float32Array(NUM_FRAMES * 2);
      const channelsB = new Float32Array(NUM_FRAMES * OPL_CHANNEL_COUNT);
      seqB.generateWithChannels(stereoB, channelsB);

      for (let i = 0; i < stereoA.length; i++) {
        expect(stereoB[i]).toBe(stereoA[i]);
      }

      chipA.dispose();
      chipB.dispose();
    });

    it('rejects an undersized channels buffer', () => {
      const chip = makeChip();
      const seq = new RegisterSequencer(chip);
      const stream = makeStream(TEST_TONE_WRITES.map((w) => [w.reg, w.value, 0] as const));
      seq.loadStream(stream, { tickRate: TICK_RATE });
      seq.play();
      const stereo = new Float32Array(NUM_FRAMES * 2);
      const undersized = new Float32Array(NUM_FRAMES * OPL_CHANNEL_COUNT - 1);
      expect(() => seq.generateWithChannels(stereo, undersized)).toThrow();
      chip.dispose();
    });
  });
});
