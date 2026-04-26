/**
 * Shared global type declarations for the e2e harness.
 *
 * `tests/harness/src/harness.ts` ASSIGNS to `window.cawtooth` etc.; specs
 * READ them inside `page.evaluate()` callbacks. Both contexts compile
 * against this declaration so neither needs ad-hoc casts.
 */
import type * as cawtooth from 'cawtooth';

declare global {
  interface Window {
    cawtooth: typeof cawtooth;
    cawtoothUrls: {
      oplWorklet: string;
      psidWorklet: string;
      sidWorklet: string;
      ayWorklet: string;
      oplWasm: string;
      sidplayWasm: string;
      residWasm: string;
      ayumiWasm: string;
    };
    /**
     * Decode a base64 string into a fresh ArrayBuffer. Test convenience —
     * most player APIs accept ArrayBuffer, so this avoids per-call
     * `.buffer.slice(0)` gymnastics. The buffer is freshly allocated and
     * not shared with anything else, safe to transfer.
     */
    b64ToBytes(b64: string): ArrayBuffer;
  }
}

export {};
