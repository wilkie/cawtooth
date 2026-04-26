import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { AyumiChip, AY_CLOCK_ZX, AY_VOICE_COUNT } from './ayumi-chip.js';
import { createAyumiImports } from './ayumi-loader.js';

const SAMPLE_RATE = 44100;
const NUM_FRAMES = 2048;

/**
 * Program channel A for a steady square tone at ~440 Hz on a ZX Spectrum
 * clock (1.7734 MHz). tone_period = clock / (16 * freq) ≈ 252 = 0x0FC.
 * R0 = 0xFC, R1 = 0x00.
 */
function programChannelATone(chip: AyumiChip, period = 0xfc): void {
  chip.writeRegister(0, period & 0xff); // R0: tone period A low
  chip.writeRegister(1, (period >> 8) & 0x0f); // R1: tone period A high
  chip.writeRegister(7, 0x3e); // R7: enable tone A only (low bit clear, others set)
  chip.writeRegister(8, 0x0f); // R8: channel A volume = 15
}

function peakAmplitude(buf: Float32Array, start = 0, end = buf.length): number {
  let peak = 0;
  for (let i = start; i < end; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

describe('AyumiChip', () => {
  let wasmModule: WebAssembly.Module;

  beforeAll(async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const wasmPath = resolve(here, '../../wasm/ayumi.wasm');
    const bytes = await readFile(wasmPath);
    wasmModule = await WebAssembly.compile(bytes);
  });

  function makeChip(
    overrides: Partial<ConstructorParameters<typeof AyumiChip>[1]> = {},
  ): AyumiChip {
    const instance = new WebAssembly.Instance(wasmModule, createAyumiImports());
    return new AyumiChip(instance, {
      sampleRate: SAMPLE_RATE,
      clockFrequency: AY_CLOCK_ZX,
      ...overrides,
    });
  }

  it('initializes with the requested clock + sample rate', () => {
    const chip = makeChip();
    expect(chip.sampleRate).toBe(SAMPLE_RATE);
    expect(chip.clockFrequency).toBe(AY_CLOCK_ZX);
    expect(chip.model).toBe('AY-3-8910');
    expect(chip.voiceCount).toBe(3);
    chip.dispose();
  });

  it('produces silence when no registers have been programmed', () => {
    const chip = makeChip();
    const out = new Float32Array(NUM_FRAMES * 2);
    chip.generate(out);
    // The DC filter takes ~1024 samples to settle from the initial
    // dac_table[1] idle level, so allow a tiny non-zero peak.
    expect(peakAmplitude(out)).toBeLessThan(0.05);
    chip.dispose();
  });

  it('produces an audible tone after programming channel A', () => {
    const chip = makeChip();
    programChannelATone(chip);
    const out = new Float32Array(NUM_FRAMES * 2);
    chip.generate(out);
    // After the DC filter settles, the tone reaches well past 0.1 peak.
    // Skip the first ~256 frames to avoid the filter warm-up.
    const peak = peakAmplitude(out, 512);
    expect(peak).toBeGreaterThan(0.05);
    chip.dispose();
  });

  it('reset() silences the chip mid-tone', () => {
    const chip = makeChip();
    programChannelATone(chip);
    chip.generate(new Float32Array(NUM_FRAMES * 2)); // let it ring

    chip.reset();

    const out = new Float32Array(NUM_FRAMES * 2);
    chip.generate(out);
    // After reset + DC filter settle, output decays toward zero. Skip
    // the first chunk to let the filter catch up.
    expect(peakAmplitude(out, 1024)).toBeLessThan(0.02);
    chip.dispose();
  });

  it('readRegister returns the last written value', () => {
    const chip = makeChip();
    chip.writeRegister(0, 0xab);
    chip.writeRegister(7, 0x3e);
    chip.writeRegister(8, 0x0f);
    expect(chip.readRegister(0)).toBe(0xab);
    expect(chip.readRegister(7)).toBe(0x3e);
    expect(chip.readRegister(8)).toBe(0x0f);
    // Untouched register reads as 0.
    expect(chip.readRegister(13)).toBe(0);
    chip.dispose();
  });

  it('masks register addresses to 4 bits (R0..R15 only)', () => {
    const chip = makeChip();
    // reg=16 wraps to reg=0; the underlying chip should now have its
    // tone period A low byte set to 0xCD.
    chip.writeRegister(16, 0xcd);
    expect(chip.readRegister(0)).toBe(0xcd);
    chip.dispose();
  });

  describe('generateWithChannels', () => {
    it('isolates per-voice output while only channel A is sounding', () => {
      const chip = makeChip();
      programChannelATone(chip);

      const stereo = new Float32Array(NUM_FRAMES * 2);
      const channels = new Float32Array(NUM_FRAMES * AY_VOICE_COUNT);
      chip.generateWithChannels(stereo, channels);

      // Channel A (index 0) has the tone; B and C should be silent
      // (mixer has them disabled and their volume registers are 0).
      let chAPeak = 0;
      let chBcPeak = 0;
      for (let f = 512; f < NUM_FRAMES; f++) {
        for (let v = 0; v < AY_VOICE_COUNT; v++) {
          const s = Math.abs(channels[f * AY_VOICE_COUNT + v]);
          if (v === 0) {
            if (s > chAPeak) chAPeak = s;
          } else if (s > chBcPeak) {
            chBcPeak = s;
          }
        }
      }
      expect(chAPeak).toBeGreaterThan(0.05);
      expect(chBcPeak).toBe(0);
      chip.dispose();
    });

    it('rejects an undersized channels buffer', () => {
      const chip = makeChip();
      programChannelATone(chip);
      const stereo = new Float32Array(NUM_FRAMES * 2);
      const undersized = new Float32Array(NUM_FRAMES * AY_VOICE_COUNT - 1);
      expect(() => chip.generateWithChannels(stereo, undersized)).toThrow();
      chip.dispose();
    });
  });

  it('YM2149 model runs and produces audio (different DAC curve)', () => {
    // Sanity check: the YM variant has 32 distinct envelope levels (vs
    // AY's 16-paired). We don't assert exact sample values, just that
    // the alternative DAC table is wired up and the chip works.
    const chip = makeChip({ model: 'YM2149' });
    programChannelATone(chip);
    const out = new Float32Array(NUM_FRAMES * 2);
    chip.generate(out);
    expect(peakAmplitude(out, 512)).toBeGreaterThan(0.05);
    expect(chip.model).toBe('YM2149');
    chip.dispose();
  });
});
