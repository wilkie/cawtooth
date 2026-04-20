/**
 * HERAD → RegisterEventStream renderer.
 *
 * Walks the per-track event streams of a `HeradSong` against a shared virtual
 * clock, maintains per-voice state (current instrument, note, keyon, pitch
 * bend), and emits the sequence of OPL register writes that the AdLib
 * hardware would receive. The result is a `RegisterEventStream` that plays
 * through the exact same pipeline as IMF/DRO — no HERAD-specific sequencer
 * needed at the worklet level.
 *
 * Scope vs. the AdPlug reference (Phase C1):
 *   - Implemented: program change (full operator param set), note-on / note-
 *     off, pitch bend (fine-tune mode), velocity macros (mod/car output),
 *     AGD → OPL3 upper bank routing, first-event timing workaround.
 *   - Deferred to Phase C2: slide, aftertouch, feedback-velocity and
 *     feedback-aftertouch macros, transpose, coarse-tune bend, keymap
 *     indirection, AGD panning.
 *
 * Timing: HERAD's `update()` runs at ~200.299 Hz. Each update tries
 * `wTime -= 256; if (wTime < 0) { wTime += wSpeed; processEvents(); }`, so
 * `processEvents` fires at `200.299 * 256 / wSpeed` Hz. That rate is the
 * one we hand to the stream; VLQ delays from the track data count in those
 * ticks.
 */

import { parseHeradTrack } from './events.js';
import type { HeradPatch, HeradSong } from './types.js';
import type { RegisterEventStream, TimedRegisterStream } from '../../sequencer/types.js';

/** AdPlug's internal refresh rate for HERAD playback. */
const HERAD_REFRESH_HZ = 200.299;

/** Maximum independent voices per chip (one per OPL2 channel). */
const HERAD_NUM_VOICES = 9;

/** Operator-slot base offsets keyed by voice index (modulator slot; carrier is +3). */
const SLOT_OFFSET: readonly number[] = [0, 1, 2, 8, 9, 10, 16, 17, 18];

/** Base F-numbers per semitone within an octave. Index 0 = C, 11 = B. */
const FNUM: readonly number[] = [343, 364, 385, 408, 433, 459, 486, 515, 546, 579, 614, 650];

/** Per-semitone fine-tune step used for pitch-bend detune (scaled by bend magnitude). */
const FINE_BEND: readonly number[] = [19, 21, 21, 23, 25, 26, 27, 29, 31, 33, 35, 36, 37];

const HERAD_BEND_CENTER = 0x40;

interface VoiceState {
  program: number;
  playProgram: number;
  note: number;
  keyon: boolean;
  bend: number;
}

interface RegWrite {
  tick: number;
  track: number;
  reg: number;
  val: number;
}

interface TrackEventAtTick {
  tick: number;
  voice: number;
  event: ReturnType<typeof parseHeradTrack>[number]['event'];
}

/** Render a HERAD song to a format-agnostic RegisterEventStream. */
export function renderHeradToStream(song: HeradSong): TimedRegisterStream {
  const tickRate = (HERAD_REFRESH_HZ * 256) / song.speed;
  const maxVoices = song.isAgd ? HERAD_NUM_VOICES * 2 : HERAD_NUM_VOICES;

  const timedEvents: TrackEventAtTick[] = [];
  for (let v = 0; v < Math.min(song.tracks.length, maxVoices); v++) {
    const parsed = parseHeradTrack(song.tracks[v], { variant: song.variant });
    let cumulative = 0;
    let first = true;
    for (const { delayTicks, event } of parsed) {
      // First-event workaround: AdPlug adds 1 tick to the very first non-zero
      // delay of each track to keep multi-track starts aligned.
      let effectiveDelay = delayTicks;
      if (first && delayTicks > 0) effectiveDelay++;
      first = false;
      cumulative += effectiveDelay;
      timedEvents.push({ tick: cumulative, voice: v, event });
    }
  }

  timedEvents.sort((a, b) => a.tick - b.tick || a.voice - b.voice);

  const writes: RegWrite[] = [];
  const voiceStates: VoiceState[] = Array.from({ length: maxVoices }, () => ({
    program: 0,
    playProgram: 0,
    note: 0,
    keyon: false,
    bend: HERAD_BEND_CENTER,
  }));

  // Enable OPL3 mode at the top of AGD songs. Nuked-OPL3 starts in OPL2-compat
  // mode, so upper-bank writes for voices 9-17 are inert until we flip this.
  if (song.isAgd) {
    writes.push({ tick: 0, track: 0, reg: 0x105, val: 1 });
  }

  for (const { tick, voice, event } of timedEvents) {
    const state = voiceStates[voice];
    switch (event.type) {
      case 'programChange': {
        if (event.program < song.instruments.length) {
          state.program = event.program;
          state.playProgram = event.program;
          const inst = song.instruments[event.program];
          if (inst.kind === 'patch') {
            applyProgramChange(writes, tick, voice, inst, song.isAgd);
          }
        }
        break;
      }
      case 'noteOn': {
        if (state.keyon) {
          // Turn off the previous note first.
          emitNote(writes, tick, voice, state.note, state.bend, false);
        }
        state.note = event.note;
        state.keyon = true;
        state.bend = HERAD_BEND_CENTER;
        emitNote(writes, tick, voice, event.note, state.bend, true);
        const inst = song.instruments[state.playProgram];
        if (inst?.kind === 'patch') {
          applyVelocityMacros(writes, tick, voice, inst, event.velocity);
        }
        break;
      }
      case 'noteOff': {
        if (state.keyon && event.note === state.note) {
          state.keyon = false;
          emitNote(writes, tick, voice, event.note, state.bend, false);
        }
        break;
      }
      case 'pitchBend': {
        state.bend = event.value;
        if (state.keyon) {
          emitNote(writes, tick, voice, state.note, event.value, true);
        }
        break;
      }
      case 'aftertouch':
      case 'unused':
        break;
    }
  }

  writes.sort((a, b) => a.tick - b.tick || a.track - b.track);

  const n = writes.length;
  const regs = new Uint16Array(n);
  const values = new Uint8Array(n);
  const delayTicks = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    regs[i] = writes[i].reg;
    values[i] = writes[i].val;
    delayTicks[i] = i + 1 < n ? writes[i + 1].tick - writes[i].tick : 0;
  }

  const stream: RegisterEventStream = { regs, values, delayTicks };
  return { stream, tickRate };
}

