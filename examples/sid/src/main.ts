import {
  PsidPlayer,
  SidTune,
  createSidplayImports,
  parsePsid,
  renderSidTuneToWav,
  type PsidPlaybackInfo,
} from 'cawtooth';
import workletUrl from 'cawtooth/worklet/psid?url';
import wasmUrl from 'cawtooth/wasm/sidplay.wasm?url';
import batmanUrl from '../data/Batman_the_Movie.sid?url';
import { createOscilloscope, type Oscilloscope } from './oscilloscope.js';

const statusEl = document.getElementById('status') as HTMLElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const sourceSel = document.getElementById('source') as HTMLSelectElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const subsongSel = document.getElementById('subsong') as HTMLSelectElement;
const metaEl = document.getElementById('meta') as HTMLElement;
const metaTitle = document.getElementById('meta-title') as HTMLElement;
const metaAuthor = document.getElementById('meta-author') as HTMLElement;
const metaReleased = document.getElementById('meta-released') as HTMLElement;
const metaChip = document.getElementById('meta-chip') as HTMLElement;
const metaClock = document.getElementById('meta-clock') as HTMLElement;
const metaPlayRate = document.getElementById('meta-play-rate') as HTMLElement;
const scopeContainer = document.getElementById('scope') as HTMLElement;
const downloadBtn = document.getElementById('download') as HTMLButtonElement;
const downloadLengthSel = document.getElementById('download-length') as HTMLSelectElement;

const scope: Oscilloscope = createOscilloscope(scopeContainer, {
  voiceCount: 3,
  label: (v) => `Voice ${v + 1}`,
});

let player: PsidPlayer | null = null;
let unsubscribeScope: (() => void) | null = null;
let pendingSidBytes: ArrayBuffer | null = null;
// The bytes of the currently-loaded tune, kept so the download handler
// can re-parse + re-render offline. PsidPlayer.create doesn't transfer
// sidBytes, so this reference stays live.
let currentSidBytes: ArrayBuffer | null = null;
// Cached wasm module for offline render. Re-fetched once on first
// download click; browser cache makes subsequent calls effectively free.
let cachedWasmModule: WebAssembly.Module | null = null;

function setStatus(s: string): void {
  statusEl.textContent = s;
}

async function loadBatman(): Promise<ArrayBuffer> {
  const resp = await fetch(batmanUrl);
  if (!resp.ok) throw new Error(`failed to fetch builtin SID: ${resp.status}`);
  return await resp.arrayBuffer();
}

async function loadPicked(): Promise<ArrayBuffer> {
  const file = fileInput.files?.[0];
  if (!file) throw new Error('no .sid file selected');
  return await file.arrayBuffer();
}

function renderMeta(info: PsidPlaybackInfo): void {
  metaTitle.textContent = info.name || '(unnamed)';
  metaAuthor.textContent = info.author || '(unknown)';
  metaReleased.textContent = info.released || '';
  metaChip.textContent = info.model;
  metaClock.textContent = `${info.clockFrequency.toLocaleString()} Hz`;
  // Calls-per-second from the resolved cycles-per-frame budget. Round to
  // 2 decimals — PAL vblank isn't exactly 50 Hz (50.124), and CIA values
  // can be arbitrary.
  const hz = info.clockFrequency / info.playInterval;
  metaPlayRate.textContent = `${info.playInterval.toLocaleString()} cycles (${hz.toFixed(2)} Hz)`;
  metaEl.hidden = false;

  subsongSel.innerHTML = '';
  for (let i = 1; i <= info.songs; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = i === info.subsong ? `${i} (default)` : String(i);
    if (i === info.subsong) opt.selected = true;
    subsongSel.append(opt);
  }
  subsongSel.disabled = info.songs <= 1;
}

sourceSel.addEventListener('change', () => {
  fileInput.style.display = sourceSel.value === 'picker' ? '' : 'none';
  if (sourceSel.value === 'picker') fileInput.click();
});

