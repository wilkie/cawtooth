import { PsidPlayer, type PsidPlaybackInfo } from 'cawtooth';
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

const scope: Oscilloscope = createOscilloscope(scopeContainer, {
  voiceCount: 3,
  label: (v) => `Voice ${v + 1}`,
});

let player: PsidPlayer | null = null;
let unsubscribeScope: (() => void) | null = null;
let pendingSidBytes: ArrayBuffer | null = null;

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
