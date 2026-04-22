import {
  compileNukedOpl3,
  dedupRegisterEventStream,
  encodeDro,
  encodeImf,
  instantiateNukedOpl3,
  NukedOpl3Chip,
  OplPlayer,
  parseHerad,
  renderHeradToStream,
  renderToWav,
  windowedDedupRegisterEventStream,
  type HeradSong,
  type HeradVariant,
  type RegisterEventStream,
  type TimedRegisterStream,
} from 'cawtooth';
import workletUrl from 'cawtooth/worklet?url';
import wasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';

import { createOscilloscope } from './oscilloscope.js';

const fileInput = document.getElementById('file') as HTMLInputElement;
const variantSelect = document.getElementById('variant') as HTMLSelectElement;
const loopCheckbox = document.getElementById('loop') as HTMLInputElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const pauseBtn = document.getElementById('pause') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLElement;
const metadataEl = document.getElementById('metadata') as HTMLElement;
const metaVariant = document.getElementById('meta-variant') as HTMLElement;
const metaChip = document.getElementById('meta-chip') as HTMLElement;
const metaTracks = document.getElementById('meta-tracks') as HTMLElement;
const metaInstruments = document.getElementById('meta-instruments') as HTMLElement;
const metaSpeed = document.getElementById('meta-speed') as HTMLElement;
const metaLoop = document.getElementById('meta-loop') as HTMLElement;
const metaEvents = document.getElementById('meta-events') as HTMLElement;
const metaTickrate = document.getElementById('meta-tickrate') as HTMLElement;
const exportWavBtn = document.getElementById('export-wav') as HTMLButtonElement;
const exportDroBtn = document.getElementById('export-dro') as HTMLButtonElement;
const exportImfBtn = document.getElementById('export-imf') as HTMLButtonElement;
const exportWlfBtn = document.getElementById('export-wlf') as HTMLButtonElement;
const dedupModeSelect = document.getElementById('dedup-mode') as HTMLSelectElement;

const scope = createOscilloscope(document.getElementById('scope-grid') as HTMLElement);

let player: OplPlayer | null = null;
let currentSong: HeradSong | null = null;
let currentStream: TimedRegisterStream | null = null;
let currentFileName = '';

// Cached wasm module for offline rendering. Compiled once when the first
// export runs, reused for subsequent exports. The worklet has its own
// instance; this is a separate main-thread instance used only for WAV.
let cachedWasmModule: WebAssembly.Module | null = null;

function setStatus(s: string): void {
  statusEl.textContent = s;
}

function setControlsEnabled(loaded: boolean): void {
  playBtn.disabled = !loaded;
  pauseBtn.disabled = !loaded;
  stopBtn.disabled = !loaded;
  exportWavBtn.disabled = !loaded;
  exportDroBtn.disabled = !loaded;
  exportImfBtn.disabled = !loaded;
  exportWlfBtn.disabled = !loaded;
}

async function ensurePlayer(): Promise<OplPlayer> {
  if (player) return player;
  setStatus('loading worklet + wasm…');
  const p = await OplPlayer.create({ workletUrl, wasmUrl });
  p.output.connect(p.audioContext.destination);
  p.onChannels(scope.ingest);
  scope.start();
  player = p;
  return p;
}