/* ──────────────────────────── Helpers ──────────────────────────── */

/** Map a voice index to the bank offset (0 for voices 0-8, 0x100 for 9-17). */
function bankOffset(voice: number): number {
  return voice >= HERAD_NUM_VOICES ? 0x100 : 0;
}

/**
 * Apply a program change by writing the instrument's full operator parameter
 * set to the chip. Mirrors AdPlug's `changeProgram`.
 *
 * Instrument byte layout (index into the 40-byte block):
 *   0  mode          10 mod_out         20 car_eg         30 mc_mod_out_vel*
 *   1  voice         11 mod_am          21 car_D          31 mc_car_out_vel*
 *   2  mod_ksl       12 mod_vib         22 car_R          32 mc_fb_vel*
 *   3  mod_mul       13 mod_ksr         23 car_out        33 mc_slide_coarse
 *   4  feedback      14 con             24 car_am         34 mc_transpose
 *   5  mod_A         15 car_ksl         25 car_vib        35 mc_slide_dur
 *   6  mod_S         16 car_mul         26 car_ksr        36 mc_slide_range*
 *   7  mod_eg        17 pan             27 mc_fb_at*      37 dummy
 *   8  mod_D         18 car_A           28 mod_wave       38 mc_mod_out_at*
 *   9  mod_R         19 car_S           29 car_wave       39 mc_car_out_at*
 *
 * (*) = signed int8 fields.
 */
function applyProgramChange(
  writes: RegWrite[],
  tick: number,
  voice: number,
  patch: HeradPatch,
  isAgd: boolean,
): void {
  const raw = patch.raw;
  const slot = SLOT_OFFSET[voice % HERAD_NUM_VOICES];
  const bank = bankOffset(voice);

  const modKsl = raw[2];
  const modMul = raw[3];
  const feedback = raw[4];
  const modA = raw[5];
  const modS = raw[6];
  const modEg = raw[7];
  const modD = raw[8];
  const modR = raw[9];
  const modOut = raw[10];
  const modAm = raw[11];
  const modVib = raw[12];
  const modKsr = raw[13];
  const con = raw[14];
  const carKsl = raw[15];
  const carMul = raw[16];
  const pan = raw[17];
  const carA = raw[18];
  const carS = raw[19];
  const carEg = raw[20];
  const carD = raw[21];
  const carR = raw[22];
  const carOut = raw[23];
  const carAm = raw[24];
  const carVib = raw[25];
  const carKsr = raw[26];
  const modWave = raw[28];
  const carWave = raw[29];

  // Modulator / carrier operator parameters.
  push(
    writes,
    tick,
    voice,
    bank | (0x20 + slot),
    opParamByte(modMul, modKsr, modEg, modVib, modAm),
  );
  push(
    writes,
    tick,
    voice,
    bank | (0x23 + slot),
    opParamByte(carMul, carKsr, carEg, carVib, carAm),
  );
  push(writes, tick, voice, bank | (0x40 + slot), outputByte(modOut, modKsl));
  push(writes, tick, voice, bank | (0x43 + slot), outputByte(carOut, carKsl));
  push(writes, tick, voice, bank | (0x60 + slot), envAttackDecayByte(modA, modD));
  push(writes, tick, voice, bank | (0x63 + slot), envAttackDecayByte(carA, carD));
  push(writes, tick, voice, bank | (0x80 + slot), envSustainReleaseByte(modS, modR));
  push(writes, tick, voice, bank | (0x83 + slot), envSustainReleaseByte(carS, carR));

  // Feedback / connection (and AGD pan), keyed per voice.
  const con01 = con > 0 ? 0 : 1;
  const fb3 = feedback & 0x07;
  let panBits = 0;
  if (isAgd) {
    // Reference clamps pan to {0, 1, 2, 3} mapping to CHA/CHB mask bits.
    panBits = pan === 0 || pan > 3 ? 3 : pan;
  }
  push(
    writes,
    tick,
    voice,
    bank | (0xc0 + (voice % HERAD_NUM_VOICES)),
    con01 | (fb3 << 1) | (panBits << 4),
  );

  // Waveform select. AGD has 3-bit waveforms (0-7); OPL2 has 2-bit (0-3).
  const waveMask = isAgd ? 0x07 : 0x03;
  push(writes, tick, voice, bank | (0xe0 + slot), modWave & waveMask);
  push(writes, tick, voice, bank | (0xe3 + slot), carWave & waveMask);
}

