/**
 * WebAssembly loader helpers for the sndh.wasm build (Musashi + Ayumi
 * + 4 MB Atari ST RAM). Parallel to `sidplay-loader.ts` — same no-op
 * shims, same compile/instantiate shape.
 */

export interface SndhExports {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (size: number) => number;
  readonly free: (ptr: number) => void;
  readonly _initialize?: () => void;
  readonly cawtooth_sndh_create: (
    atariClockHz: number,
    ymClockHz: number,
    sampleRate: number,
    isYm: number,
  ) => number;
  readonly cawtooth_sndh_destroy: () => void;
  readonly cawtooth_sndh_load: (dataPtr: number, length: number) => void;
  readonly cawtooth_sndh_init: (
    initAddr: number,
    exitAddr: number,
    playAddr: number,
    subsong: number,
    cyclesPerPlay: number,
  ) => number;
  readonly cawtooth_sndh_get_play_interval: () => number;
  readonly cawtooth_sndh_generate: (bufPtr: number, numFrames: number) => void;
  readonly cawtooth_sndh_generate_channels: (
    stereoPtr: number,
    channelsPtr: number,
    numFrames: number,
  ) => void;
  readonly cawtooth_sndh_set_pan: (channel: number, pan: number, isEqp: number) => void;
  readonly cawtooth_sndh_peek: (address: number) => number;
  readonly cawtooth_sndh_reset_chip: () => void;
}

export function createSndhImports(): WebAssembly.Imports {
  return {
    env: {
      emscripten_notify_memory_growth: () => {},
      // Musashi's bus-error trap uses setjmp/longjmp. The wrapper validates
      // every memory access before forwarding to Musashi, so longjmp is
      // never reached on healthy SNDH playback — these shims exist only
      // to satisfy the WASM linker. setjmp returns 0 (the "first time
      // through" path); longjmp is a hard error.
      setjmp: () => 0,
      longjmp: () => {
        throw new Error('cawtooth/sndh: unexpected longjmp from m68k bus-error trap');
      },
    },
    wasi_snapshot_preview1: new Proxy(
      {},
      {
        get: () => () => 0,
      },
    ),
  };
}

export async function compileSndh(
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

export async function instantiateSndh(
  module: WebAssembly.Module,
): Promise<WebAssembly.Instance> {
  return await WebAssembly.instantiate(module, createSndhImports());
}

export function asSndhExports(instance: WebAssembly.Instance): SndhExports {
  return instance.exports as unknown as SndhExports;
}
