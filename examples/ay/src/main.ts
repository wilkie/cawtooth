import {
  AyPlayer,
  CawtoothPlayer,
  type AyPlayerInfo,
  type Player,
  type ProgressInfo,
} from 'cawtooth';
import oplWorkletUrl from 'cawtooth/worklet/opl?url';
import psidWorkletUrl from 'cawtooth/worklet/psid?url';
import ayWorkletUrl from 'cawtooth/worklet/ay?url';
import oplWasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';
import sidplayWasmUrl from 'cawtooth/wasm/sidplay.wasm?url';
import ayumiWasmUrl from 'cawtooth/wasm/ayumi.wasm?url';
import { createOscilloscope, type Oscilloscope } from './oscilloscope.js';

const statusEl = document.getElementById('status') as HTMLElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const pauseBtn = document.getElementById('pause') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const sourceSel = document.getElementById('source') as HTMLSelectElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const loopChk = document.getElementById('loop') as HTMLInputElement;
const metaEl = document.getElementById('meta') as HTMLElement;
const metaFormat = document.getElementById('meta-format') as HTMLElement;
const metaTitle = document.getElementById('meta-title') as HTMLElement;
const metaAuthor = document.getElementById('meta-author') as HTMLElement;
const metaComment = document.getElementById('meta-comment') as HTMLElement;
const metaChip = document.getElementById('meta-chip') as HTMLElement;
const metaClock = document.getElementById('meta-clock') as HTMLElement;
const metaTickRate = document.getElementById('meta-tick-rate') as HTMLElement;
const metaEvents = document.getElementById('meta-events') as HTMLElement;
const scopeContainer = document.getElementById('scope') as HTMLElement;
const progressElapsed = document.getElementById('progress-elapsed') as HTMLElement;
const progressTotal = document.getElementById('progress-total') as HTMLElement;
const progressFill = document.getElementById('progress-fill') as HTMLElement;

const scope: Oscilloscope = createOscilloscope(scopeContainer, {
  voiceCount: 3,
  label: (v) => `Voice ${'ABC'.charAt(v)}`,
});

let factory: CawtoothPlayer | null = null;
let player: Player | null = null;
let unsubscribeScope: (() => void) | null = null;
let pendingBytes: ArrayBuffer | null = null;
let pendingFilename: string | null = null;

function setStatus(s: string): void {
  statusEl.textContent = s;
}

/**
 * Build a small synthetic PSG file in-process so the demo has something
 * to play with no user interaction.
 *
 * We program the three AY tone channels with a slow chord progression
 * (Am → F → C → G), each chord held for ~1 second at 50 Hz. The mixer
 * (R7) enables tone on all three channels and disables noise. Volumes
 * (R8/R9/R10) are set to max (0x0F).
 *
 * PSG payload encoding mirrors what `parsePsg` consumes:
 *   - byte R, byte V    — write V to register R
 *   - 0xFF              — advance one frame (1/50 s at default rate)
 *   - 0xFD              — end-of-music
 */
