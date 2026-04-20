import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { NukedOpl3Chip } from './nuked-opl3.js';
import { OPL_CHANNEL_COUNT } from './types.js';
import { createNukedOpl3Imports } from './loader.js';
import { TEST_TONE_WRITES } from './__fixtures__/test-tone.js';

const SAMPLE_RATE = 48000;
const NUM_FRAMES = 1024;

function peak(buf: Float32Array, start = 0, end = buf.length): number {
  let p = 0;
  for (let i = start; i < end; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

/**
 * Extract one voice's samples from the frame-interleaved channels buffer.
 * channels layout: [f0_ch0..f0_ch17, f1_ch0..f1_ch17, ...].
 */
function voice(channels: Float32Array, voiceIdx: number, numFrames: number): Float32Array {
  const out = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    out[f] = channels[f * OPL_CHANNEL_COUNT + voiceIdx];
  }
  return out;
}

describe('NukedOpl3Chip.generateWithChannels', () => {
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

  it('exposes the advertised channel count', () => {
    expect(OPL_CHANNEL_COUNT).toBe(18);
  });

  it('produces silence on every voice before any key-on', () => {
    const chip = makeChip();
    const stereo = new Float32Array(NUM_FRAMES * 2);
    const channels = new Float32Array(NUM_FRAMES * OPL_CHANNEL_COUNT);
    chip.generateWithChannels(stereo, channels);

    expect(peak(stereo)).toBe(0);
    for (let v = 0; v < OPL_CHANNEL_COUNT; v++) {
      expect(peak(voice(channels, v, NUM_FRAMES))).toBe(0);
    }
    chip.dispose();
  });

  it('isolates audio to channel 0 when only channel 0 is keyed on', () => {
    const chip = makeChip();
    for (const w of TEST_TONE_WRITES) {
      chip.writeRegister(w.reg, w.value);
    }

    const stereo = new Float32Array(NUM_FRAMES * 2);
    const channels = new Float32Array(NUM_FRAMES * OPL_CHANNEL_COUNT);
    chip.generateWithChannels(stereo, channels);

    // Stereo mix has audio.
    expect(peak(stereo)).toBeGreaterThan(0.01);

    // Channel 0 has audio.
    expect(peak(voice(channels, 0, NUM_FRAMES))).toBeGreaterThan(0.01);

    // All other voices stay silent.
    for (let v = 1; v < OPL_CHANNEL_COUNT; v++) {
      expect(peak(voice(channels, v, NUM_FRAMES))).toBe(0);
    }
    chip.dispose();
  });

  it('matches stereo output against the plain generate() call for the same writes', () => {
    // Two identically-programmed chips, one using generate(), one using
    // generateWithChannels(). The stereo halves should match within the
    // resampler's rounding tolerance.
    const chipA = makeChip();
    const chipB = makeChip();
    for (const w of TEST_TONE_WRITES) {
      chipA.writeRegister(w.reg, w.value);
      chipB.writeRegister(w.reg, w.value);
    }

    const stereoA = new Float32Array(NUM_FRAMES * 2);
    chipA.generate(stereoA);

    const stereoB = new Float32Array(NUM_FRAMES * 2);
    const channelsB = new Float32Array(NUM_FRAMES * OPL_CHANNEL_COUNT);
    chipB.generateWithChannels(stereoB, channelsB);

    // The two stereo streams come from the same emulator run with the same
    // register writes — they should be bit-identical.
    for (let i = 0; i < stereoA.length; i++) {
      expect(stereoB[i]).toBe(stereoA[i]);
    }

    chipA.dispose();
    chipB.dispose();
  });

  it('rejects a channels buffer that is too small', () => {
    const chip = makeChip();
    const stereo = new Float32Array(NUM_FRAMES * 2);
    const undersized = new Float32Array(NUM_FRAMES * OPL_CHANNEL_COUNT - 1);
    expect(() => chip.generateWithChannels(stereo, undersized)).toThrow();
    chip.dispose();
  });

  it('handles buffer growth across multiple calls', () => {
    const chip = makeChip();
    for (const w of TEST_TONE_WRITES) chip.writeRegister(w.reg, w.value);

    // Small call first to establish baseline scratch size.
    chip.generateWithChannels(new Float32Array(128 * 2), new Float32Array(128 * OPL_CHANNEL_COUNT));

    // Larger call forces reallocation of both scratch buffers.
    const bigStereo = new Float32Array(4096 * 2);
    const bigChannels = new Float32Array(4096 * OPL_CHANNEL_COUNT);
    chip.generateWithChannels(bigStereo, bigChannels);

    expect(peak(bigStereo)).toBeGreaterThan(0.01);
    expect(peak(voice(bigChannels, 0, 4096))).toBeGreaterThan(0.01);
    chip.dispose();
  });
});
