/**
 * E2E test harness.
 *
 * The page imports the public `cawtooth` API and the bundled worklet /
 * wasm URLs, then exposes them on `window` so Playwright tests can
 * construct players from inside `page.evaluate()`. There is no UI; the
 * page is a programmatic surface for the test suite.
 *
 * Tests pass binary fixtures across the page boundary as base64 (small
 * files, no need for fancy transfer mechanics) and decode them inside
 * `page.evaluate()`.
 */
import * as cawtooth from 'cawtooth';
import oplWorkletUrl from 'cawtooth/worklet/opl?url';
import psidWorkletUrl from 'cawtooth/worklet/psid?url';
import sidWorkletUrl from 'cawtooth/worklet/sid?url';
import oplWasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';
import sidWasmUrl from 'cawtooth/wasm/sidplay.wasm?url';
import residWasmUrl from 'cawtooth/wasm/resid.wasm?url';

window.cawtooth = cawtooth;
window.cawtoothUrls = {
  oplWorklet: oplWorkletUrl,
  psidWorklet: psidWorkletUrl,
  sidWorklet: sidWorkletUrl,
  oplWasm: oplWasmUrl,
  sidplayWasm: sidWasmUrl,
  residWasm: residWasmUrl,
};
window.b64ToBytes = (b64: string): ArrayBuffer => {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
};

const readyEl = document.getElementById('ready');
if (readyEl) readyEl.textContent = 'ready';
