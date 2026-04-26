import { OplPlayer, parseDro } from 'cawtooth';
import workletUrl from 'cawtooth/worklet?url';
import wasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';

import { createOscilloscope } from './oscilloscope.js';

const fileInput = document.getElementById('file') as HTMLInputElement;
const loopCheckbox = document.getElementById('loop') as HTMLInputElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const pauseBtn = document.getElementById('pause') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLElement;
const metadataEl = document.getElementById('metadata') as HTMLElement;
const metaVariant = document.getElementById('meta-variant') as HTMLElement;
const metaHardware = document.getElementById('meta-hardware') as HTMLElement;
const metaEvents = document.getElementById('meta-events') as HTMLElement;
const metaDuration = document.getElementById('meta-duration') as HTMLElement;

const scope = createOscilloscope(document.getElementById('scope-grid') as HTMLElement);

let player: OplPlayer | null = null;
let hasLoaded = false;

function setStatus(s: string): void {
  statusEl.textContent = s;
}

function setControlsEnabled(): void {
  playBtn.disabled = !hasLoaded;
  pauseBtn.disabled = !hasLoaded;
  stopBtn.disabled = !hasLoaded;
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

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  try {
    setStatus(`parsing ${file.name}…`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const song = parseDro(bytes);

    metaVariant.textContent = song.variant;
    metaHardware.textContent = song.hardware;
    metaEvents.textContent = String(song.stream.regs.length);
    metaDuration.textContent = `${(song.durationMs / 1000).toFixed(2)} s`;
    metadataEl.hidden = false;

    const p = await ensurePlayer();
    await p.resumeAudio();
    p.loadStream(
      song.stream,
      { tickRate: song.tickRate, loop: loopCheckbox.checked },
      { container: 'dro', variant: song.variant },
    );

    hasLoaded = true;
    setControlsEnabled();
    setStatus(`loaded ${file.name} (${song.stream.regs.length} events). Click Play.`);
  } catch (err) {
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// Reload stream when loop changes mid-session — reparse is cheap for DRO.
loopCheckbox.addEventListener('change', async () => {
  if (!hasLoaded || !player) return;
  const file = fileInput.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const song = parseDro(bytes);
  player.loadStream(song.stream, { tickRate: song.tickRate, loop: loopCheckbox.checked });
  setStatus(`loop=${loopCheckbox.checked}`);
});

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
