import { OplPlayer, parseImf } from 'cawtooth';
import workletUrl from 'cawtooth/worklet?url';
import wasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';

import { createOscilloscope } from './oscilloscope.js';

const fileInput = document.getElementById('file') as HTMLInputElement;
const tickRateSelect = document.getElementById('tick-rate') as HTMLSelectElement;
const loopCheckbox = document.getElementById('loop') as HTMLInputElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const pauseBtn = document.getElementById('pause') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLElement;
const metadataEl = document.getElementById('metadata') as HTMLElement;
const metaTitle = document.getElementById('meta-title') as HTMLElement;
const metaSource = document.getElementById('meta-source') as HTMLElement;
const metaRemarks = document.getElementById('meta-remarks') as HTMLElement;
const metaVariant = document.getElementById('meta-variant') as HTMLElement;
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
  // Route per-voice taps into the oscilloscope. Subscribing here means the
  // worklet starts emitting per-voice blocks as soon as we're live; the scope
  // itself only begins repainting once start() is called below.
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
    const song = parseImf(bytes);
    const tickRate = Number(tickRateSelect.value);
    const loop = loopCheckbox.checked;

    const eventCount = song.stream.regs.length;
    // Duration is derived by the sequencer from tickRate + cumulative delays.
    // We re-derive here so we can show it before any worklet round-trip.
    let cumulative = 0;
    for (const d of song.stream.delayTicks) cumulative += d;
    const durationSec = cumulative / tickRate;

    metaTitle.textContent = song.title || '—';
    metaSource.textContent = song.source || '—';
    metaRemarks.textContent = song.remarks || '—';
    metaVariant.textContent = song.variant;
    metaEvents.textContent = String(eventCount);
    metaDuration.textContent = `${durationSec.toFixed(2)} s`;
    metadataEl.hidden = false;

    const p = await ensurePlayer();
    await p.resume();
    p.loadStream(song.stream, { tickRate, loop });

    hasLoaded = true;
    setControlsEnabled();
    setStatus(`loaded ${file.name} (${eventCount} events). Click Play.`);
  } catch (err) {
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// Reload the stream whenever tick rate or loop change, if something is loaded.
// IMF files don't encode their own rate, so fiddling with the selector is the
// primary way to "tune" playback speed.
function reloadIfLoaded(): void {
  if (!hasLoaded || !player) return;
  const file = fileInput.files?.[0];
  if (!file) return;
  // Cheap: just re-parse + re-load. Files are small.
  void (async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const song = parseImf(bytes);
    player?.loadStream(song.stream, {
      tickRate: Number(tickRateSelect.value),
      loop: loopCheckbox.checked,
    });
    setStatus(`reloaded with tickRate=${tickRateSelect.value} loop=${loopCheckbox.checked}`);
  })();
}
tickRateSelect.addEventListener('change', reloadIfLoaded);
loopCheckbox.addEventListener('change', reloadIfLoaded);

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