async function parseAndLoad(): Promise<void> {
  const file = fileInput.files?.[0];
  if (!file) return;

  try {
    setStatus(`parsing ${file.name}…`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const variantOpt: HeradVariant | undefined =
      variantSelect.value === 'auto' ? undefined : (variantSelect.value as HeradVariant);
    const song = parseHerad(bytes, variantOpt ? { variant: variantOpt } : {});
    const stream = renderHeradToStream(song);

    currentSong = song;
    currentStream = stream;
    currentFileName = file.name;

    metaVariant.textContent = song.variant;
    metaChip.textContent = song.isAgd ? 'AdLib Gold (OPL3)' : 'AdLib (OPL2)';
    metaTracks.textContent = String(song.tracks.length);
    metaInstruments.textContent = String(song.instruments.length);
    metaSpeed.textContent = `0x${song.speed.toString(16)} (${song.speed})`;
    metaLoop.textContent =
      song.loopStart && song.loopEnd
        ? `${song.loopStart}–${song.loopEnd} ×${song.loopCount || '∞'}`
        : 'none';
    metaEvents.textContent = String(stream.stream.regs.length);
    metaTickrate.textContent = `${stream.tickRate.toFixed(2)} Hz`;
    metadataEl.hidden = false;

    const p = await ensurePlayer();
    await p.resume();
    p.loadStream(stream.stream, { tickRate: stream.tickRate, loop: loopCheckbox.checked });

    setControlsEnabled(true);
    setStatus(`loaded ${file.name}. Click Play.`);
  } catch (err) {
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Trigger a browser download of the given bytes with the given filename. */
function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes.slice()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke asynchronously — some browsers need the URL valid until the click
  // is fully processed.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Replace the file extension. `base.hsq` + `.wav` → `base.wav`. */
function withExtension(filename: string, ext: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem}${ext}`;
}

async function ensureWasmModule(): Promise<WebAssembly.Module> {
  if (cachedWasmModule) return cachedWasmModule;
  cachedWasmModule = await compileNukedOpl3(wasmUrl);
  return cachedWasmModule;
}

type DedupMode = 'off' | 'lossless' | 'subtle' | 'compact' | 'auto';

/** Ladder of windowed-dedup sizes auto mode tries in order. */
const AUTO_WINDOW_LADDER = [1, 2, 5, 10, 25] as const;

/**
 * Apply the demo's dedup-mode dropdown to a stream before export. Returns
 * the (possibly transformed) stream along with a human-readable note for
 * the status line.
 *
 * @param maxEvents - If supplied, `auto` mode escalates window size until
 *   the resulting stream has ≤ `maxEvents` events. Pass undefined (e.g.
 *   for WLF or DRO export) when there is no cap — `auto` then behaves
 *   like `lossless`.
 */
function applyDedupForExport(
  timed: TimedRegisterStream,
  mode: DedupMode,
  maxEvents: number | undefined,
): { timed: TimedRegisterStream; note: string } {
  if (mode === 'off') {
    return { timed, note: '' };
  }

  // Every non-off mode starts with the lossless pass.
  const lossless = dedupRegisterEventStream(timed.stream);
  const originalN = timed.stream.regs.length;

  const pack = (
    out: RegisterEventStream,
    label: string,
  ): { timed: TimedRegisterStream; note: string } => {
    const saved = Math.round((1 - out.regs.length / originalN) * 100);
    const changed = out.regs.length !== originalN;
    const note = changed ? ` · ${label} saved ${saved}%` : '';
    return { timed: { stream: out, tickRate: timed.tickRate }, note };
  };

  if (mode === 'lossless') {
    return pack(lossless, 'dedup (lossless)');
  }
  if (mode === 'subtle') {
    const out = windowedDedupRegisterEventStream(lossless, 1);
    return pack(out, 'dedup + 20 ms window');
  }
  if (mode === 'compact') {
    const out = windowedDedupRegisterEventStream(lossless, 25);
    return pack(out, 'dedup + 500 ms window');
  }

  // 'auto': escalate until we fit, or exhaust the ladder.
  if (maxEvents === undefined || lossless.regs.length <= maxEvents) {
    return pack(lossless, 'auto: lossless');
  }
  for (const w of AUTO_WINDOW_LADDER) {
    const out = windowedDedupRegisterEventStream(lossless, w);
    if (out.regs.length <= maxEvents) {
      const ms = Math.round((1000 * w) / timed.tickRate);
      return pack(out, `auto: window=${w} tick${w === 1 ? '' : 's'} (~${ms} ms)`);
    }
  }
  // Fell through; give the most aggressive attempt and let the caller
  // decide what to do (the IMF path will fail the encode step with a
  // sensible "use WLF" message).
  const out = windowedDedupRegisterEventStream(lossless, 25);
  return pack(out, 'auto: window=25 ticks (still too big)');
}

/** IMF type-1 has a u16 length cap on the event stream, 65,535 bytes. */
const IMF_TYPE1_MAX_EVENTS = Math.floor(0xffff / 4);

function getDedupMode(): DedupMode {
  return dedupModeSelect.value as DedupMode;
}

fileInput.addEventListener('change', () => void parseAndLoad());
variantSelect.addEventListener('change', () => void parseAndLoad());
loopCheckbox.addEventListener('change', () => void parseAndLoad());

playBtn.addEventListener('click', () => {
  player?.play();
  setStatus('playing');
});
pauseBtn.addEventListener('click', () => {
  player?.pause();
  setStatus('paused');
});
stopBtn.addEventListener('click', () => {
  player?.stop();
  setStatus('stopped (rewound to song start)');
});

exportWavBtn.addEventListener('click', async () => {
  if (!currentStream) return;
  try {
    setStatus('rendering WAV…');
    const module = await ensureWasmModule();
    const instance = await instantiateNukedOpl3(module);
    const chip = new NukedOpl3Chip(instance, 48000);
    try {
      // WAV bypasses dedup: the chip is the sink, dedup saves encoding
      // work for file formats (fewer events to write out), not playback
      // work. A deduped stream renders to identical audio anyway (proven
      // by the sample-identity test), so there's nothing to gain here.
      const wav = renderToWav(currentStream, { chip, tailSec: 2.0 });
      downloadBytes(wav, withExtension(currentFileName, '.wav'));
      setStatus(`exported ${withExtension(currentFileName, '.wav')}`);
    } finally {
      chip.dispose();
    }
  } catch (err) {
    setStatus(`WAV export error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

exportDroBtn.addEventListener('click', () => {
  if (!currentStream) return;
  try {
    // DRO v2 has no length cap, so `auto` has nothing to escalate toward
    // and behaves like lossless. Otherwise honour the user's pick directly.
    const { timed, note } = applyDedupForExport(currentStream, getDedupMode(), undefined);
    const dro = encodeDro(timed);
    downloadBytes(dro, withExtension(currentFileName, '.dro'));
    setStatus(`exported ${withExtension(currentFileName, '.dro')}${note}`);
  } catch (err) {
    setStatus(`DRO export error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

/**
 * IMF (Keen family): type-1 at 560 Hz, carries metadata. Rendered HERAD
 * streams frequently exceed the type-1 u16 length ceiling (65 KB of
 * events). The dropdown controls how aggressively to shrink the stream
 * before encoding. `auto` escalates from lossless through increasing
 * window sizes until the result fits the 16,383-event cap. If even the
 * most aggressive attempt doesn't fit, we report that clearly.
 */
exportImfBtn.addEventListener('click', () => {
  if (!currentStream || !currentSong) return;
  try {
    const mode = getDedupMode();
    const { timed, note: dedupNote } = applyDedupForExport(
      currentStream,
      mode,
      IMF_TYPE1_MAX_EVENTS,
    );
    const stem = currentFileName.replace(/\.[^.]+$/, '');
    try {
      const imf = encodeImf(timed, {
        opl3: 'drop',
        targetTickRate: 560,
        variant: 'type1',
        title: stem,
        source: `HERAD ${currentSong.variant}${currentSong.isAgd ? ' (AGD)' : ''}`,
        remarks: 'cawtooth export @ 560 Hz',
      });
      const name = withExtension(currentFileName, '.imf');
      downloadBytes(imf, name);
      setStatus(
        `exported ${name} @ 560 Hz · type-1 with metadata${dedupNote}` +
          (currentSong.isAgd ? ' · OPL3 upper-bank writes dropped' : ''),
      );
    } catch {
      const hint =
        mode === 'auto'
          ? "even the most aggressive window (500 ms) doesn't bring this song under the type-1 cap. Use the WLF button instead — WLF (type-0) has no length limit."
          : mode === 'compact'
            ? 'still too large at 500 ms window. Try Auto, or use the WLF button.'
            : 'too large for IMF type-1 at this dedup setting. Try a more aggressive mode (or Auto), or use the WLF button.';
      setStatus(`IMF export: ${hint}`);
    }
  } catch (err) {
    setStatus(`IMF export error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

/**
 * WLF (Wolf3D family): type-0 at 700 Hz. The format has no length prefix
 * and no metadata — works for any song regardless of length. Dedup is
 * still applied per the dropdown since smaller files are always nicer,
 * but there's no cap to escalate toward, so `auto` acts as `lossless`.
 */
exportWlfBtn.addEventListener('click', () => {
  if (!currentStream || !currentSong) return;
  try {
    const { timed, note: dedupNote } = applyDedupForExport(
      currentStream,
      getDedupMode(),
      undefined,
    );
    const wlf = encodeImf(timed, {
      opl3: 'drop',
      targetTickRate: 700,
      variant: 'type0',
    });
    const name = withExtension(currentFileName, '.wlf');
    downloadBytes(wlf, name);
    setStatus(
      `exported ${name} @ 700 Hz · type-0${dedupNote}` +
        (currentSong.isAgd ? ' · OPL3 upper-bank writes dropped' : ''),
    );
  } catch (err) {
    setStatus(`WLF export error: ${err instanceof Error ? err.message : String(err)}`);
  }
});
