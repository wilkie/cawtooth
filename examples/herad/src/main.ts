import { OplPlayer, parseHerad, renderHeradToStream, type HeradVariant } from 'cawtooth';
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

    hasLoaded = true;
    setControlsEnabled();
    setStatus(`loaded ${file.name}. Click Play.`);
  } catch (err) {
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

fileInput.addEventListener('change', () => void parseAndLoad());
// Reloading when variant/loop change re-parses with new options — quick and
// robust for in-browser experimentation.
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
