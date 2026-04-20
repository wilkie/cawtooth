/**
 * HERAD → RegisterEventStream renderer.
 *
 * Walks the per-track event streams of a `HeradSong` against a shared virtual
 * clock, maintains per-voice state, and emits the sequence of OPL register
 * writes that the AdLib hardware would receive. The result is a
 * `RegisterEventStream` that plays through the exact same pipeline as
 * IMF/DRO — no HERAD-specific sequencer needed at the worklet level.
 *
 * Simulation model: tick-by-tick. For each tick we first process any active
 * slides (AdPlug's `macroSlide`), then per-track events whose absolute-tick
 * position equals the current tick. This ordering lets an in-progress slide
 * get overwritten by an incoming song-level pitch bend within the same tick,
 * which matches the reference.
 *
 * Timing: HERAD's `update()` runs at ~200.299 Hz. Each update does
 * `wTime -= 256; if (wTime < 0) { wTime += wSpeed; processEvents(); }`, so
 * `processEvents` fires at `200.299 * 256 / wSpeed` Hz. That rate is the
 * tick rate we hand to the stream; VLQ delays from the track data count in
 * those ticks.
 *
 * Scope vs. AdPlug reference: all core playback features are implemented —
 * program change, note on/off, pitch bend (fine and coarse), velocity
 * macros (mod/car/feedback), aftertouch macros (v1), slide macro,
 * transpose macro, AGD → OPL3 upper-bank routing, AGD panning, v2 keymap
 * indirection, first-event timing workaround. Remaining known gaps: per-
 * operator detune fields some later HERAD variants use, and rhythm-mode
 * percussion (neither appears in our reference samples).
 */

import { parseHeradTrack, type HeradEvent } from './events.js';
import type { HeradPatch, HeradSong } from './types.js';
import type { RegisterEventStream, TimedRegisterStream } from '../../sequencer/types.js';

/** AdPlug's internal refresh rate for HERAD playback. */
const HERAD_REFRESH_HZ = 200.299;

/** Voices per chip (nine OPL2 channels, or two banks of nine on AGD). */
const HERAD_NUM_VOICES = 9;

/** Operator-slot base offsets keyed by voice index (modulator slot; carrier is +3). */
const SLOT_OFFSET: readonly number[] = [0, 1, 2, 8, 9, 10, 16, 17, 18];

/** Base F-numbers per semitone within an octave (index 0 = C, 11 = B). */
const FNUM: readonly number[] = [343, 364, 385, 408, 433, 459, 486, 515, 546, 579, 614, 650];

/** Fine-tune per-semitone step, scaled by bend magnitude (length 13 for index `key + 1`). */
const FINE_BEND: readonly number[] = [19, 21, 21, 23, 25, 26, 27, 29, 31, 33, 35, 36, 37];

/**
 * Coarse-tune detune table, indexed by `(amount % 5) + (key >= 6 ? 5 : 0)`.
 * Keys C..F use indices 0..4; keys F#..B use 5..9. Reference puts 0 at both
 * index 0 and 5, preserving "no detune" at the exact semitone boundary.
 */
const COARSE_BEND: readonly number[] = [0, 5, 10, 15, 20, 0, 6, 12, 18, 24];

/** Neutral pitch-bend value — no detune applied. */
const HERAD_BEND_CENTER = 0x40;

/** Instrument bytes that are int8 (signed). Alphabetical for easy scanning. */
const IDX = {
  MOD_KSL: 2,
  MOD_MUL: 3,
  FEEDBACK: 4,
  MOD_A: 5,
  MOD_S: 6,
  MOD_EG: 7,
  MOD_D: 8,
  MOD_R: 9,
  MOD_OUT: 10,
  MOD_AM: 11,
  MOD_VIB: 12,
  MOD_KSR: 13,
  CON: 14,
  CAR_KSL: 15,
  CAR_MUL: 16,
  PAN: 17,
  CAR_A: 18,
  CAR_S: 19,
  CAR_EG: 20,
  CAR_D: 21,
  CAR_R: 22,
  CAR_OUT: 23,
  CAR_AM: 24,
  CAR_VIB: 25,
  CAR_KSR: 26,
  MC_FB_AT: 27,
  MOD_WAVE: 28,
  CAR_WAVE: 29,
  MC_MOD_OUT_VEL: 30,
  MC_CAR_OUT_VEL: 31,
  MC_FB_VEL: 32,
  MC_SLIDE_COARSE: 33,
  MC_TRANSPOSE: 34,
  MC_SLIDE_DUR: 35,
  MC_SLIDE_RANGE: 36,
  MC_MOD_OUT_AT: 38,
  MC_CAR_OUT_AT: 39,
} as const;

