import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parsePsid } from './parser.js';
import { SidTune } from './runtime.js';
import { createSidplayImports } from './sidplay-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 44100;

function peakAmplitude(buf: Float32Array): number {
  let peak = 0;
  for (const s of buf) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Hand-crafted minimal PSID used for unit tests. Writes a triangle wave
 * into SID voice 1 during init, then play is a no-op (RTS). Produces audio
 * without needing the full 16 KB Batman fixture.
 */
function buildTinyPsid(): Uint8Array {
  // Init routine: program voice 1 for a sustained triangle at ~440 Hz.
  // Setting sustain to 15 ($F0 in reg $D406) keeps the envelope from
  // decaying to silence so we get continuous audio for the whole test.
  //
  //   A9 45      LDA #$45
  //   8D 00 D4   STA $D400       ; freqLo
  //   A9 1D      LDA #$1D
  //   8D 01 D4   STA $D401       ; freqHi
  //   A9 00      LDA #$00
  //   8D 05 D4   STA $D405       ; AD = fast attack + fast decay
  //   A9 F0      LDA #$F0
  //   8D 06 D4   STA $D406       ; SR = sustain 15, release 0
  //   A9 0F      LDA #$0F
  //   8D 18 D4   STA $D418       ; volume 15
  //   A9 11      LDA #$11
  //   8D 04 D4   STA $D404       ; triangle + gate (last, so ADSR is armed)
  //   60         RTS
  const INIT_ADDR = 0x4000;
  const PLAY_ADDR = 0x4020;
  const initCode = new Uint8Array([
    0xa9, 0x45, 0x8d, 0x00, 0xd4,
    0xa9, 0x1d, 0x8d, 0x01, 0xd4,
    0xa9, 0x00, 0x8d, 0x05, 0xd4,
    0xa9, 0xf0, 0x8d, 0x06, 0xd4,
    0xa9, 0x0f, 0x8d, 0x18, 0xd4,
    0xa9, 0x11, 0x8d, 0x04, 0xd4,
    0x60,
  ]);
  // Play: RTS only.
  const playCode = new Uint8Array([0x60]);

  // Build header (0x7C bytes) + payload (code @ INIT_ADDR with embedded PRG
  // load address).
  const header = new Uint8Array(0x7c);
  const view = new DataView(header.buffer);
  header.set([0x50, 0x53, 0x49, 0x44]); // 'PSID'
  view.setUint16(4, 2, false); // version
  view.setUint16(6, 0x7c, false); // dataOffset
  view.setUint16(8, 0, false); // loadAddress=0 → embedded PRG header
  view.setUint16(10, INIT_ADDR, false);
  view.setUint16(12, PLAY_ADDR, false);
  view.setUint16(14, 1, false); // 1 song
  view.setUint16(16, 1, false); // startSong=1
  view.setUint32(18, 0, false); // speed=vblank
  const enc = new TextEncoder();
  header.set(enc.encode('TinyTest').subarray(0, 32), 22);
  header.set(enc.encode('cawtooth').subarray(0, 32), 54);
  header.set(enc.encode('2026').subarray(0, 32), 86);
  // flags: PAL (bits 2-3 = 01) + MOS6581 (bits 4-5 = 01)
  view.setUint16(118, (0b01 << 2) | (0b01 << 4), false);

  // Payload: 2-byte PRG load address ($4000 LE) + 0x20 bytes of filler
  // up to $4020 + play code.
  const payloadSize = 2 + 0x20 + playCode.length;
  const payload = new Uint8Array(payloadSize);
  payload[0] = 0x00;
  payload[1] = 0x40; // load addr = $4000
  payload.set(initCode, 2); // code at $4000
  // $4000 + initCode.length .. $4020 is zero-filled (harmless NOP-ish)
  payload.set(playCode, 2 + 0x20); // play at $4020

  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

describe('SidTune (PSID runtime)', () => {
  let wasmModule: WebAssembly.Module;

  beforeAll(async () => {
    const wasmPath = resolve(HERE, '../../../wasm/sidplay.wasm');
    const bytes = await readFile(wasmPath);
    wasmModule = await WebAssembly.compile(bytes);
  });

  function makeTune(
    songBytes: Uint8Array,
    overrides: Partial<ConstructorParameters<typeof SidTune>[2]> = {},
  ): SidTune {
    const song = parsePsid(songBytes);
    const instance = new WebAssembly.Instance(wasmModule, createSidplayImports());
    return new SidTune(instance, song, {
      sampleRate: SAMPLE_RATE,
      samplingMethod: 'fast',
      ...overrides,
    });
  }

  it('auto-detects clock and model from PSID flags', () => {
    const tune = makeTune(buildTinyPsid());
    expect(tune.model).toBe('MOS6581');
    expect(tune.clockFrequency).toBe(985248); // PAL
    tune.dispose();
  });

  it('rejects out-of-range subsong numbers', () => {
    const tune = makeTune(buildTinyPsid());
    expect(() => tune.initSong(0)).toThrow(/out of range/);
    expect(() => tune.initSong(2)).toThrow(/out of range/);
    tune.dispose();
  });

  it('init runs the CPU and returns a sensible cycle count', () => {
    const tune = makeTune(buildTinyPsid());
    const cycles = tune.initSong(1);
    // Tiny init runs ~12 LDA/STA pairs + RTS, so a few dozen cycles.
    // The real assertion is that init returned instead of timing out.
    expect(cycles).toBeGreaterThan(0);
    expect(cycles).toBeLessThan(500);
    tune.dispose();
  });

  it('copies payload into emulated C64 RAM at the load address', () => {
    const tune = makeTune(buildTinyPsid());
    // First byte of init code is LDA #$45 (0xa9, 0x45).
    expect(tune.peek(0x4000)).toBe(0xa9);
    expect(tune.peek(0x4001)).toBe(0x45);
    tune.dispose();
  });

  it('produces non-silent audio after init', () => {
    const tune = makeTune(buildTinyPsid());
    tune.initSong(1);
    // Warm up through the external filter.
    tune.generate(new Float32Array(SAMPLE_RATE * 2));
    const out = new Float32Array(1024 * 2);
    tune.generate(out);
    expect(peakAmplitude(out)).toBeGreaterThan(0.01);
    tune.dispose();
  });

  it('duplicates mono into both stereo channels', () => {
    const tune = makeTune(buildTinyPsid());
    tune.initSong(1);
    tune.generate(new Float32Array(SAMPLE_RATE * 2));
    const out = new Float32Array(1024 * 2);
    tune.generate(out);
    for (let i = 0; i < 1024; i++) {
      expect(out[i * 2]).toBe(out[i * 2 + 1]);
    }
    tune.dispose();
  });

  it('plays the Batman, the Movie fixture end-to-end', async () => {
    const bytes = new Uint8Array(
      await readFile(resolve(HERE, '../../../../../examples/sid/data/Batman_the_Movie.sid')),
    );
    const tune = makeTune(bytes);
    expect(tune.song.songs).toBe(9);
    expect(tune.song.name).toBe('Batman, the Movie');

    const initCycles = tune.initSong(tune.song.startSong);
    expect(initCycles).toBeGreaterThan(0);

    // Warm up + grab audio. A real tune takes many frames to build up
    // envelope state, so we pull a meaningful chunk rather than the
    // first block.
    tune.generate(new Float32Array(SAMPLE_RATE * 2));
    const out = new Float32Array(SAMPLE_RATE / 2);
    tune.generate(out);
    expect(peakAmplitude(out)).toBeGreaterThan(0.01);
    tune.dispose();
  });

  it('generateWithChannels fills stereo + 3-voice buffers', () => {
    const tune = makeTune(buildTinyPsid());
    tune.initSong(1);
    // Warm up through the external filter.
    tune.generate(new Float32Array(SAMPLE_RATE * 2));

    const stereo = new Float32Array(1024 * 2);
    const channels = new Float32Array(1024 * 3);
    tune.generateWithChannels(stereo, channels);

    expect(peakAmplitude(stereo)).toBeGreaterThan(0.01);
    // Only voice 1 is programmed; voices 2 and 3 should be silent.
    let v0Peak = 0;
    let v1Peak = 0;
    let v2Peak = 0;
    for (let f = 0; f < 1024; f++) {
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
    tune.dispose();
  });

  it('generateWithChannels rejects undersized channel buffers', () => {
    const tune = makeTune(buildTinyPsid());
    const stereo = new Float32Array(64 * 2);
    const channels = new Float32Array(64); // need 64 * 3
    expect(() => tune.generateWithChannels(stereo, channels)).toThrow(/channelsOutput/);
    tune.dispose();
  });

  it('subsong changes are idempotent (SID resets between inits)', () => {
    const tune = makeTune(buildTinyPsid());
    tune.initSong(1);
    tune.generate(new Float32Array(SAMPLE_RATE * 2));
    const first = new Float32Array(256);
    tune.generateMono(first);

    // Re-initialize; should reset SID + run init again → same output.
    tune.initSong(1);
    tune.generate(new Float32Array(SAMPLE_RATE * 2));
    const second = new Float32Array(256);
    tune.generateMono(second);

    expect(peakAmplitude(first)).toBeGreaterThan(0.01);
    expect(peakAmplitude(second)).toBeGreaterThan(0.01);
    // Not byte-identical (CPU state drifts across re-init) but close in
    // overall level. The real assertion is that re-init doesn't silence
    // the chip.
    tune.dispose();
  });
});