function buildSamplePsg(): Uint8Array {
  const ZX_CLOCK = 1773400;

  // Equal-temperament frequencies for an A minor / F major / C major /
  // G major chord progression. Each chord holds for ~1 s.
  type Chord = readonly [number, number, number];
  const chords: readonly Chord[] = [
    [220, 261.63, 329.63], // A3 + C4 + E4   (A minor)
    [174.61, 220, 261.63], // F3 + A3 + C4   (F major)
    [261.63, 329.63, 392], // C4 + E4 + G4   (C major)
    [196, 246.94, 293.66], // G3 + B3 + D4   (G major)
  ];

  function tonePeriod(freqHz: number): number {
    const raw = Math.round(ZX_CLOCK / (16 * freqHz));
    return Math.min(0xfff, Math.max(1, raw));
  }

  const bytes: number[] = [
    // 16-byte PSG header.
    0x50,
    0x53,
    0x47,
    0x1a, // "PSG\x1A" magic
    0x10, // version (informational)
    0x00, // tick rate (0 = default 50 Hz)
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // reserved
  ];

  function emitChord(freqs: Chord, frames: number): void {
    const periods = freqs.map(tonePeriod);
    bytes.push(
      0x00,
      periods[0] & 0xff, // R0  — Ch A tone period low
      0x01,
      (periods[0] >> 8) & 0x0f, // R1  — Ch A tone period high
      0x02,
      periods[1] & 0xff, // R2  — Ch B tone period low
      0x03,
      (periods[1] >> 8) & 0x0f, // R3  — Ch B tone period high
      0x04,
      periods[2] & 0xff, // R4  — Ch C tone period low
      0x05,
      (periods[2] >> 8) & 0x0f, // R5  — Ch C tone period high
      0x07,
      0xf8, // R7  — mixer: tone A/B/C enabled, noise off, I/O input
      0x08,
      0x0c, // R8  — Ch A volume = 12
      0x09,
      0x0c, // R9  — Ch B volume
      0x0a,
      0x0c, // R10 — Ch C volume
    );
    for (let i = 0; i < frames; i++) bytes.push(0xff);
  }

  for (const chord of chords) emitChord(chord, 50); // 1 second per chord at 50 Hz

  // Cut all volumes so the chip doesn't ring after the song ends.
  bytes.push(0x08, 0x00, 0x09, 0x00, 0x0a, 0x00);
  // A few trailing frames of silence so the ended event fires cleanly
  // after the last chord finishes.
  for (let i = 0; i < 10; i++) bytes.push(0xff);
  bytes.push(0xfd); // end-of-music

  return Uint8Array.from(bytes);
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

function renderMeta(info: AyPlayerInfo): void {
  metaFormat.textContent = `${info.container.toUpperCase()}${info.variant ? ` (${info.variant})` : ''}`;
  metaTitle.textContent = info.title || '(unnamed)';
  metaAuthor.textContent = info.author || '(unknown)';
  metaComment.textContent = info.comment || '';
  metaChip.textContent = info.model;
  metaClock.textContent = `${info.clockFrequency.toLocaleString()} Hz`;
  metaTickRate.textContent = `${info.tickRate} Hz`;
  metaEvents.textContent = `${info.events.toLocaleString()} register writes${info.loop ? ' · looping' : ''}`;
  metaEl.hidden = false;
}

sourceSel.addEventListener('change', () => {
  fileInput.style.display = sourceSel.value === 'picker' ? '' : 'none';
  if (sourceSel.value === 'picker') fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  pendingBytes = await file.arrayBuffer();
  pendingFilename = file.name;
  setStatus(`loaded ${file.name} — click Play`);
});

async function ensureFactory(): Promise<CawtoothPlayer> {
  if (factory) return factory;
  factory = await CawtoothPlayer.init({
    formats: {
      // The full set of formats is wired in so the same factory can
      // load a stray .sid or .imf file the user happens to drop in,
      // even though the picker filters to .psg / .vtx / .ym / .asc.
      // Costs nothing to register since the worklet/wasm aren't actually
      // fetched until the corresponding format is loaded.
      ay: { workletUrl: ayWorkletUrl, wasmUrl: ayumiWasmUrl },
      opl: { workletUrl: oplWorkletUrl, wasmUrl: oplWasmUrl },
      psid: { workletUrl: psidWorkletUrl, wasmUrl: sidplayWasmUrl },
    },
  });
  return factory;
}

playBtn.addEventListener('click', async () => {
  try {
    playBtn.disabled = true;
    setStatus('loading worklet + wasm + tune…');

    if (player) {
      unsubscribeScope?.();
      unsubscribeScope = null;
      await player.dispose();
      player = null;
    }

    const fac = await ensureFactory();

    let bytes: ArrayBuffer;
    let filename: string | undefined;
    if (pendingBytes) {
      bytes = pendingBytes;
      filename = pendingFilename ?? undefined;
    } else if (sourceSel.value === 'picker') {
      throw new Error('no file selected — choose one with the picker');
    } else {
      bytes = buildSamplePsg().slice().buffer;
      filename = 'sample.psg';
    }

    player = await fac.load(bytes, { filename, loop: loopChk.checked });
    if (!(player instanceof AyPlayer)) {
      throw new Error(
        `loaded a ${player.format} file, but this demo only displays AY tunes — ` +
          `try the SID, IMF, or unified Player demo for other formats`,
      );
    }

    player.output.connect(player.audioContext.destination);
    await player.resumeAudio();

    if (player.info.format === 'ay') renderMeta(player.info);

    unsubscribeScope = player.onChannels(scope.ingest);
    scope.start();

    updateProgress({ currentTimeSec: 0, durationSec: null });
    player.onProgress(updateProgress);

    player.onEnded(() => {
      if (player && player.info.format === 'ay') {
        setStatus(`finished — "${player.info.title || '(unnamed)'}"`);
      }
    });

    player.play();
    pendingBytes = null;
    pendingFilename = null;
    if (player.info.format === 'ay') {
      setStatus(
        `playing — ${player.info.container.toUpperCase()} on ${player.info.model} @ ${player.info.tickRate} Hz`,
      );
    }
  } catch (err) {
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    playBtn.disabled = false;
  }
});

pauseBtn.addEventListener('click', () => {
  if (!player) return;
  if (player.isPlaying) {
    player.pause();
    setStatus('paused');
  } else {
    player.play();
    setStatus('playing');
  }
});

stopBtn.addEventListener('click', () => {
  if (!player) return;
  player.stop();
  updateProgress({ currentTimeSec: 0, durationSec: null });
  setStatus('stopped (rewound to start)');
});
