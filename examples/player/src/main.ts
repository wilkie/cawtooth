import {
  CawtoothPlayer,
  OPL_CHANNEL_COUNT,
  OplPlayer,
  Player,
  PsidPlayer,
  type ProgressInfo,
} from 'cawtooth';
import oplWorkletUrl from 'cawtooth/worklet?url';
import psidWorkletUrl from 'cawtooth/worklet/psid?url';
import oplWasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';
import psidWasmUrl from 'cawtooth/wasm/sidplay.wasm?url';

import { createOscilloscope, type Oscilloscope } from './oscilloscope.js';

const fileInput = document.getElementById('file') as HTMLInputElement;
const tickRateSel = document.getElementById('tick-rate') as HTMLSelectElement;
const loopChk = document.getElementById('loop') as HTMLInputElement;
const subsongSel = document.getElementById('subsong') as HTMLSelectElement;
const formatControls = document.getElementById('format-controls') as HTMLElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const pauseBtn = document.getElementById('pause') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLElement;
const metaEl = document.getElementById('meta') as HTMLElement;
const metaFormat = document.getElementById('meta-format') as HTMLElement;
const metaContainer = document.getElementById('meta-container') as HTMLElement;
const metaVariant = document.getElementById('meta-variant') as HTMLElement;
const metaTitle = document.getElementById('meta-title') as HTMLElement;
const metaAuthor = document.getElementById('meta-author') as HTMLElement;
const metaNotes = document.getElementById('meta-notes') as HTMLElement;
const metaDetail = document.getElementById('meta-detail') as HTMLElement;
const scopeContainer = document.getElementById('scope') as HTMLElement;
const progressElapsed = document.getElementById('progress-elapsed') as HTMLElement;
const progressTotal = document.getElementById('progress-total') as HTMLElement;
const progressFill = document.getElementById('progress-fill') as HTMLElement;

let factory: CawtoothPlayer | null = null;
let player: Player | null = null;
let scope: Oscilloscope | null = null;
let unsubscribeScope: (() => void) | null = null;
let pendingBytes: ArrayBuffer | null = null;
let pendingFilename = '';

function setStatus(s: string): void {
  statusEl.textContent = s;
}

