/**
 * WebAssembly loader helpers for the Ayumi build.
 *
 * Parallel to `loader.ts` (Nuked-OPL3) and `resid-loader.ts` (reSID).
 * Standalone wasm — same no-op shims are all it needs from the host. The
 * exported C-ABI surface matches `packages/core/native/ayumi-wrapper.c`.
 */

export interface AyumiExports {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (size: number) => number;
  readonly free: (ptr: number) => void;
  readonly _initialize?: () => void;
  readonly cawtooth_ay_create: (isYm: number, clockRate: number, sampleRate: number) => number;
  readonly cawtooth_ay_destroy: (handle: number) => void;
  readonly cawtooth_ay_reset: (handle: number) => void;
  readonly cawtooth_ay_write: (handle: number, reg: number, value: number) => void;
  readonly cawtooth_ay_read: (handle: number, reg: number) => number;
  readonly cawtooth_ay_set_pan: (
    handle: number,
    channel: number,
    pan: number,
    isEqp: number,
  ) => void;
  readonly cawtooth_ay_generate: (handle: number, bufPtr: number, numFrames: number) => void;
  readonly cawtooth_ay_generate_channels: (
    handle: number,
    stereoPtr: number,
    channelsPtr: number,
    numFrames: number,
  ) => void;
  readonly cawtooth_ay_chip_size: () => number;
}

export function createAyumiImports(): WebAssembly.Imports {
  return {
    env: {
      emscripten_notify_memory_growth: () => {},
    },
    wasi_snapshot_preview1: new Proxy(
      {},
      {
        get: () => () => 0,
      },
    ),
  };
}

export async function compileAyumi(
  source: BufferSource | Response | URL | string,
): Promise<WebAssembly.Module> {
  if (source instanceof Response) {
    if ('compileStreaming' in WebAssembly) {
      return await WebAssembly.compileStreaming(source);
    }
    return await WebAssembly.compile(await source.arrayBuffer());
  }
  if (typeof source === 'string' || source instanceof URL) {
    const resp = await fetch(source);
    if ('compileStreaming' in WebAssembly) {
      return await WebAssembly.compileStreaming(resp);
    }
    return await WebAssembly.compile(await resp.arrayBuffer());
  }
  return await WebAssembly.compile(source);
}

export async function instantiateAyumi(module: WebAssembly.Module): Promise<WebAssembly.Instance> {
  return await WebAssembly.instantiate(module, createAyumiImports());
}

export function asAyumiExports(instance: WebAssembly.Instance): AyumiExports {
  return instance.exports as unknown as AyumiExports;
}
