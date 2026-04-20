import {
  compileNukedOpl3,
  encodeDro,
  encodeImf,
  instantiateNukedOpl3,
  NukedOpl3Chip,
  OplPlayer,
  parseHerad,
  renderHeradToStream,
  renderToWav,
  type HeradSong,
  type HeradVariant,
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
    const dro = encodeDro(currentStream);
    downloadBytes(dro, withExtension(currentFileName, '.dro'));
    setStatus(`exported ${withExtension(currentFileName, '.dro')}`);
  } catch (err) {
    setStatus(`DRO export error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

exportImfBtn.addEventListener('click', () => {
  if (!currentStream || !currentSong) return;
  try {
    // HERAD files may contain OPL3 upper-bank writes (AGD songs). IMF is an
    // OPL2 format — drop those writes rather than throwing, preserving any
    // remaining audible content.
    const imf = encodeImf(currentStream, { opl3: 'drop' });
    downloadBytes(imf, withExtension(currentFileName, '.imf'));
    setStatus(
      `exported ${withExtension(currentFileName, '.imf')}` +
        (currentSong.isAgd ? ' (OPL3 upper-bank writes dropped)' : ''),
    );
  } catch (err) {
    setStatus(`IMF export error: ${err instanceof Error ? err.message : String(err)}`);
  }
});