/** Velocity macros: scale modulator and carrier output levels by note velocity. */
function applyVelocityMacros(
  writes: RegWrite[],
  tick: number,
  voice: number,
  patch: HeradPatch,
  velocity: number,
): void {
  const raw = patch.raw;
  // Signed int8 sensitivity: interpret bytes ≥128 as negative.
  const modSens = toSignedByte(raw[30]);
  const carSens = toSignedByte(raw[31]);

  const slot = SLOT_OFFSET[voice % HERAD_NUM_VOICES];
  const bank = bankOffset(voice);

  if (modSens !== 0) {
    const adjusted = clamp6(raw[10] + modSens * ((velocity - 64) >> 1));
    push(writes, tick, voice, bank | (0x40 + slot), outputByte(adjusted, raw[2]));
  }
  if (carSens !== 0) {
    const adjusted = clamp6(raw[23] + carSens * ((velocity - 64) >> 1));
    push(writes, tick, voice, bank | (0x43 + slot), outputByte(adjusted, raw[15]));
  }
}

/**
 * Compute the note's F-Number + octave + key-on register pair and emit both
 * writes. Handles the fine-tune pitch bend path only — coarse-tune bend is a
 * Phase C2 item (need to know the instrument to pick the mode).
 */
function emitNote(
  writes: RegWrite[],
  tick: number,
  voice: number,
  note: number,
  bend: number,
  keyOn: boolean,
): void {
  const heradNote = (note - 24) & 0xff;
  const clipped = heradNote >= 0x60 ? 0 : heradNote;
  let oct = Math.floor(clipped / 12);
  let key = clipped % 12;
  let detune = 0;

  // Fine-tune bend. `amount_lo` shifts by whole semitones; `amount_hi`
  // contributes a fractional detune looked up via fine_bend.
  if (bend !== HERAD_BEND_CENTER) {
    if (bend < HERAD_BEND_CENTER) {
      const amount = HERAD_BEND_CENTER - bend;
      const amountLo = amount >> 5;
      const amountHi = (amount << 3) & 0xff;
      key -= amountLo;
      if (key < 0) {
        key += 12;
        oct--;
      }
      if (oct < 0) {
        key = 0;
        oct = 0;
      }
      detune = -((FINE_BEND[key] * amountHi) >> 8);
    } else {
      const amount = bend - HERAD_BEND_CENTER;
      const amountLo = amount >> 5;
      const amountHi = (amount << 3) & 0xff;
      key += amountLo;
      if (key >= 12) {
        key -= 12;
        oct++;
      }
      detune = (FINE_BEND[key + 1] * amountHi) >> 8;
    }
  }

  const freq = FNUM[key] + detune;
  const bank = bankOffset(voice);
  const channel = voice % HERAD_NUM_VOICES;

  push(writes, tick, voice, bank | (0xa0 + channel), freq & 0xff);
  push(
    writes,
    tick,
    voice,
    bank | (0xb0 + channel),
    ((freq >> 8) & 0x03) | ((oct & 0x07) << 2) | (keyOn ? 0x20 : 0),
  );
}

function push(writes: RegWrite[], tick: number, track: number, reg: number, val: number): void {
  writes.push({ tick, track, reg, val: val & 0xff });
}

function opParamByte(mul: number, ksr: number, eg: number, vib: number, am: number): number {
  return (
    (mul & 0x0f) | ((ksr & 1) << 4) | ((eg > 0 ? 1 : 0) << 5) | ((vib & 1) << 6) | ((am & 1) << 7)
  );
}

function outputByte(out: number, ksl: number): number {
  return (out & 0x3f) | ((ksl & 0x03) << 6);
}

function envAttackDecayByte(attack: number, decay: number): number {
  return (decay & 0x0f) | ((attack & 0x0f) << 4);
}

function envSustainReleaseByte(sustain: number, release: number): number {
  return (release & 0x0f) | ((sustain & 0x0f) << 4);
}

function toSignedByte(b: number): number {
  return b >= 0x80 ? b - 0x100 : b;
}

function clamp6(v: number): number {
  if (v < 0) return 0;
  if (v > 63) return 63;
  return v;
}
