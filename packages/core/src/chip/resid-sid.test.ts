import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { SidChip, SID_CLOCK_PAL, SID_VOICE_COUNT } from './resid-sid.js';
import { createReSidImports } from './resid-loader.js';

const SAMPLE_RATE = 44100;
const NUM_FRAMES = 1024;

/**
 * Program voice 1 for a sustained triangle tone at ~440 Hz on a PAL C64.
 * freq_reg = freq_hz * 16.777216 / clock_hz ≈ 7493 (0x1D45) at 985248 Hz.
 */
function programTriangleA4(chip: SidChip): void {
  chip.writeRegister(0x00, 0x45); // voice 1 freq lo
  chip.writeRegister(0x01, 0x1d); // voice 1 freq hi
  chip.writeRegister(0x05, 0x09); // voice 1 AD
  chip.writeRegister(0x06, 0xf0); // voice 1 SR
  chip.writeRegister(0x18, 0x0f); // master volume = 15
  chip.writeRegister(0x04, 0x11); // triangle + gate
}

function peakAmplitude(buf: Float32Array): number {
  let peak = 0;
  for (const s of buf) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return peak;
}

describe('SidChip', () => {
  let wasmModule: WebAssembly.Module;

  beforeAll(async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const wasmPath = resolve(here, '../../wasm/resid.wasm');
    const bytes = await readFile(wasmPath);
    wasmModule = await WebAssembly.compile(bytes);
  });

  function makeChip(overrides: Partial<ConstructorParameters<typeof SidChip>[1]> = {}): SidChip {
    const instance = new WebAssembly.Instance(wasmModule, createReSidImports());
    return new SidChip(instance, {
      sampleRate: SAMPLE_RATE,
      samplingMethod: 'fast',
      ...overrides,
    });
  }

  it('reports the sample rate, voice count, and clock it was created with', () => {
    const chip = makeChip();
    expect(chip.sampleRate).toBe(SAMPLE_RATE);
    expect(chip.voiceCount).toBe(SID_VOICE_COUNT);
    expect(chip.clockFrequency).toBe(SID_CLOCK_PAL);
    expect(chip.model).toBe('MOS6581');
    chip.dispose();
  });

  it('settles to silence before any register writes', () => {
    const chip = makeChip();
    // reSID's external high-pass filter has a startup DC transient that
    // decays over tens of ms. Pull enough warmup to let it settle, then
    // check the tail is effectively flat.
    chip.generate(new Float32Array(SAMPLE_RATE * 2));
    const out = new Float32Array(NUM_FRAMES * 2);
    chip.generate(out);
    expect(peakAmplitude(out)).toBeLessThan(0.01);
    chip.dispose();
  });

  it('produces non-zero audio after a gated triangle', () => {
    const chip = makeChip();
    programTriangleA4(chip);
    // reSID needs a handful of samples to settle through the external
    // filter. Pull a few blocks and check the tail.
    const warmup = new Float32Array(2048 * 2);
    chip.generate(warmup);
    const out = new Float32Array(NUM_FRAMES * 2);
    chip.generate(out);
    expect(peakAmplitude(out)).toBeGreaterThan(0.01);
    chip.dispose();
  });

  it('duplicates mono into both stereo channels', () => {
    const chip = makeChip();
    programTriangleA4(chip);
    chip.generate(new Float32Array(2048 * 2));
    const out = new Float32Array(NUM_FRAMES * 2);
    chip.generate(out);
    for (let i = 0; i < NUM_FRAMES; i++) {
      expect(out[i * 2]).toBe(out[i * 2 + 1]);
    }
    chip.dispose();
  });

  it('returns to silence after reset', () => {
    const chip = makeChip();
    programTriangleA4(chip);
    const warm = new Float32Array(NUM_FRAMES * 2);
    chip.generate(new Float32Array(2048 * 2));
    chip.generate(warm);
    expect(peakAmplitude(warm)).toBeGreaterThan(0.01);

    chip.reset();

    // Let the external filter settle after reset.
    chip.generate(new Float32Array(2048 * 2));
    const cold = new Float32Array(NUM_FRAMES * 2);
    chip.generate(cold);
    expect(peakAmplitude(cold)).toBeLessThan(0.01);
    chip.dispose();
  });

  it('handles growing the scratch buffer when asked for more samples', () => {
    const chip = makeChip();
    programTriangleA4(chip);
    chip.generate(new Float32Array(128 * 2));
    const big = new Float32Array(8192 * 2);
    chip.generate(big);
    expect(peakAmplitude(big)).toBeGreaterThan(0.01);
    chip.dispose();
  });

  it('allows multiple SID chips on the same wasm instance', () => {
    const instance = new WebAssembly.Instance(wasmModule, createReSidImports());
    const a = new SidChip(instance, { sampleRate: SAMPLE_RATE, samplingMethod: 'fast' });
    const b = new SidChip(instance, { sampleRate: SAMPLE_RATE, samplingMethod: 'fast' });
    programTriangleA4(a);
    // b gets no writes → stays at rest.

    a.generate(new Float32Array(2048 * 2));
    b.generate(new Float32Array(2048 * 2));

    const outA = new Float32Array(NUM_FRAMES * 2);
    const outB = new Float32Array(NUM_FRAMES * 2);
    a.generate(outA);
    b.generate(outB);

    expect(peakAmplitude(outA)).toBeGreaterThan(0.01);
    expect(peakAmplitude(outB)).toBeLessThan(0.01);

    a.dispose();
    b.dispose();
  });

  it('supports MOS8580 model selection', () => {
    const chip = makeChip({ model: 'MOS8580' });
    expect(chip.model).toBe('MOS8580');
    programTriangleA4(chip);
    // The 8580 pipelines writes, so the gate+ADSR needs a few more samples
    // than the 6581 to fully commit and produce audible output.
    chip.generate(new Float32Array(SAMPLE_RATE * 2));
    const out = new Float32Array(NUM_FRAMES * 2);
    chip.generate(out);
    expect(peakAmplitude(out)).toBeGreaterThan(0.01);
    chip.dispose();
  });

  it('generateMono fills a mono buffer directly', () => {
    const chip = makeChip();
    programTriangleA4(chip);
    chip.generateMono(new Float32Array(2048));
    const out = new Float32Array(NUM_FRAMES);
    chip.generateMono(out);
    expect(peakAmplitude(out)).toBeGreaterThan(0.01);
    chip.dispose();
  });

  it('generateWithChannels fills both stereo and per-voice buffers', () => {
    const chip = makeChip();
    programTriangleA4(chip);
    // Warm up the external filter.
    chip.generate(new Float32Array(2048 * 2));

    const stereo = new Float32Array(NUM_FRAMES * 2);
    const channels = new Float32Array(NUM_FRAMES * 3);
    chip.generateWithChannels(stereo, channels);

    expect(peakAmplitude(stereo)).toBeGreaterThan(0.01);
    // Voice 1 should be non-silent (programmed). Voices 2/3 should be
    // ≈ silent since only their default reset state applies.
    let v0Peak = 0;
    let v1Peak = 0;
    let v2Peak = 0;
    for (let f = 0; f < NUM_FRAMES; f++) {
      const a = Math.abs(channels[f * 3 + 0]);
      const b = Math.abs(channels[f * 3 + 1]);
      const c = Math.abs(channels[f * 3 + 2]);
      if (a > v0Peak) v0Peak = a;
      if (b > v1Peak) v1Peak = b;
      if (c > v2Peak) v2Peak = c;
    }
    expect(v0Peak).toBeGreaterThan(0.005);
    expect(v1Peak).toBeLessThan(0.01);
    expect(v2Peak).toBeLessThan(0.01);
    chip.dispose();
  });

  it('generateWithChannels throws when the channels buffer is too small', () => {
    const chip = makeChip();
    const stereo = new Float32Array(64 * 2);
    const channels = new Float32Array(64); // need 64 * 3
    expect(() => chip.generateWithChannels(stereo, channels)).toThrow(/channelsOutput/);
    chip.dispose();
  });
});