fileInput.addEventListener('change', async () => {
  if (!fileInput.files?.[0]) return;
  pendingSidBytes = await fileInput.files[0].arrayBuffer();
  setStatus(`loaded ${fileInput.files[0].name} — click Play`);
});

playBtn.addEventListener('click', async () => {
  try {
    playBtn.disabled = true;
    setStatus('loading worklet + wasm + tune…');

    // Dispose any existing player so we start from a clean slate.
    if (player) {
      unsubscribeScope?.();
      unsubscribeScope = null;
      await player.dispose();
      player = null;
    }

    const sidBytes =
      pendingSidBytes ??
      (sourceSel.value === 'picker' ? await loadPicked() : await loadBatman());

    currentSidBytes = sidBytes;

    player = await PsidPlayer.create({
      workletUrl,
      wasmUrl,
      sidBytes,
    });
    player.output.connect(player.audioContext.destination);
    await player.resumeAudio();

    // Subscribe the scope to per-voice PCM taps for as long as this
    // player is alive.
    unsubscribeScope = player.onChannels(scope.ingest);
    scope.start();

    renderMeta(player.info);
    downloadBtn.disabled = false;
    setStatus(
      `playing — "${player.info.name}" subsong ${player.info.subsong}/${player.info.songs} on ${player.info.model}`,
    );
    pendingSidBytes = null;
  } catch (err) {
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    playBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', () => {
  player?.stop();
  setStatus('stopped (chip silenced)');
});

subsongSel.addEventListener('change', () => {
  if (!player) return;
  const sub = Number(subsongSel.value);
  player.selectSong(sub);
  setStatus(`playing — subsong ${sub}/${player.info.songs}`);
});

async function ensureWasmModule(): Promise<WebAssembly.Module> {
  if (cachedWasmModule) return cachedWasmModule;
  const resp = await fetch(wasmUrl);
  if (!resp.ok) throw new Error(`failed to fetch wasm: ${resp.status}`);
  cachedWasmModule = await WebAssembly.compile(await resp.arrayBuffer());
  return cachedWasmModule;
}

function sanitizeFilename(name: string): string {
  // Keep alnum, dash, underscore, dot, space. Collapse anything else to
  // underscore. Trim leading/trailing whitespace.
  const cleaned = name.replace(/[^\w\-. ]+/g, '_').trim();
  return cleaned || 'sid-tune';
}

downloadBtn.addEventListener('click', async () => {
  if (!currentSidBytes || !player) {
    setStatus('nothing loaded — press Play first');
    return;
  }
  const info = player.info;
  const durationSec = Number(downloadLengthSel.value);

  downloadBtn.disabled = true;
  setStatus(`rendering ${durationSec}s of "${info.name}" (subsong ${info.subsong})…`);

  try {
    const t0 = performance.now();

    // Offline render runs on the main thread with its own wasm instance,
    // independent of the worklet that's doing live playback. The tune
    // bytes are still live on the main thread (PsidPlayer.create doesn't
    // transfer them) so we can just reparse + rerun init here.
    const song = parsePsid(new Uint8Array(currentSidBytes));
    const wasmModule = await ensureWasmModule();
    const instance = new WebAssembly.Instance(wasmModule, createSidplayImports());
    const tune = new SidTune(instance, song, {
      sampleRate: 44100,
      model: info.model,
      clockFrequency: info.clockFrequency,
    });
    const wav = renderSidTuneToWav({
      tune,
      subsong: info.subsong,
      durationSec,
      fadeOutSec: Math.min(3, durationSec / 4),
    });
    tune.dispose();

    // Build a filename: "{title}-subsong{n}.wav"
    const base = sanitizeFilename(info.name);
    const suffix = info.songs > 1 ? `-subsong${info.subsong}` : '';
    const filename = `${base}${suffix}.wav`;

    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);

    const elapsedMs = performance.now() - t0;
    setStatus(
      `rendered ${filename} (${(wav.length / 1024).toFixed(0)} KB) in ${elapsedMs.toFixed(0)}ms`,
    );
  } catch (err) {
    setStatus(`export failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    downloadBtn.disabled = false;
  }
});
