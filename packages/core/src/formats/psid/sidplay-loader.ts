/**
 * WebAssembly loader helpers for the sidplay.wasm build (fake6502 + reSID
 * + 64 KB RAM). Parallel to `loader.ts` (Nuked-OPL3) and `resid-loader.ts`
 * (reSID standalone) — same no-op shims, same compile/instantiate shape.
 */

export interface SidplayExports {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (size: number) => number;
  readonly free: (ptr: number) => void;
  readonly _initialize?: () => void;
  readonly cawtooth_sidplay_create: (
    clockHz: number,
    sampleHz: number,
    model: number,
    method: number,
  ) => number;
  readonly cawtooth_sidplay_destroy: () => void;
  readonly cawtooth_sidplay_load: (
    loadAddr: number,
    dataPtr: number,
    length: number,
  ) => void;
  readonly cawtooth_sidplay_init: (
    initAddr: number,
    songNum: number,
    playAddr: number,
    cyclesPerFrameVblank: number,
    useCiaTimer: number,
    isRsid: number,
  ) => number;
  readonly cawtooth_sidplay_get_play_interval: () => number;
  readonly cawtooth_sidplay_generate: (bufPtr: number, numSamples: number) => void;
  readonly cawtooth_sidplay_generate_channels: (
    stereoPtr: number,
    channelsPtr: number,
    numSamples: number,
  ) => void;
  readonly cawtooth_sidplay_peek: (addr: number) => number;
  readonly cawtooth_sidplay_reset_sid: () => void;
}

export function createSidplayImports(): WebAssembly.Imports {
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

export async function compileSidplay(
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

export async function instantiateSidplay(
  module: WebAssembly.Module,
): Promise<WebAssembly.Instance> {
  return await WebAssembly.instantiate(module, createSidplayImports());
}

export function asSidplayExports(instance: WebAssembly.Instance): SidplayExports {
  return instance.exports as unknown as SidplayExports;
}
