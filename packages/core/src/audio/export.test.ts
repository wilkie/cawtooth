import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { NukedOpl3Chip } from '../chip/nuked-opl3.js';
import { createNukedOpl3Imports } from '../chip/loader.js';
import { TEST_TONE_WRITES } from '../chip/__fixtures__/test-tone.js';
import { encodeWav, renderToPcm, renderToWav } from './export.js';
import type { RegisterEventStream, TimedRegisterStream } from '../sequencer/types.js';

const SAMPLE_RATE = 48000;

function makeToneStream(): TimedRegisterStream {
  // Convert TEST_TONE_WRITES into a RegisterEventStream with all events at
  // tick 0. Then add a trailing 2-tick delay so the stream advertises a
  // duration of 2 ticks.
  const n = TEST_TONE_WRITES.length;
  const regs = new Uint16Array(n);
  const values = new Uint8Array(n);
  const delayTicks = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    regs[i] = TEST_TONE_WRITES[i].reg;
    values[i] = TEST_TONE_WRITES[i].value;
  }
  delayTicks[n - 1] = 40; // 40 ticks trailing delay
  const stream: RegisterEventStream = { regs, values, delayTicks };
  return { stream, tickRate: 40 }; // 1 second
}

async function makeChip(): Promise<NukedOpl3Chip> {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmPath = resolve(here, '../../wasm/nuked-opl3.wasm');
  const wasmModule = await WebAssembly.compile(await readFile(wasmPath));
  const instance = new WebAssembly.Instance(wasmModule, createNukedOpl3Imports());
  return new NukedOpl3Chip(instance, SAMPLE_RATE);
}

function peak(buf: Float32Array): number {
  let p = 0;
  for (const s of buf) {
    const a = Math.abs(s);
    if (a > p) p = a;
  }
  return p;
}

describe('renderToPcm', () => {
  it('renders audible PCM from a real stream', async () => {
    const chip = await makeChip();
    try {
      const pcm = renderToPcm(makeToneStream(), { chip, tailSec: 0.1 });
      // Stereo interleaved → pcm.length == frames * 2.
      expect(pcm.length).toBeGreaterThan(SAMPLE_RATE * 1 * 2 * 0.9); // ~1s of audio
      expect(peak(pcm)).toBeGreaterThan(0.01);
    } finally {
      chip.dispose();
    }
  });

  it('honours maxDurationSec cap', async () => {
    const chip = await makeChip();
    try {
      // Make a stream that claims a 1000-second duration but we cap at 0.5s.
      const stream: RegisterEventStream = {
        regs: new Uint16Array([0x01]),
        values: new Uint8Array([0x20]),
        delayTicks: new Uint32Array([1000 * 1000]), // 1000 seconds at 1 kHz tick rate
      };
      const pcm = renderToPcm(
        { stream, tickRate: 1000 },
        { chip, maxDurationSec: 0.5, tailSec: 0 },
      );
      // 0.5 sec * sampleRate * 2 (stereo) = 48000 samples total.
      expect(pcm.length).toBe(SAMPLE_RATE * 0.5 * 2);
    } finally {
      chip.dispose();
    }
  });
});

describe('encodeWav', () => {
  it('produces a WAV file with a valid RIFF header', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.25]); // 2 stereo frames
    const wav = encodeWav(samples, 44100);
    // "RIFF"
    expect(wav[0]).toBe(0x52);
    expect(wav[1]).toBe(0x49);
    expect(wav[2]).toBe(0x46);
    expect(wav[3]).toBe(0x46);
    // "WAVE"
    expect(wav[8]).toBe(0x57);
    expect(wav[9]).toBe(0x41);
    expect(wav[10]).toBe(0x56);
    expect(wav[11]).toBe(0x45);
    // "fmt "
    expect(wav[12]).toBe(0x66);
    expect(wav[13]).toBe(0x6d);
    expect(wav[14]).toBe(0x74);
    expect(wav[15]).toBe(0x20);
  });

  it('encodes PCM16 with the right sample conversion', () => {
    const samples = new Float32Array([0, 1, -1, 0.5]);
    const wav = encodeWav(samples, 44100, { format: 'pcm16' });
    const dv = new DataView(wav.buffer);
    // Format code at offset 20 should be 1 (PCM).
    expect(dv.getUint16(20, true)).toBe(1);
    // Bit depth at offset 34 should be 16.
    expect(dv.getUint16(34, true)).toBe(16);
    // First sample at offset 44 should be 0.
    expect(dv.getInt16(44, true)).toBe(0);
    // Second sample: 1.0 → 0x7FFF.
    expect(dv.getInt16(46, true)).toBe(0x7fff);
    // Third: -1.0 → -0x7FFF (not -0x8000; we symmetrically clip).
    expect(dv.getInt16(48, true)).toBe(-0x7fff);
    // Fourth: 0.5 → ~0x4000.
    expect(Math.abs(dv.getInt16(50, true) - Math.round(0.5 * 0x7fff))).toBeLessThanOrEqual(1);
  });

  it('encodes Float32 with no precision loss', () => {
    const samples = new Float32Array([0.123456, -0.987654]);
    const wav = encodeWav(samples, 44100, { format: 'float32' });
    const dv = new DataView(wav.buffer);
    expect(dv.getUint16(20, true)).toBe(3); // IEEE float
    expect(dv.getUint16(34, true)).toBe(32); // bits per sample
    expect(dv.getFloat32(44, true)).toBeCloseTo(0.123456, 6);
    expect(dv.getFloat32(48, true)).toBeCloseTo(-0.987654, 6);
  });

  it('clips samples outside [-1, 1] when encoding PCM16', () => {
    const samples = new Float32Array([2.0, -3.0]);
    const wav = encodeWav(samples, 44100, { format: 'pcm16' });
    const dv = new DataView(wav.buffer);
    expect(dv.getInt16(44, true)).toBe(0x7fff);
    expect(dv.getInt16(46, true)).toBe(-0x7fff);
  });
});

describe('renderToWav', () => {
  it('produces a playable WAV file from a real stream', async () => {
    const chip = await makeChip();
    try {
      const wav = renderToWav(makeToneStream(), { chip, tailSec: 0.1 });
      // RIFF header present.
      expect(wav[0]).toBe(0x52);
      // Sample rate at offset 24 should match chip rate.
      const dv = new DataView(wav.buffer);
      expect(dv.getUint32(24, true)).toBe(SAMPLE_RATE);
      // Data chunk size should match ~1.1 seconds of stereo int16.
      const dataSize = dv.getUint32(40, true);
      // Ballpark: 1.1s * 48000 frames * 2 channels * 2 bytes = 211,200.
      expect(dataSize).toBeGreaterThan(180000);
      expect(dataSize).toBeLessThan(260000);
    } finally {
      chip.dispose();
    }
  });
});
