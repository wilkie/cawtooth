import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { beforeAll, describe, expect, it } from '@jest/globals';

import { parseSndh } from './parser.js';
import {
  ATARI_ST_PAL_CLOCK,
  ATARI_ST_YM2149_CLOCK,
  SNDH_VOICE_COUNT,
  SndhTune,
} from './runtime.js';
import { createSndhImports } from './sndh-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 44100;

const FIXTURE = resolve(HERE, '../../../../../examples/ay/data/Jupiter_Probe.sndh');

describe('SndhTune', () => {
  let wasmModule: WebAssembly.Module;
  let songBytes: Uint8Array;

  beforeAll(async () => {
    const wasmPath = resolve(HERE, '../../../wasm/sndh.wasm');
    wasmModule = await WebAssembly.compile(await readFile(wasmPath));
    songBytes = new Uint8Array(await readFile(FIXTURE));
  });

  function makeTune(): SndhTune {
    const song = parseSndh(songBytes);
    const instance = new WebAssembly.Instance(wasmModule, createSndhImports());
    return new SndhTune(instance, song, { sampleRate: SAMPLE_RATE });
  }

  it('uses Atari ST defaults when nothing is overridden', () => {
    const tune = makeTune();
    expect(tune.clockFrequency).toBe(ATARI_ST_PAL_CLOCK);
    expect(tune.ymClockFrequency).toBe(ATARI_ST_YM2149_CLOCK);
    expect(tune.isYm).toBe(true);
    tune.dispose();
  });

  it('rejects out-of-range subsong numbers', () => {
    const tune = makeTune();
    expect(() => tune.initSong(0)).toThrow(/out of range/);
    expect(() => tune.initSong(2)).toThrow(/out of range/); // file has 1 subsong
    tune.dispose();
  });

  it('initSong returns a non-negative cycle count and produces audio', () => {
    const tune = makeTune();
    const initCycles = tune.initSong(1);
    expect(initCycles).toBeGreaterThanOrEqual(0);

    // Two play ticks at 50 Hz / 44.1 kHz = 1764 frames.
    const frames = (SAMPLE_RATE / 50) * 2;
    const stereo = new Float32Array(frames * 2);
    tune.generate(stereo);

    let nonZero = 0;
    let peak = 0;
    for (let i = 0; i < stereo.length; i++) {
      if (stereo[i] !== 0) nonZero++;
      const a = Math.abs(stereo[i]!);
      if (a > peak) peak = a;
    }
    // Init wrote at least some YM state, so generate() emits a real
    // signal rather than silence.
    expect(nonZero).toBeGreaterThan(stereo.length / 4);
    expect(peak).toBeGreaterThan(0.001);
    tune.dispose();
  });

  it('generateWithChannels fills the per-voice buffer alongside stereo', () => {
    const tune = makeTune();
    tune.initSong(1);

    const frames = SAMPLE_RATE / 50; // one play tick
    const stereo = new Float32Array(frames * 2);
    const channels = new Float32Array(frames * SNDH_VOICE_COUNT);
    tune.generateWithChannels(stereo, channels);

    // Per-voice buffer must be dimensioned for SNDH_VOICE_COUNT (3).
    expect(channels.length).toBe(frames * 3);

    // At least one voice should have produced a non-trivial signal —
    // Jupiter_Probe is a 3-voice tune.
    let voiceNonZero = 0;
    for (let i = 0; i < channels.length; i++) {
      if (channels[i] !== 0) voiceNonZero++;
    }
    expect(voiceNonZero).toBeGreaterThan(frames);

    tune.dispose();
  });

  it('effectivePlayInterval matches the parsed timer', () => {
    const tune = makeTune();
    // Jupiter_Probe has TC50 → 50 Hz → ATARI_ST_PAL_CLOCK / 50 cycles.
    const expected = Math.floor(ATARI_ST_PAL_CLOCK / 50);
    expect(tune.effectivePlayInterval).toBe(expected);
    tune.dispose();
  });
});
