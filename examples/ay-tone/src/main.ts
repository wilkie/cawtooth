import { AyPlayer, type AyChipModel, type AyRegisterWrite } from 'cawtooth';
import workletUrl from 'cawtooth/worklet/ay?url';
import wasmUrl from 'cawtooth/wasm/ayumi.wasm?url';
import { createOscilloscope, type Oscilloscope } from './oscilloscope.js';

type ChordName = 'A-major' | 'A-minor' | 'C-major' | 'C-major-7';

/**
 * Chord voicings for the three AY channels (A/B/C). Frequencies in Hz.
 * Equal temperament, A4 = 440. The maj7 entry omits the 7th — the AY
 * only has 3 tone channels, so the four-note chord drops the top note.
 */
const CHORDS: Record<ChordName, readonly [number, number, number]> = {
  'A-major': [440, 554.37, 659.25], // A4, C#5, E5
  'A-minor': [440, 523.25, 659.25], // A4, C5,  E5
  'C-major': [261.63, 329.63, 392], // C4, E4,  G4
  'C-major-7': [261.63, 329.63, 392], // C4, E4, G4 (B4 dropped — only 3 voices)
};

/**
 * Compute a 12-bit AY tone period for `freqHz` at the given chip clock.
 * Per the AY-3-8910 datasheet:
 *
 *   tone_period = clock_hz / (16 * freq_hz)
 *
 * Tone period is 12 bits (R0/R1 low/high nibbles), so cap at 0xFFF.
 */
function ayTonePeriod(freqHz: number, clockHz: number): number {
  const raw = Math.round(clockHz / (16 * freqHz));
  return Math.min(0xfff, Math.max(1, raw));
}

/**
 * Build the register-write sequence for a 3-voice chord at `clockHz`.
 *
 * Mixer (R7) layout:
 *   bits 0–2: tone disable (1 = disabled) for channels A/B/C
 *   bits 3–5: noise disable (1 = disabled) for channels A/B/C
 *   bits 6–7: I/O port direction (we don't touch I/O so leave clear)
 *
 * Default mixer enables tone on all three channels and disables noise.
 * If `noiseOnA` is true, also enable noise on channel A — produces a
 * gritty hybrid timbre common in arcade sound effects.
 */
function programChord(
  freqs: readonly [number, number, number],
  clockHz: number,
  envelopeOn: boolean,
  noiseOnA: boolean,
): AyRegisterWrite[] {
  const periods = freqs.map((f) => ayTonePeriod(f, clockHz));
  // Mixer: enable tones (clear bits 0–2). Noise enables (bits 3–5) all
  // disabled by default; clear bit 3 (channel A noise) if requested.
  const mixer = noiseOnA ? 0x38 : 0x38; // start with all noise disabled
  const mixerFinal = noiseOnA
    ? mixer & ~0x08 // clear bit 3 — enable noise on A
    : mixer;
  // Volume registers: low 4 bits = volume, bit 4 = "use envelope".
  const ampByte = envelopeOn ? 0x10 : 0x0f;

  return [
    { reg: 0, value: periods[0] & 0xff }, // ch A tone period low
    { reg: 1, value: (periods[0] >> 8) & 0x0f }, // ch A tone period high
    { reg: 2, value: periods[1] & 0xff }, // ch B tone period low
    { reg: 3, value: (periods[1] >> 8) & 0x0f }, // ch B tone period high
    { reg: 4, value: periods[2] & 0xff }, // ch C tone period low
    { reg: 5, value: (periods[2] >> 8) & 0x0f }, // ch C tone period high
    { reg: 6, value: 0x10 }, // noise period (audible buzz, used only if mixer enables noise)
    { reg: 7, value: 0xc0 | (mixerFinal & 0x3f) }, // mixer + I/O ports as input
    { reg: 8, value: ampByte }, // ch A amplitude
    { reg: 9, value: ampByte }, // ch B amplitude
    { reg: 10, value: ampByte }, // ch C amplitude
    // Envelope period: ~1 Hz at 1.77 MHz / 256 / period(0x4000) — gives
    // a slow ramp the listener can hear sweep across the chord.
    { reg: 11, value: 0x00 },
    { reg: 12, value: 0x40 },
    { reg: 13, value: 0x0e }, // shape 0x0E = ramp-up + repeat (continuous downward saw envelope)
  ];
}

const statusEl = document.getElementById('status') as HTMLElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const modelSel = document.getElementById('model') as HTMLSelectElement;
const clockSel = document.getElementById('clock') as HTMLSelectElement;
const chordSel = document.getElementById('chord') as HTMLSelectElement;
const envelopeChk = document.getElementById('envelope') as HTMLInputElement;
const noiseChk = document.getElementById('noise') as HTMLInputElement;
const scopeContainer = document.getElementById('scope') as HTMLElement;

const scope: Oscilloscope = createOscilloscope(scopeContainer, {
  voiceCount: 3,
  label: (v) => `Voice ${'ABC'.charAt(v)}`,
});

let player: AyPlayer | null = null;
let currentModel: AyChipModel | null = null;
let currentClock: number | null = null;
let unsubscribeScope: (() => void) | null = null;

function setStatus(s: string): void {
  statusEl.textContent = s;
}

async function ensurePlayer(model: AyChipModel, clock: number): Promise<AyPlayer> {
  // Model and clock are baked into the chip at construction (Ayumi
  // builds resampler tables from clock at create time), so any change
  // to either requires disposing and re-creating the player.
  if (player && currentModel === model && currentClock === clock) return player;
  if (player) {
    unsubscribeScope?.();
    unsubscribeScope = null;
    await player.dispose();
    player = null;
  }
  setStatus(`loading worklet + wasm (${model} @ ${clock} Hz)…`);
  playBtn.disabled = true;
  const p = await AyPlayer.create({
    workletUrl,
    wasmUrl,
    model,
    clockFrequency: clock,
  });
  p.output.connect(p.audioContext.destination);
  unsubscribeScope = p.onChannels(scope.ingest);
  scope.start();
  player = p;
  currentModel = model;
  currentClock = clock;
  playBtn.disabled = false;
  setStatus(
    `ready — ${model} @ ${clock.toLocaleString()} Hz / output ${p.audioContext.sampleRate} Hz`,
  );
  return p;
}

playBtn.addEventListener('click', async () => {
  try {
    const model = modelSel.value as AyChipModel;
    const clock = Number(clockSel.value);
    const chord = chordSel.value as ChordName;
    const p = await ensurePlayer(model, clock);
    await p.resumeAudio();
    p.reset();
    p.writeRegisters(programChord(CHORDS[chord], clock, envelopeChk.checked, noiseChk.checked));
    setStatus(
      `playing — ${chord} on ${model}` +
        (envelopeChk.checked ? ' (envelope shape 0x0E)' : '') +
        (noiseChk.checked ? ' + noise on A' : ''),
    );
  } catch (err) {
    playBtn.disabled = false;
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

stopBtn.addEventListener('click', () => {
  if (!player) return;
  // Reset clears the register file — silences the chip immediately and
  // also clears Ayumi's DC filter / FIR state so the next play starts
  // from a clean slate.
  player.reset();
  setStatus('stopped (chip reset)');
});
