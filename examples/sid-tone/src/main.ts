import { SidPlayer, SID_CLOCK_PAL, type SidChipModel, type SidRegisterWrite } from 'cawtooth';
import workletUrl from 'cawtooth/worklet/sid?url';
import wasmUrl from 'cawtooth/wasm/resid.wasm?url';
import { createOscilloscope, type Oscilloscope } from './oscilloscope.js';

type Waveform = 'triangle' | 'sawtooth' | 'pulse' | 'noise';

/** Waveform bit in the SID control register ($04/$0B/$12). */
const WAVEFORM_BIT: Record<Waveform, number> = {
  triangle: 0x10,
  sawtooth: 0x20,
  pulse: 0x40,
  noise: 0x80,
};

/**
 * Compute a 16-bit SID frequency register value for `freqHz` at the given
 * chip clock. The formula (from the SID spec):
 *
 *   freq_reg = freq_hz * 2^24 / clock_hz
 *
 * At PAL clock (985248 Hz), A4 (440 Hz) ≈ 7493 ($1D45).
 */
function sidFreq(freqHz: number, clockHz: number): number {
  const raw = Math.round((freqHz * (1 << 24)) / clockHz);
  return Math.min(0xffff, Math.max(0, raw));
}

function programTone(waveform: Waveform, freqHz: number): SidRegisterWrite[] {
  const freq = sidFreq(freqHz, SID_CLOCK_PAL);
  const writes: SidRegisterWrite[] = [
    // Voice 1 frequency
    { reg: 0x00, value: freq & 0xff },
    { reg: 0x01, value: (freq >> 8) & 0xff },
    // Voice 1 pulse width = 50% duty ($800 of $FFF).
    { reg: 0x02, value: 0x00 },
    { reg: 0x03, value: 0x08 },
    // Voice 1 ADSR: fast attack, moderate decay, full sustain, short release.
    { reg: 0x05, value: 0x09 }, // attack 0, decay 9
    { reg: 0x06, value: 0xf0 }, // sustain 15, release 0
    // Master volume = 15 (max).
    { reg: 0x18, value: 0x0f },
    // Voice 1 control: waveform + gate.
    { reg: 0x04, value: WAVEFORM_BIT[waveform] | 0x01 },
  ];
  return writes;
}

const statusEl = document.getElementById('status') as HTMLElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const modelSel = document.getElementById('model') as HTMLSelectElement;
const waveformSel = document.getElementById('waveform') as HTMLSelectElement;
const scopeContainer = document.getElementById('scope') as HTMLElement;

const scope: Oscilloscope = createOscilloscope(scopeContainer, {
  voiceCount: 3,
  label: (v) => `Voice ${v + 1}`,
});

let player: SidPlayer | null = null;
let currentModel: SidChipModel | null = null;
let unsubscribeScope: (() => void) | null = null;

function setStatus(s: string): void {
  statusEl.textContent = s;
}

async function ensurePlayer(model: SidChipModel): Promise<SidPlayer> {
  if (player && currentModel === model) return player;
  if (player) {
    unsubscribeScope?.();
    unsubscribeScope = null;
    // Model swap needs a fresh worklet (the chip is constructed once at init).
    await player.dispose();
    player = null;
  }
  setStatus(`loading worklet + wasm (${model})…`);
  playBtn.disabled = true;
  const p = await SidPlayer.create({
    workletUrl,
    wasmUrl,
    model,
    samplingMethod: 'resample',
  });
  p.output.connect(p.audioContext.destination);
  unsubscribeScope = p.onChannels(scope.ingest);
  scope.start();
  player = p;
  currentModel = model;
  playBtn.disabled = false;
  setStatus(`ready — ${model} @ ${p.audioContext.sampleRate} Hz output`);
  return p;
}

playBtn.addEventListener('click', async () => {
  try {
    const model = modelSel.value as SidChipModel;
    const waveform = waveformSel.value as Waveform;
    const p = await ensurePlayer(model);
    await p.resumeAudio();
    p.reset();
    p.writeRegisters(programTone(waveform, 440));
    setStatus(`playing — ${waveform} A4 on voice 1 (${model})`);
  } catch (err) {
    playBtn.disabled = false;
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

stopBtn.addEventListener('click', () => {
  if (!player) return;
  // Release the gate on voice 1 — keeps the chip alive but silences the
  // note once the release envelope finishes. The current patch uses
  // release=0 so this is effectively immediate.
  player.writeRegister(0x04, WAVEFORM_BIT[waveformSel.value as Waveform]);
  setStatus('stopped (gate released)');
});
