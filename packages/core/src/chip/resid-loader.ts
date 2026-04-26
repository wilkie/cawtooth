/**
 * WebAssembly loader helpers for the reSID build.
 *
 * Parallel to `loader.ts` (Nuked-OPL3). Standalone wasm — same no-op
 * shims are all it needs from the host. The only structural difference
 * from the OPL loader is the exported C-ABI surface, which matches
 * `packages/core/native/resid-wrapper.cc`.
 */

export interface ReSidExports {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (size: number) => number;
  readonly free: (ptr: number) => void;
  readonly _initialize?: () => void;
  readonly cawtooth_sid_create: (
    clockFreq: number,
    sampleFreq: number,
    model: number,
    method: number,
  ) => number;
  readonly cawtooth_sid_destroy: (handle: number) => void;
  readonly cawtooth_sid_reset: (handle: number) => void;
  readonly cawtooth_sid_write: (handle: number, offset: number, value: number) => void;
  readonly cawtooth_sid_read: (handle: number, offset: number) => number;
  readonly cawtooth_sid_generate: (handle: number, bufPtr: number, numSamples: number) => void;
  readonly cawtooth_sid_generate_channels: (
    handle: number,
    stereoPtr: number,
    channelsPtr: number,
    numSamples: number,
  ) => void;
  readonly cawtooth_sid_handle_size: () => number;
}

export function createReSidImports(): WebAssembly.Imports {
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

export async function compileReSid(
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

export async function instantiateReSid(module: WebAssembly.Module): Promise<WebAssembly.Instance> {
  return await WebAssembly.instantiate(module, createReSidImports());
}

export function asReSidExports(instance: WebAssembly.Instance): ReSidExports {
  return instance.exports as unknown as ReSidExports;
}
