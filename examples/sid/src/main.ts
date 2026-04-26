import {
  PsidPlayer,
  SidTune,
  computeSidTuneMd5,
  createSidplayImports,
  lookupSongLengths,
  parsePsid,
  parseSongLengthsDb,
  renderSidTuneToWav,
  type ProgressInfo,
  type PsidPlayerInfo,
  type PsidSong,
  type SongLengthsDb,
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
const metaDuration = document.getElementById('meta-duration') as HTMLElement;
const scopeContainer = document.getElementById('scope') as HTMLElement;
const downloadBtn = document.getElementById('download') as HTMLButtonElement;
const downloadLengthSel = document.getElementById('download-length') as HTMLSelectElement;
const songlengthsFile = document.getElementById('songlengths-file') as HTMLInputElement;
const songlengthsStatus = document.getElementById('songlengths-status') as HTMLElement;
const progressElapsed = document.getElementById('progress-elapsed') as HTMLElement;
const progressTotal = document.getElementById('progress-total') as HTMLElement;
const progressFill = document.getElementById('progress-fill') as HTMLElement;

function labelForVoice(voiceIdx: number, sidCount: number): string {
  // For single-SID tunes label the three canvases as V1/V2/V3. For
  // multi-SID, prefix with the SID chip number so it's clear which
  // chip a voice belongs to.
  const voiceInSid = (voiceIdx % 3) + 1;
  if (sidCount <= 1) return `Voice ${voiceInSid}`;
  const sidIdx = Math.floor(voiceIdx / 3) + 1;
  return `SID ${sidIdx} · V${voiceInSid}`;
}

/**
 * (Re)create the scope for the given active-SID count. Creating
 * with exactly `3 * sidCount` voice canvases matches what a multi-SID
 * tune actually uses — the worklet still emits a stride-9 stream but
 * the scope renders only the first `3 * sidCount` slots, inferring the
 * stride from the incoming buffer length.
 */
function buildScope(sidCount: number): Oscilloscope {
  const voiceCount = Math.max(3, Math.min(9, 3 * sidCount));
  return createOscilloscope(scopeContainer, {
    voiceCount,
    label: (v) => labelForVoice(v, sidCount),
  });
}

let scope: Oscilloscope = buildScope(1);

let player: PsidPlayer | null = null;
let unsubscribeScope: (() => void) | null = null;
let pendingSidBytes: ArrayBuffer | null = null;
let songlengthsDb: SongLengthsDb | null = null;
let currentSong: PsidSong | null = null;
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

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function formatMmSs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateProgress(info: ProgressInfo): void {
  progressElapsed.textContent = formatMmSs(info.currentTimeSec);
  if (info.durationSec !== null && info.durationSec > 0) {
    progressTotal.textContent = formatMmSs(info.durationSec);
    const pct = Math.min(100, (info.currentTimeSec / info.durationSec) * 100);
    progressFill.style.width = `${pct}%`;
  } else {
    progressTotal.textContent = '—';
    progressFill.style.width = '0%';
  }
}

/**
 * Determine the expected duration for the currently-initialized subsong
 * from the loaded SongLengths database (if any) and push it to the
 * worklet. Pushing `null` disables end detection — used when no DB is
 * loaded or the tune isn't in it.
 */
function pushDurationToPlayer(): void {
  if (!player || !currentSong) return;
  if (!songlengthsDb) {
    player.setSubsongDurationSec(null);
    return;
  }
  const entry = lookupSongLengths(currentSong, songlengthsDb);
  if (!entry) {
    player.setSubsongDurationSec(null);
    return;
  }
  const subsong = player.info.subsong;
  const idx = Math.min(subsong - 1, entry.durations.length - 1);
  player.setSubsongDurationSec(entry.durations[idx]);
}

function renderDuration(): void {
  if (!currentSong || !songlengthsDb) {
    metaDuration.textContent = songlengthsDb ? '—' : 'load Songlengths.md5 to show';
    return;
  }
  const entry = lookupSongLengths(currentSong, songlengthsDb);
  if (!entry) {
    metaDuration.textContent = `not in database (hash: ${computeSidTuneMd5(currentSong)})`;
    return;
  }
  const subsong = player?.info.subsong ?? currentSong.startSong;
  const idx = Math.min(subsong - 1, entry.durations.length - 1);
  const thisSub = entry.durations[idx];
  const total = entry.durations.reduce((a, b) => a + b, 0);
  metaDuration.textContent =
    `subsong ${subsong}: ${formatDuration(thisSub)}  ` +
    `(all ${entry.count}: ${formatDuration(total)})`;
}

function renderMeta(info: PsidPlayerInfo): void {
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
  renderDuration();
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
      currentSong = null;
    }

    const sidBytes =
      pendingSidBytes ?? (sourceSel.value === 'picker' ? await loadPicked() : await loadBatman());

    currentSidBytes = sidBytes;
    // Parse locally so the duration lookup has something to hash. This
    // duplicates the parse PsidPlayer.create does internally, but the
    // cost is trivial relative to the wasm + worklet bring-up.
    currentSong = parsePsid(new Uint8Array(sidBytes));

    player = await PsidPlayer.create({
      workletUrl,
      wasmUrl,
      sidBytes,
    });
    player.output.connect(player.audioContext.destination);
    await player.resumeAudio();
    // PsidPlayer.create() returns a paused-at-zero player so the
    // create flow matches OplPlayer + CawtoothPlayer.load(). The
    // demo's "Play" button means "start now," so kick it off here.
    player.play();

    // Rebuild the scope to match this tune's active-SID count (1, 2, or
    // 3). The worklet always emits a stride-9 per-voice buffer; the
    // scope takes a subset.
    const sidCount =
      1 +
      (currentSong.secondSIDAddress !== 0 ? 1 : 0) +
      (currentSong.thirdSIDAddress !== 0 ? 1 : 0);
    scope.dispose();
    scope = buildScope(sidCount);

    // Subscribe the scope to per-voice PCM taps for as long as this
    // player is alive.
    unsubscribeScope = player.onChannels(scope.ingest);
    scope.start();

    // Progress bar follows the worklet's elapsed-time ticks. Reset to
    // zero on each new player so we don't carry a stale value over from
    // a previous tune.
    updateProgress({ currentTimeSec: 0, durationSec: null });
    player.onProgress(updateProgress);

    // Auto-advance: when the HVSC-known duration elapses, jump to the
    // next subsong (wrapping back to 1 at the end). Does nothing when
    // no Songlengths DB is loaded (setSubsongDurationSec(null) keeps
    // the worklet from ever firing `ended`).
    player.onEnded(() => {
      if (!player) return;
      const info = player.info;
      if (info.songs <= 1) {
        setStatus(`finished — "${info.name}"`);
        return;
      }
      const next = info.subsong >= info.songs ? 1 : info.subsong + 1;
      player.selectSong(next);
      // Mirror the dropdown so the UI reflects the change.
      subsongSel.value = String(next);
      // `player.info` is mutated inside selectSong; refresh downstream UI.
      renderMeta(info);
      pushDurationToPlayer();
      setStatus(`auto-advanced — subsong ${next}/${info.songs}`);
    });
    pushDurationToPlayer();

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
  renderDuration();
  pushDurationToPlayer();
  setStatus(`playing — subsong ${sub}/${player.info.songs}`);
});

songlengthsFile.addEventListener('change', async () => {
  const file = songlengthsFile.files?.[0];
  if (!file) return;
  songlengthsStatus.textContent = 'loading…';
  try {
    const text = await file.text();
    const db = parseSongLengthsDb(text);
    songlengthsDb = db;
    songlengthsStatus.textContent = `${db.size.toLocaleString()} entries loaded`;
    renderDuration();
    // Now that we know the current tune's duration, tell the worklet so
    // it can fire `ended` at the right moment.
    pushDurationToPlayer();
  } catch (err) {
    songlengthsStatus.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
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
