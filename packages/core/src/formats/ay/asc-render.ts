/**
 * ASC Sound Master replay engine.
 *
 * Walks an `AscModule` and produces a `RegisterEventStream` of AY-3-8910
 * register writes — one event per tick that changes the chip state. The
 * tick rate is the ZX Spectrum's 50 Hz frame interrupt; the per-row
 * tempo (default 6 ticks/row, overridable by 0xF4 commands) is applied
 * inside the renderer.
 *
 * The state machine mirrors ZXTune's `Module::ASCSoundMaster::DataRenderer`
 * in spirit — same channel state, same per-row mutation logic, same
 * sample/ornament cursor advance, same sliding/volume-slide accumulation.
 * Variable names track the C++ where possible to keep cross-referencing
 * easy.
 *
 * Output convention: registers are written using the standard 14-byte
 * AY register file (R0..R13). R7 mixer follows the chiptune convention
 * (bits 0..2 = tone disable per channel, bits 3..5 = noise disable per
 * channel, bits 6..7 = port direction = "input"). R13 is force-emitted
 * whenever an envelope-shape command appears in a cell, since writing
 * R13 retriggers the envelope on Ayumi (and on real AY hardware).
 */

import type { RegisterEventStream } from '../../sequencer/types.js';
import { parseAsc } from './asc-parser.js';
import type {
  AscCell,
  AscModule,
  AscOrnament,
  AscOrnamentLine,
  AscSample,
  AscSampleLine,
} from './asc-types.js';
import type { AySong } from './types.js';

/** Default AY clock to attach to ASC-derived songs (ZX Spectrum). */
const DEFAULT_ASC_CLOCK = 1773400;

/** Frame rate ASC tunes assume — ZX Spectrum 50 Hz interrupt. */
export const ASC_TICK_RATE = 50;

/** R7 with all six mixer bits set (tone+noise disabled) and ports as input. */
const MIXER_ALL_OFF = 0x3f;

/**
 * Tone-period table used by ASC, lifted verbatim from ZXTune's
 * `TABLE_ASM` (Module::AYM frequency tables). 96 entries map semitones
 * (note number 0..0x5F) to AY tone periods at the canonical ZX clock.
 */
const TABLE_ASM: ReadonlyArray<number> = [
  0xedc, 0xe07, 0xd3e, 0xc80, 0xbcc, 0xb22, 0xa82, 0x9ec, 0x95c, 0x8d6, 0x858, 0x7e0,
  0x76e, 0x704, 0x69f, 0x640, 0x5e6, 0x591, 0x541, 0x4f6, 0x4ae, 0x46b, 0x42c, 0x3f0,
  0x3b7, 0x382, 0x34f, 0x320, 0x2f3, 0x2c8, 0x2a1, 0x27b, 0x257, 0x236, 0x216, 0x1f8,
  0x1dc, 0x1c1, 0x1a8, 0x190, 0x179, 0x164, 0x150, 0x13d, 0x12c, 0x11b, 0x10b, 0x0fc,
  0x0ee, 0x0e0, 0x0d4, 0x0c8, 0x0bd, 0x0b2, 0x0a8, 0x09f, 0x096, 0x08d, 0x085, 0x07e,
  0x077, 0x070, 0x06a, 0x064, 0x05e, 0x059, 0x054, 0x050, 0x04b, 0x047, 0x043, 0x03f,
  0x03c, 0x038, 0x035, 0x032, 0x02f, 0x02d, 0x02a, 0x028, 0x026, 0x024, 0x022, 0x020,
  0x01e, 0x01c,
  0x01a, 0x019, 0x017, 0x016, 0x015, 0x014, 0x013, 0x012, 0x011, 0x010,
];

const MAX_NOTE = 0x55;

const SILENT_SAMPLE_LINE: AscSampleLine = {
  level: 0,
  toneDeviation: 0,
  toneMask: true,
  noiseMask: true,
  adding: 0,
  enableEnvelope: false,
  volSlide: 0,
};

const ZERO_ORNAMENT_LINE: AscOrnamentLine = { noteAddon: 0, noiseAddon: 0 };

