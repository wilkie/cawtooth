/**
 * WebAssembly loader helpers for the Nuked-OPL3 build.
 *
 * The wasm is produced as a standalone module (no Emscripten JS glue). It
 * only needs a tiny set of imports: `ALLOW_MEMORY_GROWTH` adds a single
 * env callback, and standalone mode references WASI stubs that never run
 * on our code paths. We satisfy both with no-op shims.
 */

export interface NukedOpl3Exports {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (size: number) => number;
  readonly free: (ptr: number) => void;
  readonly _initialize?: () => void;
  readonly cawtooth_opl_create: (sampleRate: number) => number;
  readonly cawtooth_opl_destroy: (chipPtr: number) => void;
  readonly cawtooth_opl_reset: (chipPtr: number, sampleRate: number) => void;
  readonly cawtooth_opl_write: (chipPtr: number, reg: number, value: number) => void;
  readonly cawtooth_opl_generate: (chipPtr: number, bufPtr: number, numFrames: number) => void;
  readonly cawtooth_opl_chip_size: () => number;
}

export function createNukedOpl3Imports(): WebAssembly.Imports {
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

export async function compileNukedOpl3(
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

export async function instantiateNukedOpl3(
  module: WebAssembly.Module,
): Promise<WebAssembly.Instance> {
  return await WebAssembly.instantiate(module, createNukedOpl3Imports());
}

export function asNukedOpl3Exports(instance: WebAssembly.Instance): NukedOpl3Exports {
  return instance.exports as unknown as NukedOpl3Exports;
}
