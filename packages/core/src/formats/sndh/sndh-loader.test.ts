import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { parseSndh } from './parser.js';
import {
  asSndhExports,
  compileSndh,
  instantiateSndh,
  type SndhExports,
} from './sndh-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const ATARI_ST_PAL_HZ = 8010613;
const YM2149_HZ = 2000000;
const SAMPLE_RATE = 44100;

async function loadWasm(): Promise<SndhExports> {
  const wasmPath = resolve(HERE, '../../../wasm/sndh.wasm');
  const bytes = await readFile(wasmPath);
  const module = await compileSndh(bytes);
  const instance = await instantiateSndh(module);
  const exports = asSndhExports(instance);
  exports._initialize?.();
  return exports;
}

describe('sndh.wasm', () => {
  it('boots Jupiter_Probe.sndh and produces audio', async () => {
    const sndh = await loadWasm();

    const sndhPath = resolve(
      HERE,
      '../../../../../examples/ay/data/Jupiter_Probe.sndh',
    );
    const bytes = new Uint8Array(await readFile(sndhPath));
    const song = parseSndh(bytes);
    expect(song.timer).toEqual({ type: 'C', frequencyHz: 50 });

    const ok = sndh.cawtooth_sndh_create(
      ATARI_ST_PAL_HZ,
      YM2149_HZ,
      SAMPLE_RATE,
      1, // is_ym
    );
    expect(ok).toBe(1);

    // Copy the SNDH binary into the simulated Atari ST RAM at $0.
    const dataPtr = sndh.malloc(bytes.byteLength);
    expect(dataPtr).not.toBe(0);
    const heap = new Uint8Array(sndh.memory.buffer);
    heap.set(bytes, dataPtr);
    sndh.cawtooth_sndh_load(dataPtr, bytes.byteLength);
    sndh.free(dataPtr);

    const cyclesPerPlay = Math.floor(ATARI_ST_PAL_HZ / song.timer!.frequencyHz);
    const initCycles = sndh.cawtooth_sndh_init(
      song.initAddress,
      song.exitAddress,
      song.playAddress,
      1, // subsong (1-based per SNDH spec)
      cyclesPerPlay,
    );

    // Init should return a non-negative cycle count. -1 means timeout
    // (the player got stuck somewhere — almost always means the bus
    // model is wrong or the entry point parsing was wrong).
    expect(initCycles).toBeGreaterThanOrEqual(0);

    // One play-tick worth of frames at 50 Hz / 44.1 kHz = 882.
    // Generate two ticks so we cross at least one play() boundary.
    const numFrames = (SAMPLE_RATE / song.timer!.frequencyHz) * 2;
    const bufBytes = numFrames * 2 * 2; // stereo int16
    const bufPtr = sndh.malloc(bufBytes);
    expect(bufPtr).not.toBe(0);

    sndh.cawtooth_sndh_generate(bufPtr, numFrames);

    const audioHeap = new Int16Array(
      sndh.memory.buffer,
      bufPtr,
      numFrames * 2,
    );
    let nonZero = 0;
    let peak = 0;
    for (let i = 0; i < audioHeap.length; i++) {
      if (audioHeap[i] !== 0) nonZero++;
      const a = Math.abs(audioHeap[i]!);
      if (a > peak) peak = a;
    }

    sndh.free(bufPtr);
    sndh.cawtooth_sndh_destroy();

    // The init routine has to have programmed at least *some* YM state,
    // so generate() should produce a non-trivial signal — not absolute
    // silence and not just DC offset noise.
    expect(nonZero).toBeGreaterThan(numFrames); // at least 1 nonzero per frame on average
    expect(peak).toBeGreaterThan(100);
  });
});
