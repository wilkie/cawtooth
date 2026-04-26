import { OplPlayer, type OplRegisterWrite } from 'cawtooth';
import workletUrl from 'cawtooth/worklet?url';
import wasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';

const TEST_TONE: readonly OplRegisterWrite[] = [
  { reg: 0x20, value: 0x01 },
  { reg: 0x23, value: 0x01 },
  { reg: 0x40, value: 0x10 },
  { reg: 0x43, value: 0x00 },
  { reg: 0x60, value: 0xf0 },
  { reg: 0x63, value: 0xf0 },
  { reg: 0x80, value: 0x77 },
  { reg: 0x83, value: 0x77 },
  { reg: 0xa0, value: 0x41 },
  { reg: 0xb0, value: 0x32 },
];

const statusEl = document.getElementById('status') as HTMLElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;

let player: OplPlayer | null = null;

function setStatus(s: string): void {
  statusEl.textContent = s;
}

async function ensurePlayer(): Promise<OplPlayer> {
  if (player) return player;
  setStatus('loading worklet + wasm…');
  playBtn.disabled = true;
  const p = await OplPlayer.create({ workletUrl, wasmUrl });
  p.output.connect(p.audioContext.destination);
  player = p;
  playBtn.disabled = false;
  setStatus(`ready (sample rate: ${p.audioContext.sampleRate} Hz)`);
  return p;
}

playBtn.addEventListener('click', async () => {
  try {
    const p = await ensurePlayer();
    await p.resumeAudio();
    p.reset();
    p.writeRegisters(TEST_TONE);
    setStatus('playing — sustained tone on channel 0');
  } catch (err) {
    playBtn.disabled = false;
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

stopBtn.addEventListener('click', () => {
  player?.reset();
  setStatus('stopped (chip reset)');
});