interface ChannelRuntime {
  enabled: boolean;
  envelope: boolean;
  breakSample: boolean;
  volume: number;
  volumeAddon: number;
  volSlideDelay: number;
  volSlideAddon: number;
  volSlideCounter: number;
  baseNoise: number;
  currentNoise: number;
  note: number;
  noteAddon: number;
  sampleNum: number;
  currentSampleNum: number;
  posInSample: number;
  ornamentNum: number;
  currentOrnamentNum: number;
  posInOrnament: number;
  toneDeviation: number;
  /** -1 → infinite slide; >0 → countdown; 0 → no slide. */
  slidingSteps: number;
  sliding: number;
  /** -1 → no target; otherwise the destination semitone (0..0x55). */
  slidingTargetNote: number;
  glissade: number;
}

function makeChannelRuntime(): ChannelRuntime {
  return {
    enabled: false,
    envelope: false,
    breakSample: false,
    volume: 15,
    volumeAddon: 0,
    volSlideDelay: 0,
    volSlideAddon: 0,
    volSlideCounter: 0,
    baseNoise: 0,
    currentNoise: 0,
    note: 0,
    noteAddon: 0,
    sampleNum: 0,
    currentSampleNum: 0,
    posInSample: 0,
    ornamentNum: 0,
    currentOrnamentNum: 0,
    posInOrnament: 0,
    toneDeviation: 0,
    slidingSteps: 0,
    sliding: 0,
    slidingTargetNote: -1,
    glissade: 0,
  };
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** Truncate-toward-zero integer division — matches C++ `int / int`. */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** Wrap a number into a signed 8-bit range (-128..127). */
function int8(value: number): number {
  return ((value & 0xff) << 24) >> 24;
}

function getSampleLine(sample: AscSample, idx: number): AscSampleLine {
  if (sample.lines.length === 0) return SILENT_SAMPLE_LINE;
  return sample.lines[Math.min(idx, sample.lines.length - 1)] ?? SILENT_SAMPLE_LINE;
}

function getOrnamentLine(ornament: AscOrnament, idx: number): AscOrnamentLine {
  if (ornament.lines.length === 0) return ZERO_ORNAMENT_LINE;
  return ornament.lines[Math.min(idx, ornament.lines.length - 1)] ?? ZERO_ORNAMENT_LINE;
}

interface RenderContext {
  envelopeTone: number;
  /** Registers that must be re-emitted this tick even if their value hasn't changed. */
  forceWriteMask: number;
}

/** Result returned by `renderAsc`. */
export interface RenderAscResult {
  readonly stream: RegisterEventStream;
  readonly tickRate: number;
  /** Total ticks rendered (= sum of pattern-row × tempo across positions). */
  readonly totalTicks: number;
  /** Tick index of the loop point — the first tick of `module.positions[module.loop]`. */
  readonly loopTick: number;
}

/**
 * Render an `AscModule` to a register event stream by simulating the
 * ZXTune-style replay engine for one full pass through the position
 * list. The result is suitable for feeding to `AyPlayer.loadStream`.
 */
export function renderAsc(asc: AscModule): RenderAscResult {
  const channels: ChannelRuntime[] = [makeChannelRuntime(), makeChannelRuntime(), makeChannelRuntime()];
  const ctx: RenderContext = { envelopeTone: 0, forceWriteMask: 0 };

  const regs: number[] = [];
  const values: number[] = [];
  const delays: number[] = [];
  const prevReg = new Int16Array(14).fill(-1);

  // Live register state we mutate per tick. R7 starts in the "all off"
  // configuration; everything else starts at zero.
  const cur = new Uint8Array(14);
  cur[7] = MIXER_ALL_OFF;

  let totalTicks = 0;
  let loopTick = 0;
  let tempo = asc.tempo > 0 ? asc.tempo : 6;

  for (let posIdx = 0; posIdx < asc.positions.length; posIdx++) {
    if (posIdx === asc.loop) {
      loopTick = totalTicks;
    }
    const patternIdx = asc.positions[posIdx];
    const pattern = asc.patterns[patternIdx];
    if (!pattern) continue;

    // Each pattern starts with channel-base-noise reset (per ZXTune's
    // `if (0 == state.Line()) ResetBaseNoise()`).
    for (const ch of channels) ch.baseNoise = 0;

    for (let lineIdx = 0; lineIdx < pattern.rows.length; lineIdx++) {
      const row = pattern.rows[lineIdx];
      if (row.tempo !== undefined && row.tempo > 0) tempo = row.tempo;

      // Tick 0 of the row: apply cell mutations to every channel.
      for (let chan = 0; chan < 3; chan++) {
        applyCell(channels[chan], row.cells[chan], ctx, cur);
      }

      for (let tick = 0; tick < tempo; tick++) {
        // Build this tick's register state.
        let mixer = MIXER_ALL_OFF;
        for (let chan = 0; chan < 3; chan++) {
          mixer = synthesizeChannel(channels[chan], chan, asc, cur, mixer, ctx);
        }
        cur[7] = mixer;

        // Diff against previous and emit changed (or force-write) regs.
        emitTick(cur, prevReg, regs, values, delays, ctx.forceWriteMask);
        ctx.forceWriteMask = 0;
        totalTicks += 1;
      }
    }
  }

  if (regs.length === 0) {
    // Pathological: no events at all (empty module). Emit a single R7
    // write so downstream code has something to tick on.
    regs.push(7);
    values.push(MIXER_ALL_OFF);
    delays.push(Math.max(totalTicks, 1));
  }

  const stream: RegisterEventStream = {
    regs: Uint16Array.from(regs),
    values: Uint8Array.from(values),
    delayTicks: Uint32Array.from(delays),
  };

  return {
    stream,
    tickRate: ASC_TICK_RATE,
    totalTicks,
    loopTick,
  };
}

/**
 * Apply a single row's cell mutations to a channel's runtime state.
 * Mirrors ZXTune's `GetNewChannelState` — including the SLIDE → SLIDE_NOTE
 * upgrade that happens when a cell carries both a pending slide command
 * and a note value.
 */
function applyCell(ch: ChannelRuntime, cell: AscCell, ctx: RenderContext, cur: Uint8Array): void {
  if (cell.enabled !== undefined) ch.enabled = cell.enabled;
  ch.volSlideCounter = 0;
  ch.slidingSteps = 0;
  let contSample = false;
  let contOrnament = false;
  let reloadNote = false;

  // Envelope shape / period — the type and tone live in the same ZXTune
  // ENVELOPE command, but our parser surfaces them as separate cell
  // fields. Both should fire force-writes so the AY restarts cleanly.
  if (cell.envelopeType !== undefined) {
    cur[13] = cell.envelopeType & 0x0f;
    // R13 retriggers on every write; mark it for force-emit.
    ctx.forceWriteMask |= 1 << 13;
  }
  if (cell.envelopeTone !== undefined) {
    ctx.envelopeTone = cell.envelopeTone & 0xffff;
    cur[11] = ctx.envelopeTone & 0xff;
    cur[12] = (ctx.envelopeTone >> 8) & 0xff;
    ctx.forceWriteMask |= (1 << 11) | (1 << 12);
  }
  if (cell.envelopeOn) ch.envelope = true;
  if (cell.envelopeOff) ch.envelope = false;

  if (cell.noise !== undefined) ch.baseNoise = cell.noise;
  if (cell.contSample) contSample = true;
  if (cell.contOrnament) contOrnament = true;

  if (cell.glissade !== undefined) {
    ch.glissade = cell.glissade;
    ch.slidingSteps = -1; // infinite
  }

  // Slide commands. SLIDE_NOTE is the case where the cell has both a
  // pending slide and a note value — see ZXTune DataBuilder::SetNote.
  if (cell.slideSteps !== undefined) {
    if (cell.note !== undefined) {
      ch.slidingSteps = cell.slideSteps;
      ch.slidingTargetNote = cell.note;
      const useToneSliding = cell.slideToneSliding === true;
      const curNote = clamp(ch.note, 0, MAX_NOTE);
      const tgtNote = clamp(cell.note, 0, MAX_NOTE);
      const absoluteSliding = TABLE_ASM[tgtNote] - TABLE_ASM[curNote];
      const newSliding = absoluteSliding - (useToneSliding ? idiv(ch.sliding, 16) : 0);
      const denom = ch.slidingSteps !== 0 ? ch.slidingSteps : 1;
      ch.glissade = idiv(16 * newSliding, denom);
      reloadNote = true;
    } else {
      ch.slidingSteps = cell.slideSteps;
      const newSliding = (ch.sliding | 0xf) ^ 0xf;
      const denom = ch.slidingSteps !== 0 ? ch.slidingSteps : 1;
      ch.glissade = idiv(-newSliding, denom);
      ch.sliding = ch.glissade * ch.slidingSteps;
    }
  }

  if (cell.volSlideDelay !== undefined) {
    ch.volSlideCounter = cell.volSlideDelay;
    ch.volSlideDelay = cell.volSlideDelay;
    ch.volSlideAddon = cell.volSlideAddon ?? 0;
  }

  if (cell.breakSample) ch.breakSample = true;

  if (cell.ornament !== undefined) ch.ornamentNum = cell.ornament;
  if (cell.sample !== undefined) ch.sampleNum = cell.sample;

  // Plain-note path (the SLIDE_NOTE branch above handles the combined
  // case). A note also re-enables the channel unless BreakSample is set.
  if (cell.note !== undefined && cell.slideSteps === undefined) {
    ch.note = cell.note;
    reloadNote = true;
    if (!cell.breakSample) ch.enabled = true;
  } else if (cell.note !== undefined && !cell.breakSample) {
    ch.enabled = true;
  }

  if (reloadNote) {
    ch.currentNoise = ch.baseNoise;
    if (ch.slidingSteps <= 0) ch.sliding = 0;
    if (!contSample) {
      ch.currentSampleNum = ch.sampleNum;
      ch.posInSample = 0;
      ch.volumeAddon = 0;
      ch.toneDeviation = 0;
      ch.breakSample = false;
    }
    if (!contOrnament) {
      ch.currentOrnamentNum = ch.ornamentNum;
      ch.posInOrnament = 0;
      ch.noteAddon = 0;
    }
  }

  if (cell.volume !== undefined) ch.volume = cell.volume;
}

/**
 * Render one channel for one tick: updates `cur[]` registers in place
 * and returns the new R7 mixer value. Returns input mixer unchanged
 * when the channel is disabled (its mixer bits stay set = "off").
 */
function synthesizeChannel(
  ch: ChannelRuntime,
  chan: number,
  asc: AscModule,
  cur: Uint8Array,
  mixer: number,
  ctx: RenderContext,
): number {
  if (!ch.enabled) {
    cur[8 + chan] = 0;
    return mixer;
  }

  const sample = asc.samples[ch.currentSampleNum] ?? asc.samples[0];
  const sampleLine = getSampleLine(sample, ch.posInSample);
  const ornament = asc.ornaments[ch.currentOrnamentNum] ?? asc.ornaments[0];
  const ornamentLine = getOrnamentLine(ornament, ch.posInOrnament);

  // Volume-slide tick.
  if (ch.volSlideCounter >= 2) {
    ch.volSlideCounter -= 1;
  } else if (ch.volSlideCounter === 1) {
    ch.volumeAddon += ch.volSlideAddon;
    ch.volSlideCounter = ch.volSlideDelay;
  }
  ch.volumeAddon += sampleLine.volSlide;
  ch.volumeAddon = clamp(ch.volumeAddon, -15, 15);

  // Tone period.
  ch.toneDeviation += sampleLine.toneDeviation;
  ch.noteAddon = int8(ch.noteAddon + ornamentLine.noteAddon);
  const halfTone = clamp(int8(ch.note + ch.noteAddon), 0, MAX_NOTE);
  const toneAddon = ch.toneDeviation + idiv(ch.sliding, 16);
  const tonePeriod = (TABLE_ASM[halfTone] + toneAddon) & 0xfff;
  cur[2 * chan] = tonePeriod & 0xff;
  cur[2 * chan + 1] = (tonePeriod >> 8) & 0x0f;

  // Amplitude.
  const ampLevel = clamp(ch.volumeAddon + sampleLine.level, 0, 15);
  let ampReg = ((ch.volume + 1) * ampLevel) >> 4;
  ampReg &= 0x0f;
  if (ch.envelope && sampleLine.enableEnvelope) ampReg |= 0x10;
  cur[8 + chan] = ampReg;

  // Noise contributions.
  ch.currentNoise += ornamentLine.noiseAddon;

  // Mixer + adding distribution.
  if (sampleLine.toneMask) {
    mixer |= 1 << chan;
  } else {
    mixer &= ~(1 << chan);
  }
  if (sampleLine.noiseMask && sampleLine.enableEnvelope) {
    ctx.envelopeTone = (ctx.envelopeTone + sampleLine.adding) & 0xffff;
    cur[11] = ctx.envelopeTone & 0xff;
    cur[12] = (ctx.envelopeTone >> 8) & 0xff;
  } else {
    ch.currentNoise += sampleLine.adding;
  }

  if (!sampleLine.noiseMask) {
    cur[6] = (ch.currentNoise + idiv(ch.sliding, 256)) & 0x1f;
    mixer &= ~(1 << (chan + 3));
  } else {
    mixer |= 1 << (chan + 3);
  }

  // Sliding update — runs after this tick's render.
  if (ch.slidingSteps !== 0) {
    if (ch.slidingSteps > 0) {
      ch.slidingSteps -= 1;
      if (ch.slidingSteps === 0 && ch.slidingTargetNote >= 0) {
        ch.note = ch.slidingTargetNote;
        ch.slidingTargetNote = -1;
        ch.sliding = 0;
        ch.glissade = 0;
      }
    }
    ch.sliding += ch.glissade;
  }

  // Sample / ornament cursor advance.
  const oldPosInSample = ch.posInSample;
  ch.posInSample += 1;
  if (oldPosInSample >= sample.loopLimit) {
    if (!ch.breakSample) {
      ch.posInSample = sample.loop;
    } else if (ch.posInSample >= sample.lines.length) {
      ch.enabled = false;
    }
  }
  const oldPosInOrnament = ch.posInOrnament;
  ch.posInOrnament += 1;
  if (oldPosInOrnament >= ornament.loopLimit) {
    ch.posInOrnament = ornament.loop;
  }

  return mixer;
}

/**
 * Emit register-write events for any registers whose value changed from
 * the previous tick (or that are marked as force-write). Adds 1 tick of
 * delay to the last event of the tick — or to the last event of the
 * previous tick if nothing changed this tick.
 */
function emitTick(
  cur: Uint8Array,
  prev: Int16Array,
  regs: number[],
  values: number[],
  delays: number[],
  forceMask: number,
): void {
  let emittedAny = false;
  for (let r = 0; r < 14; r++) {
    const force = (forceMask & (1 << r)) !== 0;
    if (cur[r] !== prev[r] || force) {
      regs.push(r);
      values.push(cur[r]);
      delays.push(0);
      prev[r] = cur[r];
      emittedAny = true;
    }
  }
  if (emittedAny) {
    delays[delays.length - 1] += 1;
  } else if (delays.length > 0) {
    delays[delays.length - 1] += 1;
  } else {
    // First tick has no changes (degenerate). Synthesize an R0=0 anchor.
    regs.push(0);
    values.push(0);
    delays.push(1);
    prev[0] = 0;
  }
}

// Re-export of TABLE_ASM for tests / debugging.
export const ASC_FREQUENCY_TABLE: ReadonlyArray<number> = TABLE_ASM;

/**
 * Convenience: parse + render an ASC file in one step, returning an
 * `AySong` that AyPlayer / CawtoothPlayer can consume directly. Mirrors
 * the shape of `parsePsg` / `parseVtx` / `parseYm` so all AY-format
 * inputs flow through the same pipeline.
 */
export function parseAscToAySong(bytes: Uint8Array): AySong {
  const module = parseAsc(bytes);
  const rendered = renderAsc(module);
  return {
    stream: rendered.stream,
    tickRate: rendered.tickRate,
    container: 'asc',
    variant: '',
    model: 'AY-3-8910',
    clockFrequency: DEFAULT_ASC_CLOCK,
    title: module.title,
    author: module.author,
    comment: '',
    loop: true,
  };
}
