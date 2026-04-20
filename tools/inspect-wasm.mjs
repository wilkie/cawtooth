// Quick sanity check: load the built wasm, list exports, run a smoke test
// that allocates a chip, writes to a register, generates some samples, and
// asserts the samples aren't all zero (suggesting the register write took
// effect — OPL2/3 at silence produces zeros).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../packages/core/wasm/nuked-opl3.wasm');

const bytes = await readFile(wasmPath);

// Minimal WASI shim — Emscripten's standalone wasm references a few WASI
// imports; none are actually called at runtime for our code path (no I/O),
// but the module still needs them present at instantiation time.
const wasi_snapshot_preview1 = new Proxy(
  {},
  {
    get: () => () => 0,
  },
);

const env = {
  emscripten_notify_memory_growth: () => {},
};

const { instance } = await WebAssembly.instantiate(bytes, {
  wasi_snapshot_preview1,
  env,
});

const ex = instance.exports;
const exportNames = Object.keys(ex).sort();

console.log(`Exports (${exportNames.length}):`);
for (const name of exportNames) {
  console.log(`  ${name}: ${typeof ex[name]}`);
}

console.log('');
console.log('--- Smoke test ---');

// Some standalone wasm modules need _initialize() called once before use
// (this runs static constructors / initializers).
if (typeof ex._initialize === 'function') {
  ex._initialize();
  console.log('Called _initialize()');
}

const SAMPLE_RATE = 48000;
const chipSize = ex.cawtooth_opl_chip_size();
console.log(`chip struct size: ${chipSize} bytes`);

const chip = ex.cawtooth_opl_create(SAMPLE_RATE);
console.log(`chip handle: 0x${chip.toString(16)}`);

// Write a basic test tone: channel 0, note-on, some frequency/block.
// These are OPL register writes:
//   0x20-0x35: operator settings for channels 0-5
//   0x40: total level (volume)
//   0x60: attack/decay
//   0x80: sustain/release
//   0xA0: F-Number low byte (channel 0)
//   0xB0: key-on + block + F-Number high bits (channel 0)
ex.cawtooth_opl_write(chip, 0x20, 0x01); // op1: mult=1
ex.cawtooth_opl_write(chip, 0x23, 0x01); // op2: mult=1
ex.cawtooth_opl_write(chip, 0x40, 0x10); // op1: TL (-16 dB)
ex.cawtooth_opl_write(chip, 0x43, 0x00); // op2: TL (full)
ex.cawtooth_opl_write(chip, 0x60, 0xF0); // op1: attack=F, decay=0
ex.cawtooth_opl_write(chip, 0x63, 0xF0); // op2: attack=F, decay=0
ex.cawtooth_opl_write(chip, 0x80, 0x77); // op1: sustain=7, release=7
ex.cawtooth_opl_write(chip, 0x83, 0x77); // op2: sustain=7, release=7
ex.cawtooth_opl_write(chip, 0xA0, 0x41); // fnum low
ex.cawtooth_opl_write(chip, 0xB0, 0x32); // key-on=1, block=4, fnum high bits

const NUM_FRAMES = 1024;
const bufBytes = NUM_FRAMES * 2 * 2; // stereo * int16
const bufPtr = ex.malloc(bufBytes);

ex.cawtooth_opl_generate(chip, bufPtr, NUM_FRAMES);

const memory = new Int16Array(ex.memory.buffer, bufPtr, NUM_FRAMES * 2);
let peak = 0;
let nonZero = 0;
for (const s of memory) {
  if (Math.abs(s) > peak) peak = Math.abs(s);
  if (s !== 0) nonZero++;
}
console.log(`samples: ${memory.length}, non-zero: ${nonZero}, peak: ${peak}`);

ex.free(bufPtr);
ex.cawtooth_opl_destroy(chip);

if (nonZero === 0) {
  console.error('FAIL: emulator produced all-zero samples');
  process.exit(1);
}
console.log('OK: emulator is generating audio');