interface VoiceState {
  program: number; // last program-change-selected instrument
  playProgram: number; // actually sounding instrument (resolves through keymap on v2)
  note: number;
  keyon: boolean;
  bend: number;
  slideDur: number; // ticks of slide remaining; 0 = no slide
}

interface RegWrite {
  tick: number;
  /** Used as a stable tiebreaker when multiple writes land on the same tick. */
  seq: number;
  reg: number;
  val: number;
}

interface TimedTrackEvent {
  tick: number;
  event: HeradEvent;
}

/** Render a HERAD song to a format-agnostic RegisterEventStream. */
export function renderHeradToStream(song: HeradSong): TimedRegisterStream {
  const tickRate = (HERAD_REFRESH_HZ * 256) / song.speed;
  const maxVoices = song.isAgd ? HERAD_NUM_VOICES * 2 : HERAD_NUM_VOICES;

  // Parse each track into an absolute-tick event list. Track indices map 1:1
  // to voice indices; tracks past the voice budget are ignored.
  //
  // A note on the first-event delay: AdPlug's processEvents has a workaround
  // that increments the counter threshold by 1 when the first event of a
  // track has a non-zero delay:
  //
  //     if (first && track[i].ticks) track[i].ticks++;
  //
  // This compensates for AdPlug's runtime using `++counter` then
  // compare-and-fire semantics — without the bump, a first event with delay
  // D would fire at external tick D-1 (one too early) because the very
  // first call's counter increment counts as one tick of progress. Our
  // accumulator model doesn't have that counting quirk: `cumulative +=
  // delayTicks` naturally gives the right tick for every event, first or
  // not. Applying AdPlug's +1 on top of our accumulator would push first
  // events one tick LATE, which is exactly the divergence the A/B harness
  // surfaced at tick 576 of WORMINTR (track 1's first delay = 576).
  const tracks: TimedTrackEvent[][] = [];
  let maxEventTick = 0;
  for (let v = 0; v < Math.min(song.tracks.length, maxVoices); v++) {
    const parsed = parseHeradTrack(song.tracks[v], { variant: song.variant });
    const trackEvents: TimedTrackEvent[] = [];
    let cumulative = 0;
    for (const { delayTicks, event } of parsed) {
      cumulative += delayTicks;
      trackEvents.push({ tick: cumulative, event });
    }
    if (cumulative > maxEventTick) maxEventTick = cumulative;
    tracks.push(trackEvents);
  }

  // Allow up to 256 extra ticks at the tail so any slides that begin near
  // the last note can finish playing out. `mc_slide_dur` is one byte, so
  // 256 is the theoretical maximum.
  const endTick = maxEventTick + 256;

  const writes: RegWrite[] = [];
  let seq = 0;

  const voiceStates: VoiceState[] = Array.from({ length: maxVoices }, () => ({
    program: 0,
    playProgram: 0,
    note: 0,
    keyon: false,
    bend: HERAD_BEND_CENTER,
    slideDur: 0,
  }));

  // Track-event cursors — advance as events at each tick are consumed.
  const trackIdx = new Array<number>(tracks.length).fill(0);

  const emit = (tick: number, reg: number, val: number): void => {
    writes.push({ tick, seq: seq++, reg, val: val & 0xff });
  };

  // Chip initialisation per AdPlug's rewind(). Without reg 0x01 bit 5 set,
  // OPL2 ignores the waveform-select bits in 0xE0-0xF5 and every voice
  // plays a sine — a big timbral difference that makes songs sound duller
  // than the reference.
  emit(0, 0x01, 0x20); // Enable waveform select
  emit(0, 0xbd, 0x00); // Disable percussion / rhythm mode
  emit(0, 0x08, 0x40); // Enable Note-Sel
  if (song.isAgd) {
    emit(0, 0x105, 0x01); // Enable OPL3
    emit(0, 0x104, 0x00); // Disable 4-op connections
  }

  for (let tick = 0; tick <= endTick; tick++) {
    // --- 1. Slide processing (before events, per AdPlug order).
    for (let v = 0; v < maxVoices; v++) {
      const state = voiceStates[v];
      if (state.slideDur > 0 && state.keyon) {
        const inst = song.instruments[state.playProgram];
        if (inst?.kind === 'patch') {
          state.slideDur--;
          const slideRange = toSignedByte(inst.raw[IDX.MC_SLIDE_RANGE]);
          state.bend = (state.bend + slideRange) & 0xff;
          emitNote(emit, tick, v, state.note, state.bend, true, inst, song.variant);
        } else {
          state.slideDur = 0;
        }
      }
    }

    // --- 2. Events on each track that fire at this tick.
    let anyPending = false;
    for (let v = 0; v < tracks.length; v++) {
      const trackEvents = tracks[v];
      while (trackIdx[v] < trackEvents.length && trackEvents[trackIdx[v]].tick === tick) {
        const { event } = trackEvents[trackIdx[v]];
        processEvent(event, v, tick, voiceStates, song, emit);
        trackIdx[v]++;
      }
      if (trackIdx[v] < trackEvents.length) anyPending = true;
    }

    // --- 3. Early termination: past the last event AND no voice is still sliding.
    if (!anyPending && tick >= maxEventTick) {
      const stillSliding = voiceStates.some((s) => s.slideDur > 0 && s.keyon);
      if (!stillSliding) break;
    }
  }

  // Stable sort by tick, then by insertion order (seq).
  writes.sort((a, b) => a.tick - b.tick || a.seq - b.seq);

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

/* ─────────────────────────── Event handlers ─────────────────────────── */

type Emit = (tick: number, reg: number, val: number) => void;

function processEvent(
  event: HeradEvent,
  voice: number,
  tick: number,
  voiceStates: VoiceState[],
  song: HeradSong,
  emit: Emit,
): void {
  const state = voiceStates[voice];
  switch (event.type) {
    case 'programChange': {
      if (event.program >= song.instruments.length) return;
      state.program = event.program;
      state.playProgram = event.program;
      const inst = song.instruments[event.program];
      if (inst.kind === 'patch') {
        applyProgramChange(emit, tick, voice, inst, song.isAgd);
      }
      // Keymap instruments defer their real program change until note-on.
      return;
    }
    case 'noteOn': {
      // Turn off the previous note first (without clearing state.note until
      // we've decided whether the new note is going to play).
      if (state.keyon) {
        const prevInst = song.instruments[state.playProgram];
        const prevPatch = prevInst?.kind === 'patch' ? prevInst : null;
        if (prevPatch) {
          emitNote(emit, tick, voice, state.note, state.bend, false, prevPatch, song.variant);
        }
      }

      // v2 keymap indirection: if the current program is a keymap, look up
      // the real program by the note offset. An out-of-range note is simply
      // silenced — this is the "drum map" behaviour in v2 songs.
      if (song.variant === 'v2') {
        const stored = song.instruments[state.program];
        if (stored?.kind === 'keymap') {
          const mp = event.note - (stored.noteOffset + 24);
          if (mp < 0 || mp >= stored.indices.length) {
            state.keyon = false;
            return;
          }
          state.playProgram = stored.indices[mp];
          const resolved = song.instruments[state.playProgram];
          if (resolved?.kind === 'patch') {
            applyProgramChange(emit, tick, voice, resolved, song.isAgd);
          }
        }
      }

      state.note = event.note;
      state.keyon = true;
      state.bend = HERAD_BEND_CENTER;

      const inst = song.instruments[state.playProgram];
      if (!inst || inst.kind !== 'patch') {
        // Recursion guard: a keymap that indirected to another keymap. No
        // sound, but keep state consistent.
        return;
      }

      // Slide initiation: mc_slide_dur > 0 means this note slides its pitch
      // over the next N ticks.
      state.slideDur = inst.raw[IDX.MC_SLIDE_DUR];

      emitNote(emit, tick, voice, event.note, state.bend, true, inst, song.variant);
      applyVelocityMacros(emit, tick, voice, inst, event.velocity, song.isAgd);
      return;
    }
    case 'noteOff': {
      if (!(state.keyon && event.note === state.note)) return;
      state.keyon = false;
      state.slideDur = 0;
      const inst = song.instruments[state.playProgram];
      if (inst?.kind === 'patch') {
        emitNote(emit, tick, voice, event.note, state.bend, false, inst, song.variant);
      }
      return;
    }
    case 'pitchBend': {
      state.bend = event.value;
      if (state.keyon) {
        const inst = song.instruments[state.playProgram];
        if (inst?.kind === 'patch') {
          emitNote(emit, tick, voice, state.note, event.value, true, inst, song.variant);
        }
      }
      return;
    }
    case 'aftertouch': {
      // v2 ignores aftertouch entirely.
      if (song.variant === 'v2') return;
      const inst = song.instruments[state.playProgram];
      if (inst?.kind !== 'patch') return;
      applyAftertouchMacros(emit, tick, voice, inst, event.value, song.isAgd);
      return;
    }
    case 'unused':
      return;
  }
}

/* ─────────────────────────── Register emission ─────────────────────────── */

function bankOffset(voice: number): number {
  return voice >= HERAD_NUM_VOICES ? 0x100 : 0;
}

/**
 * Apply a program change — write the full operator parameter set.
 * See the instrument byte-layout reference at the top of this file.
 */
function applyProgramChange(
  emit: Emit,
  tick: number,
  voice: number,
  patch: HeradPatch,
  isAgd: boolean,
): void {
  const raw = patch.raw;
  const slot = SLOT_OFFSET[voice % HERAD_NUM_VOICES];
  const bank = bankOffset(voice);
  const ch = voice % HERAD_NUM_VOICES;

  emit(
    tick,
    bank | (0x20 + slot),
    opParamByte(
      raw[IDX.MOD_MUL],
      raw[IDX.MOD_KSR],
      raw[IDX.MOD_EG],
      raw[IDX.MOD_VIB],
      raw[IDX.MOD_AM],
    ),
  );
  emit(
    tick,
    bank | (0x23 + slot),
    opParamByte(
      raw[IDX.CAR_MUL],
      raw[IDX.CAR_KSR],
      raw[IDX.CAR_EG],
      raw[IDX.CAR_VIB],
      raw[IDX.CAR_AM],
    ),
  );
  emit(tick, bank | (0x40 + slot), outputByte(raw[IDX.MOD_OUT], raw[IDX.MOD_KSL]));
  emit(tick, bank | (0x43 + slot), outputByte(raw[IDX.CAR_OUT], raw[IDX.CAR_KSL]));
  emit(tick, bank | (0x60 + slot), envAttackDecayByte(raw[IDX.MOD_A], raw[IDX.MOD_D]));
  emit(tick, bank | (0x63 + slot), envAttackDecayByte(raw[IDX.CAR_A], raw[IDX.CAR_D]));
  emit(tick, bank | (0x80 + slot), envSustainReleaseByte(raw[IDX.MOD_S], raw[IDX.MOD_R]));
  emit(tick, bank | (0x83 + slot), envSustainReleaseByte(raw[IDX.CAR_S], raw[IDX.CAR_R]));
  emit(
    tick,
    bank | (0xc0 + ch),
    feedbackConnectionByte(raw[IDX.CON], raw[IDX.FEEDBACK], raw[IDX.PAN], isAgd),
  );

  const waveMask = isAgd ? 0x07 : 0x03;
  emit(tick, bank | (0xe0 + slot), raw[IDX.MOD_WAVE] & waveMask);
  emit(tick, bank | (0xe3 + slot), raw[IDX.CAR_WAVE] & waveMask);
}

/**
 * Velocity macros: scale modulator output, carrier output, and feedback by
 * (velocity - 64). Velocity 64 is neutral; below 64 reduces, above 64
 * boosts. Sensitivity is an int8 per-instrument parameter.
 */
function applyVelocityMacros(
  emit: Emit,
  tick: number,
  voice: number,
  patch: HeradPatch,
  velocity: number,
  isAgd: boolean,
): void {
  const raw = patch.raw;
  const modSens = toSignedByte(raw[IDX.MC_MOD_OUT_VEL]);
  const carSens = toSignedByte(raw[IDX.MC_CAR_OUT_VEL]);
  const fbSens = toSignedByte(raw[IDX.MC_FB_VEL]);

  if (modSens !== 0) {
    emitModOutputScaled(emit, tick, voice, patch, modSens, velocity);
  }
  if (carSens !== 0) {
    emitCarOutputScaled(emit, tick, voice, patch, carSens, velocity);
  }
  if (fbSens !== 0) {
    emitFeedbackScaled(emit, tick, voice, patch, fbSens, velocity, isAgd);
  }
}

/**
 * v1 aftertouch macros: reference applies mod_out_at, car_out_at (gated on
 * mc_car_out_vel != 0), and fb_at.
 */
function applyAftertouchMacros(
  emit: Emit,
  tick: number,
  voice: number,
  patch: HeradPatch,
  level: number,
  isAgd: boolean,
): void {
  const raw = patch.raw;
  const modSens = toSignedByte(raw[IDX.MC_MOD_OUT_AT]);
  const carSens = toSignedByte(raw[IDX.MC_CAR_OUT_AT]);
  const fbSens = toSignedByte(raw[IDX.MC_FB_AT]);
  const carVelSens = toSignedByte(raw[IDX.MC_CAR_OUT_VEL]);

  if (modSens !== 0) emitModOutputScaled(emit, tick, voice, patch, modSens, level);
  if (carSens !== 0 && carVelSens !== 0)
    emitCarOutputScaled(emit, tick, voice, patch, carSens, level);
  if (fbSens !== 0) emitFeedbackScaled(emit, tick, voice, patch, fbSens, level, isAgd);
}

/**
 * Compute the scaled output value for modulator/carrier velocity or after-
 * touch macros, matching AdPlug 2.3.3's `macroModOutput` / `macroCarOutput`.
 *
 * The formula is shift-based with a 0x80 complement for the positive-
 * sensitivity side, rather than the `base*2 ± sens*diff/32` form used by
 * the GitHub-master version of the reference. Shipping AdPlug (the 2.3.3
 * series on Debian/most distros) uses this shift form, and that's what our
 * listeners actually hear when A/B-testing.
 *
 * Steps:
 *   - If sens is outside [-4, 4], the macro is a no-op (write suppressed).
 *   - Compute offset from velocity:
 *     - sens < 0: offset = level >> (sens + 4)
 *     - sens > 0: offset = (0x80 - level) >> (4 - sens)
 *   - Clamp offset to [0, 63].
 *   - Add base output level.
 *   - Clamp final to [0, 63].
 *
 * Returns -1 when the macro should be skipped (sens out of range); callers
 * treat that as "don't emit a write at all".
 */
function scaledOutputLevel(base: number, sens: number, level: number): number {
  if (sens < -4 || sens > 4) return -1;
  let output: number;
  if (sens < 0) {
    output = level >>> (sens + 4);
  } else {
    output = (0x80 - level) >>> (4 - sens);
  }
  if (output > 63) output = 63;
  output += base;
  if (output > 63) output = 63;
  return output & 0x3f;
}

/** Feedback macro — same shape as scaledOutputLevel, 3-bit range, wider [-6, 6] sens. */
function scaledFeedback(base: number, sens: number, level: number): number {
  if (sens < -6 || sens > 6) return -1;
  let feedback: number;
  if (sens < 0) {
    feedback = level >>> (sens + 7);
  } else {
    feedback = (0x80 - level) >>> (7 - sens);
  }
  if (feedback > 7) feedback = 7;
  feedback += base;
  if (feedback > 7) feedback = 7;
  return feedback & 0x07;
}

function emitModOutputScaled(
  emit: Emit,
  tick: number,
  voice: number,
  patch: HeradPatch,
  sens: number,
  level: number,
): void {
  const raw = patch.raw;
  const out = scaledOutputLevel(raw[IDX.MOD_OUT], sens, level);
  if (out < 0) return;
  const slot = SLOT_OFFSET[voice % HERAD_NUM_VOICES];
  const bank = bankOffset(voice);
  emit(tick, bank | (0x40 + slot), outputByte(out, raw[IDX.MOD_KSL]));
}

function emitCarOutputScaled(
  emit: Emit,
  tick: number,
  voice: number,
  patch: HeradPatch,
  sens: number,
  level: number,
): void {
  const raw = patch.raw;
  const out = scaledOutputLevel(raw[IDX.CAR_OUT], sens, level);
  if (out < 0) return;
  const slot = SLOT_OFFSET[voice % HERAD_NUM_VOICES];
  const bank = bankOffset(voice);
  emit(tick, bank | (0x43 + slot), outputByte(out, raw[IDX.CAR_KSL]));
}

function emitFeedbackScaled(
  emit: Emit,
  tick: number,
  voice: number,
  patch: HeradPatch,
  sens: number,
  level: number,
  isAgd: boolean,
): void {
  const raw = patch.raw;
  const fb = scaledFeedback(raw[IDX.FEEDBACK], sens, level);
  if (fb < 0) return;
  const bank = bankOffset(voice);
  const ch = voice % HERAD_NUM_VOICES;
  emit(tick, bank | (0xc0 + ch), feedbackConnectionByte(raw[IDX.CON], fb, raw[IDX.PAN], isAgd));
}

/**
 * Compute F-Number + octave + key-on for a note and emit the 0xA0/0xB0
 * register pair. Handles transpose (`mc_transpose`), fine-tune bend, and
 * coarse-tune bend (selected by `mc_slide_coarse & 1`).
 */
function emitNote(
  emit: Emit,
  tick: number,
  voice: number,
  note: number,
  bend: number,
  keyOn: boolean,
  patch: HeradPatch,
  variant: 'v1' | 'v2',
): void {
  const raw = patch.raw;
  const tranRaw = raw[IDX.MC_TRANSPOSE]; // unsigned byte for v2 threshold check
  let effectiveNote = note;
  if (tranRaw !== 0) {
    // v2 has a mode: if (tran - 0x31) & 0xFF is under 0x60, replace the note
    // entirely with (diff + 0x18) — used for absolute-note drum presets.
    // Otherwise (and for all v1), add signed transpose to the note.
    const diff = (tranRaw - 0x31) & 0xff;
    if (variant === 'v2' && diff < 0x60) {
      effectiveNote = (diff + 0x18) & 0xff;
    } else {
      effectiveNote = (note + toSignedByte(tranRaw)) & 0xff;
    }
  }

  const heradNote = (effectiveNote - 24) & 0xff;
  const clipped = heradNote >= 0x60 ? 0 : heradNote;
  let oct = Math.floor(clipped / 12);
  let key = clipped % 12;
  let detune = 0;

  if (bend !== HERAD_BEND_CENTER) {
    const useCoarse = (raw[IDX.MC_SLIDE_COARSE] & 1) === 1;
    if (bend < HERAD_BEND_CENTER) {
      const amount = HERAD_BEND_CENTER - bend;
      if (useCoarse) {
        key -= Math.floor(amount / 5);
        if (key < 0) {
          key += 12;
          oct--;
        }
        if (oct < 0) {
          key = 0;
          oct = 0;
        }
        const offset = (amount % 5) + (key >= 6 ? 5 : 0);
        detune = -COARSE_BEND[offset];
      } else {
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
      }
    } else {
      const amount = bend - HERAD_BEND_CENTER;
      if (useCoarse) {
        key += Math.floor(amount / 5);
        if (key >= 12) {
          key -= 12;
          oct++;
        }
        const offset = (amount % 5) + (key >= 6 ? 5 : 0);
        detune = COARSE_BEND[offset];
      } else {
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
  }

  const freq = FNUM[key] + detune;
  const bank = bankOffset(voice);
  const ch = voice % HERAD_NUM_VOICES;

  emit(tick, bank | (0xa0 + ch), freq & 0xff);
  emit(tick, bank | (0xb0 + ch), ((freq >> 8) & 0x03) | ((oct & 0x07) << 2) | (keyOn ? 0x20 : 0));
}

/* ─────────────────────────── Byte builders ─────────────────────────── */

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

function feedbackConnectionByte(
  con: number,
  feedback: number,
  pan: number,
  isAgd: boolean,
): number {
  const con01 = con > 0 ? 0 : 1;
  const fb3 = feedback & 0x07;
  let panBits = 0;
  if (isAgd) {
    panBits = pan === 0 || pan > 3 ? 3 : pan;
  }
  return con01 | (fb3 << 1) | (panBits << 4);
}

function toSignedByte(b: number): number {
  return b >= 0x80 ? b - 0x100 : b;
}
