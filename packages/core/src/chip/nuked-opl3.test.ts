import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { NukedOpl3Chip } from './nuked-opl3.js';
import { createNukedOpl3Imports } from './loader.js';
import { TEST_TONE_WRITES } from './__fixtures__/test-tone.js';

const SAMPLE_RATE = 48000;
const NUM_FRAMES = 1024;

function applyWrites(chip: NukedOpl3Chip): void {
  for (const w of TEST_TONE_WRITES) {
    chip.writeRegister(w.reg, w.value);
  }
}

function peakAmplitude(buf: Float32Array): number {
  let peak = 0;
  for (const s of buf) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return peak;
}

describe('NukedOpl3Chip', () => {
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

  it('reports the sample rate it was created with', () => {
    const chip = makeChip();
    expect(chip.sampleRate).toBe(SAMPLE_RATE);
    chip.dispose();
  });

  it('produces silence before any register writes', () => {
    const chip = makeChip();
    const out = new Float32Array(NUM_FRAMES * 2);
    chip.generate(out);
    expect(peakAmplitude(out)).toBe(0);
    chip.dispose();
  });

  it('produces non-zero audio after a key-on', () => {
    const chip = makeChip();
    applyWrites(chip);
    const out = new Float32Array(NUM_FRAMES * 2);
    chip.generate(out);
    expect(peakAmplitude(out)).toBeGreaterThan(0.01);
    chip.dispose();
  });

  it('returns to silence after reset', () => {
    const chip = makeChip();
    applyWrites(chip);
    const warm = new Float32Array(NUM_FRAMES * 2);
    chip.generate(warm);
    expect(peakAmplitude(warm)).toBeGreaterThan(0.01);

    chip.reset();

    const cold = new Float32Array(NUM_FRAMES * 2);
    chip.generate(cold);
    expect(peakAmplitude(cold)).toBe(0);
    chip.dispose();
  });

  it('handles growing the scratch buffer when asked for more frames', () => {
    const chip = makeChip();
    applyWrites(chip);
    // First call with small buffer establishes a baseline scratch size.
    chip.generate(new Float32Array(128 * 2));
    // Second call larger than initial scratch forces a realloc.
    const big = new Float32Array(8192 * 2);
    chip.generate(big);
    expect(peakAmplitude(big)).toBeGreaterThan(0.01);
    chip.dispose();
  });

  it('allows multiple chips on the same wasm instance', () => {
    const instance = new WebAssembly.Instance(wasmModule, createNukedOpl3Imports());
    const a = new NukedOpl3Chip(instance, SAMPLE_RATE);
    const b = new NukedOpl3Chip(instance, SAMPLE_RATE);

    for (const w of TEST_TONE_WRITES) a.writeRegister(w.reg, w.value);
    // b gets no writes → stays silent.

    const outA = new Float32Array(NUM_FRAMES * 2);
    const outB = new Float32Array(NUM_FRAMES * 2);
    a.generate(outA);
    b.generate(outB);

    expect(peakAmplitude(outA)).toBeGreaterThan(0.01);
    expect(peakAmplitude(outB)).toBe(0);

    a.dispose();
    b.dispose();
  });
});