function setControlsEnabled(loaded: boolean): void {
  playBtn.disabled = !loaded;
  pauseBtn.disabled = !loaded;
  stopBtn.disabled = !loaded;
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
 * Refresh the visible format-specific controls (IMF tick rate / loop /
 * subsong dropdown) for the active player. The CSS toggles visibility
 * based on the container class; we just set the right class.
 */
function applyFormatControls(p: Player | null): void {
  formatControls.className = 'row format-controls';
  if (!p) return;
  if (p.format === 'opl') {
    formatControls.classList.add('opl');
  } else if (p.format === 'psid') {
    formatControls.classList.add('psid');
    populateSubsongs(p as PsidPlayer);
  }
}

function populateSubsongs(p: PsidPlayer): void {
  subsongSel.innerHTML = '';
  const { songs, subsong } = p.info;
  for (let i = 1; i <= songs; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = i === subsong ? `${i} (default)` : String(i);
    if (i === subsong) opt.selected = true;
    subsongSel.append(opt);
  }
  subsongSel.disabled = songs <= 1;
}

function renderMeta(p: Player): void {
  metaEl.hidden = false;
  // Capture .info into a local so the discriminator narrows. Reading
  // p.info repeatedly defeats narrowing because each access could in
  // principle return a different value (it's a getter).
  const info = p.info;
  metaFormat.textContent = info.format;
  if (info.format === 'opl') {
    metaContainer.textContent = info.container;
    metaVariant.textContent = info.variant || '—';
    metaTitle.textContent = info.title || '—';
    metaAuthor.textContent = info.source || '—';
    metaNotes.textContent = info.remarks || '—';
    metaDetail.textContent = `${info.events.toLocaleString()} events @ ${info.tickRate} Hz${info.loop ? ' (looping)' : ''}`;
  } else {
    metaContainer.textContent = 'PSID/RSID';
    metaVariant.textContent = info.songs > 1 ? `${info.songs} subsongs` : 'single song';
    metaTitle.textContent = info.name || '—';
    metaAuthor.textContent = info.author || '—';
    metaNotes.textContent = info.released || '—';
    const hz = info.clockFrequency / info.playInterval;
    metaDetail.textContent =
      `${info.model} @ ${info.clockFrequency.toLocaleString()} Hz, ` +
      `play every ${info.playInterval.toLocaleString()} cycles (${hz.toFixed(2)} Hz)`;
  }
}

/**
 * Build a scope sized for the active player. For OPL we always render
 * 18 voices; for PSID we render 3, 6, or 9 depending on whether extra
 * SIDs are present (multi-SID PSIDs always emit a stride-9 buffer; the
 * scope just renders fewer canvases when only one or two SIDs are wired).
 */
function buildScope(p: Player): Oscilloscope {
  scopeContainer.className = 'scope-grid';
  if (p.format === 'opl') {
    scopeContainer.classList.add('cols-18');
    return createOscilloscope(scopeContainer, {
      voiceCount: OPL_CHANNEL_COUNT,
      label: (v) => `V${String(v + 1).padStart(2, '0')}`,
      canvasHeight: 48,
    });
  }
  // PSID: detect SID count from the parsed song. We don't have direct
  // access to the parsed PsidSong here (the factory consumed it), but
  // we can read the worklet-reported model — single-SID is the common
  // case. For multi-SID we'd need the song; punt and always show 3.
  // (Multi-SID still works audibly; the scope just shows the primary.)
  scopeContainer.classList.add('cols-3');
  return createOscilloscope(scopeContainer, {
    voiceCount: 3,
    label: (v) => `Voice ${v + 1}`,
    canvasHeight: 80,
  });
}

async function ensureFactory(): Promise<CawtoothPlayer> {
  if (factory) return factory;
  factory = await CawtoothPlayer.init({
    formats: {
      opl: { workletUrl: oplWorkletUrl, wasmUrl: oplWasmUrl },
      psid: { workletUrl: psidWorkletUrl, wasmUrl: psidWasmUrl },
    },
  });
  return factory;
}

async function loadPending(): Promise<void> {
  if (!pendingBytes) return;
  setStatus(`loading ${pendingFilename || 'file'}…`);
  setControlsEnabled(false);

  // Tear down any prior player + scope first. The factory is reused.
  if (player) {
    unsubscribeScope?.();
    unsubscribeScope = null;
    await player.dispose();
    player = null;
  }
  scope?.dispose();
  scope = null;

  try {
    const f = await ensureFactory();
    player = await f.load(pendingBytes, {
      filename: pendingFilename,
      tickRate: Number(tickRateSel.value),
      loop: loopChk.checked,
    });
    player.output.connect(player.audioContext.destination);
    await player.resumeAudio();

    scope = buildScope(player);
    unsubscribeScope = player.onChannels(scope.ingest);
    scope.start();

    updateProgress({ currentTimeSec: 0, durationSec: player.duration });
    player.onProgress(updateProgress);
    player.onEnded(() => {
      // Auto-advance subsong when applicable (PSID with HVSC duration);
      // otherwise just announce that we're done. Without HVSC songlengths
      // this never fires for PSID — the "underlying tune" runs forever.
      if (player instanceof PsidPlayer && player.info.songs > 1) {
        const next = player.info.subsong >= player.info.songs ? 1 : player.info.subsong + 1;
        player.selectSong(next);
        applyFormatControls(player);
        renderMeta(player);
        setStatus(`auto-advanced — subsong ${next}/${player.info.songs}`);
      } else {
        setStatus('finished');
      }
    });

    applyFormatControls(player);
    renderMeta(player);
    setControlsEnabled(true);
    setStatus(
      `loaded as ${player.format.toUpperCase()} — click Play. (${pendingFilename || 'unnamed'})`,
    );
  } catch (err) {
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
    setControlsEnabled(false);
  }
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  pendingBytes = await file.arrayBuffer();
  pendingFilename = file.name;
  await loadPending();
});

// IMF tick-rate and loop changes only matter for OPL containers, and we
// have to re-load to apply them. Cheap: factory.load() reuses cached
// worklet registrations so the wasm + worklet bring-up is amortized.
tickRateSel.addEventListener('change', () => {
  if (!pendingBytes) return;
  if (!(player instanceof OplPlayer)) return;
  void loadPending();
});
loopChk.addEventListener('change', () => {
  if (!pendingBytes) return;
  if (!(player instanceof OplPlayer)) return;
  void loadPending();
});

subsongSel.addEventListener('change', () => {
  if (!(player instanceof PsidPlayer)) return;
  const sub = Number(subsongSel.value);
  player.selectSong(sub);
  renderMeta(player);
  setStatus(`subsong ${sub}/${player.info.songs}`);
});

playBtn.addEventListener('click', async () => {
  if (!player) return;
  await player.resumeAudio();
  player.play();
  setStatus('playing');
});

pauseBtn.addEventListener('click', () => {
  if (!player) return;
  player.pause();
  setStatus('paused');
});

stopBtn.addEventListener('click', () => {
  if (!player) return;
  player.stop();
  updateProgress({ currentTimeSec: 0, durationSec: player.duration });
  setStatus('stopped (rewound to start)');
});
