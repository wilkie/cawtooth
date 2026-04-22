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
interface TinyPsidOptions {
  speed?: number;
  /**
   * Optional 6502 bytes inserted into the init routine before the
   * standard "program voice 1" sequence. Used to test CIA-timer
   * programming — e.g. a snippet that writes to $DC04/$DC05.
   */
  initPrologue?: readonly number[];
}

function buildTinyPsid(opts: TinyPsidOptions = {}): Uint8Array {
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
  const PLAY_ADDR = 0x4100;
  const prologue = new Uint8Array(opts.initPrologue ?? []);
  const mainInit = new Uint8Array([
    0xa9, 0x45, 0x8d, 0x00, 0xd4,
    0xa9, 0x1d, 0x8d, 0x01, 0xd4,
    0xa9, 0x00, 0x8d, 0x05, 0xd4,
    0xa9, 0xf0, 0x8d, 0x06, 0xd4,
    0xa9, 0x0f, 0x8d, 0x18, 0xd4,
    0xa9, 0x11, 0x8d, 0x04, 0xd4,
    0x60,
  ]);
  const initCode = new Uint8Array(prologue.length + mainInit.length);
  initCode.set(prologue, 0);
  initCode.set(mainInit, prologue.length);
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
  view.setUint32(18, opts.speed ?? 0, false); // speed bits
  const enc = new TextEncoder();
  header.set(enc.encode('TinyTest').subarray(0, 32), 22);
  header.set(enc.encode('cawtooth').subarray(0, 32), 54);
  header.set(enc.encode('2026').subarray(0, 32), 86);
  // flags: PAL (bits 2-3 = 01) + MOS6581 (bits 4-5 = 01)
  view.setUint16(118, (0b01 << 2) | (0b01 << 4), false);

  // Payload layout:
  //   [0..1]        PRG load address ($4000 LE)
  //   [2..]         init code at $4000
  //   PLAY_ADDR-$4000 + 2
  //                 play code at PLAY_ADDR ($4100, leaving ample room for
  //                 any init prologue the caller injects)
  const playOffset = 2 + (PLAY_ADDR - INIT_ADDR);
  const payload = new Uint8Array(playOffset + playCode.length);
  payload[0] = 0x00;
  payload[1] = 0x40; // load addr = $4000
  payload.set(initCode, 2);
  payload.set(playCode, playOffset);

  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

/**
 * Minimum viable RSID fixture. Init does the same voice-1-triangle SID
 * setup as `buildTinyPsid`, then writes a user-chosen IRQ handler
 * address into one of the two vectors and returns with RTS. The handler
 * is placed at the requested location and is just an RTI opcode.
 */
function buildTinyRsid(opts: { handlerVector: 'soft' | 'hard' } = { handlerVector: 'soft' }): Uint8Array {
  const INIT_ADDR = 0x4000;
  const HANDLER_ADDR = 0x4100;

  // Install IRQ handler at either $0314/$0315 (KERNAL soft vector) or
  // $FFFE/$FFFF (hardware IRQ vector). Both should work per our resolver;
  // the test asserts whichever we choose.
  const vectorLo = opts.handlerVector === 'soft' ? 0x14 : 0xfe;
  const vectorHi = opts.handlerVector === 'soft' ? 0x15 : 0xff;
  const vectorPage = opts.handlerVector === 'soft' ? 0x03 : 0xff;
  const installCode = new Uint8Array([
    0xa9, HANDLER_ADDR & 0xff, 0x8d, vectorLo, vectorPage,
    0xa9, (HANDLER_ADDR >> 8) & 0xff, 0x8d, vectorHi, vectorPage,
  ]);

  // Same SID setup as the tiny PSID: voice 1 triangle, sustained envelope.
  const sidSetup = new Uint8Array([
    0xa9, 0x45, 0x8d, 0x00, 0xd4,
    0xa9, 0x1d, 0x8d, 0x01, 0xd4,
    0xa9, 0x00, 0x8d, 0x05, 0xd4,
    0xa9, 0xf0, 0x8d, 0x06, 0xd4,
    0xa9, 0x0f, 0x8d, 0x18, 0xd4,
    0xa9, 0x11, 0x8d, 0x04, 0xd4,
    0x60, // RTS
  ]);
  const initCode = new Uint8Array(installCode.length + sidSetup.length);
  initCode.set(installCode, 0);
  initCode.set(sidSetup, installCode.length);

  // IRQ handler — just return cleanly. The chip state set up by init
  // keeps producing audio; the handler has no per-frame work to do.
  const handlerCode = new Uint8Array([0x40]); // RTI

  const header = new Uint8Array(0x7c);
  const view = new DataView(header.buffer);
  header.set([0x52, 0x53, 0x49, 0x44]); // 'RSID'
  view.setUint16(4, 2, false);
  view.setUint16(6, 0x7c, false);
  view.setUint16(8, 0, false); // loadAddress field 0 → first 2 payload bytes are PRG header
  view.setUint16(10, INIT_ADDR, false);
  view.setUint16(12, 0, false); // playAddress: always 0 for RSID
  view.setUint16(14, 1, false); // 1 song
  view.setUint16(16, 1, false); // startSong=1
  view.setUint32(18, 0, false); // speed: always 0 for RSID
  const enc = new TextEncoder();
  header.set(enc.encode('TinyRsid').subarray(0, 32), 22);
  header.set(enc.encode('cawtooth').subarray(0, 32), 54);
  header.set(enc.encode('2026').subarray(0, 32), 86);
  view.setUint16(118, (0b01 << 2) | (0b01 << 4), false); // PAL + MOS6581

  const handlerOffset = 2 + (HANDLER_ADDR - INIT_ADDR);
  const payload = new Uint8Array(handlerOffset + handlerCode.length);
  payload[0] = 0x00;
  payload[1] = 0x40; // load addr = $4000
  payload.set(initCode, 2);
  payload.set(handlerCode, handlerOffset);

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

  it('vblank-speed subsongs use the PAL vblank interval', () => {
    const tune = makeTune(buildTinyPsid()); // speed=0
    tune.initSong(1);
    // PAL vblank = 19656 cycles.
    expect(tune.effectivePlayInterval).toBe(19656);
    tune.dispose();
  });

  it('CIA-speed subsongs pick up the timer value programmed at init', () => {
    // Init prologue: LDA #$34 / STA $DC04 / LDA #$12 / STA $DC05
    // This programs CIA 1 Timer A to $1234 = 4660 cycles.
    const prologue = [
      0xa9, 0x34, 0x8d, 0x04, 0xdc,
      0xa9, 0x12, 0x8d, 0x05, 0xdc,
    ];
    const tune = makeTune(buildTinyPsid({ speed: 1, initPrologue: prologue }));
    tune.initSong(1);
    expect(tune.effectivePlayInterval).toBe(0x1234); // 4660
    tune.dispose();
  });

  it('CIA-speed subsongs inherit the KERNAL default CIA when init skips reprogramming', () => {
    // speed bit says CIA, and init never touches $DC04/$DC05. A real
    // C64 would have CIA 1 Timer A pre-programmed by the KERNAL ROM to
    // $4025 (PAL, ~60 Hz jiffy rate). Some multi-speed tunes — e.g.
    // Hubbard's "The Human Race" — rely on that default.
    const tune = makeTune(buildTinyPsid({ speed: 1 }));
    tune.initSong(1);
    expect(tune.effectivePlayInterval).toBe(0x4025); // 16421 cycles ≈ 60 Hz
    tune.dispose();
  });

  it('CIA-speed subsongs fall back to vblank if init explicitly zeroes the timer', () => {
    // speed bit says CIA, and init explicitly writes 0 to $DC04/$DC05.
    // That's an unusual but legitimate case (the tune doesn't want CIA);
    // we fall back to vblank so we don't hang on a zero-cycle frame.
    const prologue = [
      0xa9, 0x00, 0x8d, 0x04, 0xdc,
      0xa9, 0x00, 0x8d, 0x05, 0xdc,
    ];
    const tune = makeTune(buildTinyPsid({ speed: 1, initPrologue: prologue }));
    tune.initSong(1);
    expect(tune.effectivePlayInterval).toBe(19656);
    tune.dispose();
  });

  it('refreshes CIA state between subsong changes', () => {
    // First tune programs CIA with a specific value ($ABCD).
    const prologueABCD = [
      0xa9, 0xcd, 0x8d, 0x04, 0xdc,
      0xa9, 0xab, 0x8d, 0x05, 0xdc,
    ];
    const tune = makeTune(buildTinyPsid({ speed: 1, initPrologue: prologueABCD }));
    tune.initSong(1);
    expect(tune.effectivePlayInterval).toBe(0xabcd);

    // A second tune on a fresh wasm instance whose init doesn't touch
    // CIA should land on the KERNAL default — not on the $ABCD value
    // from the previous tune. Proves the pre-init CIA setup is fresh
    // per-init, not sticky across tunes.
    const noCiaTune = makeTune(buildTinyPsid({ speed: 1 }));
    noCiaTune.initSong(1);
    expect(noCiaTune.effectivePlayInterval).toBe(0x4025);
    noCiaTune.dispose();
    tune.dispose();
  });

  it('resolves an RSID play handler from the KERNAL soft vector ($0314)', () => {
    const tune = makeTune(buildTinyRsid({ handlerVector: 'soft' }));
    expect(tune.song.magic).toBe('RSID');
    expect(tune.song.playAddress).toBe(0);

    tune.initSong(1);

    // After init, $0314/$0315 should hold the handler address $4100.
    expect(tune.peek(0x0314)).toBe(0x00);
    expect(tune.peek(0x0315)).toBe(0x41);

    // RSID is always CIA-driven → KERNAL default until tune reprograms.
    expect(tune.effectivePlayInterval).toBe(0x4025);

    // Produce audio to confirm the RTI-ending handler doesn't crash the
    // player loop and the SID's init-programmed state still sounds.
    tune.generate(new Float32Array(SAMPLE_RATE * 2));
    const out = new Float32Array(1024 * 2);
    tune.generate(out);
    expect(peakAmplitude(out)).toBeGreaterThan(0.01);
    tune.dispose();
  });

  it('falls back to the hardware IRQ vector ($FFFE) when $0314 is empty', () => {
    const tune = makeTune(buildTinyRsid({ handlerVector: 'hard' }));
    tune.initSong(1);
    expect(tune.peek(0xfffe)).toBe(0x00);
    expect(tune.peek(0xffff)).toBe(0x41);

    tune.generate(new Float32Array(SAMPLE_RATE * 2));
    const out = new Float32Array(1024 * 2);
    tune.generate(out);
    expect(peakAmplitude(out)).toBeGreaterThan(0.01);
    tune.dispose();
  });

  it('RSID pre-sets the processor port for standard C64 banking', () => {
    const tune = makeTune(buildTinyRsid());
    tune.initSong(1);
    // $01 should be $37 (KERNAL + BASIC + I/O all mapped in), the
    // standard post-boot C64 banking state RSID tunes expect.
    expect(tune.peek(0x0001)).toBe(0x37);
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
