/**
 * ASC Sound Master module parser.
 *
 * The format ships in two header variants:
 *   Ver0: 9-byte header (no Loop field, implicit Loop = 0).
 *   Ver1: 10-byte header with an explicit Loop position byte.
 *
 * After the header an optional 63-byte ID block carries title / author
 * (`'ASM COMPILATION OF '` + 20-byte title + delimiter + 20-byte author),
 * followed by:
 *   - the patterns table at HeaderTraits.PatternsOffset
 *     (each entry = 3 LE u16 channel offsets, 6 bytes total)
 *   - the samples list at SamplesOffset (32 LE u16 per-sample offsets)
 *   - the ornaments list at OrnamentsOffset (32 LE u16 per-ornament offsets)
 *
 * Sample / ornament data live somewhere after their list and are walked
 * line-by-line until a "Finished" flag is set on a line. Loop start /
 * loop end markers also live in those flag bits.
 *
 * Pattern data is per-channel bytecode; see `parsePatternChannel` for
 * the command table, which is lifted from
 * `Formats::Chiptune::ASCSoundMaster::Format::ParseChannel` in ZXTune.
 */

import {
  ASC_MAX_ORNAMENT_LINES,
  ASC_MAX_ORNAMENTS,
  ASC_MAX_PATTERN_LINES,
  ASC_MAX_PATTERNS,
  ASC_MAX_SAMPLE_LINES,
  ASC_MAX_SAMPLES,
  ASC_MIN_PATTERN_LINES,
  type AscCell,
  type AscModule,
  type AscOrnament,
  type AscOrnamentLine,
  type AscPattern,
  type AscRow,
  type AscSample,
  type AscSampleLine,
} from './asc-types.js';

/** "ASM COMPILATION OF " — start of the 63-byte RawId block. */
const ASC_ID_PREFIX = 'ASM COMPILATION OF ';

const SAMPLE_LINE_SIZE = 3;
const ORNAMENT_LINE_SIZE = 2;
const PATTERN_ENTRY_SIZE = 6;
const SAMPLES_LIST_SIZE = ASC_MAX_SAMPLES * 2; // 32 LE u16
const ORNAMENTS_LIST_SIZE = ASC_MAX_ORNAMENTS * 2;

/** Sign-extend a 5-bit two's-complement field. */
function signExtend5(value: number): number {
  return (((value & 0x1f) << 27) >> 27);
}

interface AscHeader {
  readonly tempo: number;
  readonly loop: number;
  readonly patternsOffset: number;
  readonly samplesOffset: number;
  readonly ornamentsOffset: number;
  readonly length: number;
  /** Offset of the position byte list within `bytes`. */
  readonly positionsOffset: number;
  /** Header type — 'v0' has no loop byte; 'v1' has one. */
  readonly version: 'v0' | 'v1';
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/**
 * Read both header variants out of `bytes` and pick whichever produces
 * sensible field values. We rely on ZXTune's check ranges (tempo ∈
 * [3, 50], loop ∈ [0, 99], length ∈ [1, 100], all positions < 32) since
 * Ver0 and Ver1 only differ by a single byte and either layout can
 * always be read from the same buffer.
 */
function readHeader(bytes: Uint8Array): AscHeader {
  if (bytes.length < 10) {
    throw new Error('cawtooth/asc: file too short to contain a header');
  }

  const tryHeader = (version: 'v0' | 'v1'): AscHeader | null => {
    const ptOff = version === 'v0' ? 1 : 2;
    const tempo = bytes[0];
    const loop = version === 'v0' ? 0 : bytes[1];
    const patternsOffset = readU16LE(bytes, ptOff);
    const samplesOffset = readU16LE(bytes, ptOff + 2);
    const ornamentsOffset = readU16LE(bytes, ptOff + 4);
    const lengthIdx = ptOff + 6;
    if (lengthIdx >= bytes.length) return null;
    const length = bytes[lengthIdx];
    const positionsOffset = lengthIdx + 1;
    if (positionsOffset + length > bytes.length) return null;
    if (tempo < 3 || tempo > 50) return null;
    if (loop > 99) return null;
    if (length < 1 || length > 100) return null;
    for (let i = 0; i < length; i++) {
      if (bytes[positionsOffset + i] >= ASC_MAX_PATTERNS) return null;
    }
    if (
      patternsOffset >= bytes.length ||
      samplesOffset >= bytes.length ||
      ornamentsOffset >= bytes.length
    ) {
      return null;
    }
    return {
      tempo,
      loop,
      patternsOffset,
      samplesOffset,
      ornamentsOffset,
      length,
      positionsOffset,
      version,
    };
  };

  // Prefer Ver1 — it's the modern variant and Ver0 is rare in the wild;
  // fall through if its checks reject the buffer.
  return (
    tryHeader('v1') ??
    tryHeader('v0') ??
    (() => {
      throw new Error(
        'cawtooth/asc: file does not match either ASC header variant ' +
          '(tempo / loop / length / positions out of expected ranges)',
      );
    })()
  );
}

/**
 * Try to extract title + author from the optional 63-byte RawId block.
 * The block starts immediately after the position list and is signalled
 * by the `'ASM COMPILATION OF '` prefix. When absent (older files,
 * stripped containers) we return empty strings.
 */
function readId(
  bytes: Uint8Array,
  offset: number,
): { title: string; author: string; idSize: number } {
  if (offset + ASC_ID_PREFIX.length > bytes.length) {
    return { title: '', author: '', idSize: 0 };
  }
  for (let i = 0; i < ASC_ID_PREFIX.length; i++) {
    if (bytes[offset + i] !== ASC_ID_PREFIX.charCodeAt(i)) {
      return { title: '', author: '', idSize: 0 };
    }
  }
  // 19-byte prefix + 20-byte title + 4-byte ' BY ' delimiter + 20-byte
  // author = 63 bytes total. We trim trailing spaces & nulls to render
  // cleanly; the delimiter is sometimes "BY  " or " BY " in the wild,
  // so we don't insist on its exact bytes — just on the prefix.
  if (offset + 63 > bytes.length) return { title: '', author: '', idSize: 0 };
  const decoder = new TextDecoder('windows-1252');
  const trim = (s: string): string => s.replace(/[\s\x00]+$/, '');
  const title = trim(decoder.decode(bytes.subarray(offset + 19, offset + 39)));
  const author = trim(decoder.decode(bytes.subarray(offset + 43, offset + 63)));
  return { title, author, idSize: 63 };
}

/**
 * Parse one sample starting at `offset`. Walks 3-byte lines until either
 * the IsFinished flag fires or `MAX_SAMPLE_SIZE` lines are consumed.
 *
 * Each line's byte 0 is `BEFaaaaa` (loop-begin / loop-end / finished
 * flags + signed 5-bit "adding" field), byte 1 is signed tone deviation,
 * byte 2 is `LLLLnCCt` (level / noise mask / command / tone mask).
 */
function parseSample(bytes: Uint8Array, offset: number): AscSample {
  const lines: AscSampleLine[] = [];
  let loop = 0;
  let loopLimit = 0;
  for (
    let idx = 0;
    idx < ASC_MAX_SAMPLE_LINES && offset + (idx + 1) * SAMPLE_LINE_SIZE <= bytes.length;
    idx++
  ) {
    const lineOffset = offset + idx * SAMPLE_LINE_SIZE;
    const flagsAndAdding = bytes[lineOffset];
    const toneDeviation = (bytes[lineOffset + 1] << 24) >> 24; // signed 8-bit
    const levelAndMasks = bytes[lineOffset + 2];

    const isLoopBegin = (flagsAndAdding & 0x80) !== 0;
    const isLoopEnd = (flagsAndAdding & 0x40) !== 0;
    const isFinished = (flagsAndAdding & 0x20) !== 0;

    const command = (levelAndMasks & 0x06) >> 1;
    let volSlide = 0;
    let enableEnvelope = false;
    if (command === 1) enableEnvelope = true;
    else if (command === 2) volSlide = -1;
    else if (command === 3) volSlide = 1;

    lines.push({
      level: (levelAndMasks >> 4) & 0x0f,
      toneDeviation,
      toneMask: (levelAndMasks & 0x01) !== 0,
      noiseMask: (levelAndMasks & 0x08) !== 0,
      adding: signExtend5(flagsAndAdding & 0x1f),
      enableEnvelope,
      volSlide,
    });
    if (isLoopBegin) loop = idx;
    if (isLoopEnd) loopLimit = idx;
    if (isFinished) break;
  }
  if (lines.length === 0) {
    // The replayer indexes samples by number; never returning a zero-line
    // sample keeps the synthesizer's `getLine` lookup safe.
    lines.push({
      level: 0,
      toneDeviation: 0,
      toneMask: true,
      noiseMask: true,
      adding: 0,
      enableEnvelope: false,
      volSlide: 0,
    });
  }
  return { lines, loop, loopLimit: Math.max(loopLimit, lines.length - 1) };
}

/**
 * Parse one ornament. Each line is two bytes: byte 0 = `BEFooooo`
 * (loop / finished flags + signed 5-bit noise offset), byte 1 = signed
 * 8-bit semitone offset.
 */
function parseOrnament(bytes: Uint8Array, offset: number): AscOrnament {
  const lines: AscOrnamentLine[] = [];
  let loop = 0;
  let loopLimit = 0;
  for (
    let idx = 0;
    idx < ASC_MAX_ORNAMENT_LINES && offset + (idx + 1) * ORNAMENT_LINE_SIZE <= bytes.length;
    idx++
  ) {
    const lineOffset = offset + idx * ORNAMENT_LINE_SIZE;
    const flagsAndNoise = bytes[lineOffset];
    const noteOffset = (bytes[lineOffset + 1] << 24) >> 24;

    const isLoopBegin = (flagsAndNoise & 0x80) !== 0;
    const isLoopEnd = (flagsAndNoise & 0x40) !== 0;
    const isFinished = (flagsAndNoise & 0x20) !== 0;

    lines.push({
      noteAddon: noteOffset,
      noiseAddon: signExtend5(flagsAndNoise & 0x1f),
    });
    if (isLoopBegin) loop = idx;
    if (isLoopEnd) loopLimit = idx;
    if (isFinished) break;
  }
  if (lines.length === 0) {
    lines.push({ noteAddon: 0, noiseAddon: 0 });
  }
  return { lines, loop, loopLimit: Math.max(loopLimit, lines.length - 1) };
}

interface ChannelState {
  offset: number;
  period: number;
  counter: number;
  envelope: boolean;
}

/**
 * Decode the bytecode stream for one channel of one pattern, returning
 * the per-event cell list (in the order events arrive) plus the
 * channel's "skip period" trail. The replayer turns these into rows by
 * matching events across the three channels via the period counters.
 */
function parsePatternChannel(
  bytes: Uint8Array,
  state: ChannelState,
  // Receives parsed cell mutations. Either applies to the current row's
  // cell (most commands) or to the row metadata (tempo).
  applyCell: (cell: AscCell, rowTempo?: number) => void,
): void {
  const cell: AscCell = {};
  let tempoOverride: number | undefined;
  while (state.offset < bytes.length) {
    const cmd = bytes[state.offset++];
    if (cmd <= 0x55) {
      cell.note = cmd;
      if (state.envelope) {
        if (state.offset >= bytes.length) break;
        cell.envelopeTone = bytes[state.offset++];
      }
      break;
    }
    if (cmd <= 0x5d) {
      // "stop" — break out without adding a note. The cell may still
      // carry sample/ornament/etc. changes accumulated so far.
      break;
    }
    if (cmd === 0x5e) {
      cell.breakSample = true;
      break;
    }
    if (cmd === 0x5f) {
      cell.enabled = false;
      break;
    }
    if (cmd <= 0x9f) {
      state.period = cmd - 0x60;
      cell.period = state.period;
      continue;
    }
    if (cmd <= 0xbf) {
      cell.sample = cmd - 0xa0;
      continue;
    }
    if (cmd <= 0xdf) {
      cell.ornament = cmd - 0xc0;
      continue;
    }
    if (cmd === 0xe0) {
      cell.volume = 15;
      cell.envelopeOn = true;
      state.envelope = true;
      continue;
    }
    if (cmd <= 0xef) {
      cell.volume = cmd - 0xe0;
      cell.envelopeOff = true;
      state.envelope = false;
      continue;
    }
    if (cmd === 0xf0) {
      if (state.offset >= bytes.length) break;
      cell.noise = bytes[state.offset++];
      continue;
    }
    if ((cmd & 0xfc) === 0xf0) {
      // 0xf1 / 0xf2 / 0xf3 — continue sample / continue ornament / both.
      if (cmd & 1) cell.contSample = true;
      if (cmd & 2) cell.contOrnament = true;
      continue;
    }
    if (cmd === 0xf4) {
      if (state.offset >= bytes.length) break;
      tempoOverride = bytes[state.offset++];
      continue;
    }
    if (cmd <= 0xf6) {
      // 0xf5 = down, 0xf6 = up; multiplier ±16 per step.
      if (state.offset >= bytes.length) break;
      const step = bytes[state.offset++];
      cell.glissade = (cmd === 0xf5 ? -16 : 16) * step;
      continue;
    }
    if (cmd === 0xf7 || cmd === 0xf9) {
      if (state.offset >= bytes.length) break;
      const param = (bytes[state.offset++] << 24) >> 24;
      cell.slideSteps = param;
      cell.slideToneSliding = cmd === 0xf7;
      if (cmd === 0xf7) cell.contSample = true;
      continue;
    }
    if ((cmd & 0xf9) === 0xf8) {
      // 0xf8 / 0xfa / 0xfc / 0xfe — set envelope shape.
      cell.envelopeType = cmd & 0x0f;
      continue;
    }
    if (cmd === 0xfb) {
      if (state.offset >= bytes.length) break;
      const step = bytes[state.offset++];
      cell.volSlideDelay = step & 0x1f;
      cell.volSlideAddon = (step & 0x20) !== 0 ? -1 : 1;
      continue;
    }
    // Anything else falls through silently — matches ZXTune's behavior
    // of letting the loop run until it hits a row terminator.
  }
  applyCell(cell, tempoOverride);
}

const EMPTY_CELL: AscCell = {};

/**
 * Walk one pattern's three channel streams in lockstep, building a list
 * of `AscRow`s. Mirrors ZXTune's `ParsePattern`: each row corresponds to
 * one beat at the current tempo; channels with `counter > 0` simply
 * skip; channel 0 hitting 0xFF terminates the pattern.
 */
function parsePattern(
  bytes: Uint8Array,
  patternsOffset: number,
  patternIndex: number,
): AscPattern {
  const entryOffset = patternsOffset + patternIndex * PATTERN_ENTRY_SIZE;
  const channels: ChannelState[] = [];
  for (let c = 0; c < 3; c++) {
    const off = readU16LE(bytes, entryOffset + c * 2) + patternsOffset;
    channels.push({ offset: off, period: 0, counter: 0, envelope: false });
  }
  const rows: AscRow[] = [];
  for (let lineIdx = 0; lineIdx < ASC_MAX_PATTERN_LINES; lineIdx++) {
    // Skip empty lines: every channel with counter > 0 contributes nothing
    // to this line. The line still counts toward total length, so we
    // advance lineIdx by the minimum counter (= number of runs of empty
    // rows) and decrement counters.
    let minCounter = Infinity;
    for (const ch of channels) {
      if (ch.counter < minCounter) minCounter = ch.counter;
    }
    if (minCounter > 0) {
      for (const ch of channels) ch.counter -= minCounter;
      for (let s = 0; s < minCounter && rows.length < ASC_MAX_PATTERN_LINES; s++) {
        rows.push({ cells: [EMPTY_CELL, EMPTY_CELL, EMPTY_CELL] });
      }
      lineIdx += minCounter - 1; // outer loop's ++ adds the last
      continue;
    }

    // Line termination — channel 0 hitting 0xFF or any cursor running
    // off the end of the buffer ends the pattern. Sometimes patterns
    // are shorter than `MAX_PATTERN_SIZE`; the loop just breaks and we
    // emit what we have.
    let alive = true;
    for (let c = 0; c < 3; c++) {
      const ch = channels[c];
      if (ch.counter !== 0) continue;
      if (ch.offset >= bytes.length || (c === 0 && bytes[ch.offset] === 0xff)) {
        alive = false;
        break;
      }
    }
    if (!alive) break;

    const cells: AscCell[] = [{}, {}, {}];
    let rowTempo: number | undefined;
    for (let c = 0; c < 3; c++) {
      const ch = channels[c];
      if (ch.counter !== 0) {
        ch.counter--;
        continue;
      }
      parsePatternChannel(bytes, ch, (cell, tempo) => {
        cells[c] = cell;
        if (tempo !== undefined) rowTempo = tempo;
      });
      ch.counter = ch.period;
    }
    rows.push({
      cells: cells as unknown as readonly [AscCell, AscCell, AscCell],
      tempo: rowTempo,
    });
  }
  if (rows.length < ASC_MIN_PATTERN_LINES) {
    rows.push({ cells: [EMPTY_CELL, EMPTY_CELL, EMPTY_CELL] });
  }
  return { rows };
}

export function parseAsc(bytes: Uint8Array): AscModule {
  const header = readHeader(bytes);

  const positions: number[] = [];
  for (let i = 0; i < header.length; i++) {
    positions.push(bytes[header.positionsOffset + i]);
  }

  const idStart = header.positionsOffset + header.length;
  const id = readId(bytes, idStart);

  // Samples table — 32 LE u16 sample-data offsets, relative to
  // `samplesOffset`. The list itself sits at `samplesOffset`.
  if (header.samplesOffset + SAMPLES_LIST_SIZE > bytes.length) {
    throw new Error('cawtooth/asc: samples list extends past end of file');
  }
  const samples: AscSample[] = [];
  for (let i = 0; i < ASC_MAX_SAMPLES; i++) {
    const dataOffset = header.samplesOffset + readU16LE(bytes, header.samplesOffset + i * 2);
    if (dataOffset >= bytes.length) {
      // Out-of-range — provide a stub so the replayer can still index.
      samples.push({
        lines: [
          {
            level: 0,
            toneDeviation: 0,
            toneMask: true,
            noiseMask: true,
            adding: 0,
            enableEnvelope: false,
            volSlide: 0,
          },
        ],
        loop: 0,
        loopLimit: 0,
      });
      continue;
    }
    samples.push(parseSample(bytes, dataOffset));
  }

  if (header.ornamentsOffset + ORNAMENTS_LIST_SIZE > bytes.length) {
    throw new Error('cawtooth/asc: ornaments list extends past end of file');
  }
  const ornaments: AscOrnament[] = [];
  for (let i = 0; i < ASC_MAX_ORNAMENTS; i++) {
    const dataOffset =
      header.ornamentsOffset + readU16LE(bytes, header.ornamentsOffset + i * 2);
    if (dataOffset >= bytes.length) {
      ornaments.push({
        lines: [{ noteAddon: 0, noiseAddon: 0 }],
        loop: 0,
        loopLimit: 0,
      });
      continue;
    }
    ornaments.push(parseOrnament(bytes, dataOffset));
  }

  // Pattern table: figure out how many entries we actually have. The
  // header doesn't carry an explicit count, so we walk until we either
  // hit the samples table or run out of patterns the position list
  // references (whichever is more conservative).
  const maxPatternIndex = positions.reduce((m, p) => Math.max(m, p), 0);
  const patternsRequired = Math.min(maxPatternIndex + 1, ASC_MAX_PATTERNS);
  const patterns: AscPattern[] = [];
  for (let i = 0; i < patternsRequired; i++) {
    if (header.patternsOffset + (i + 1) * PATTERN_ENTRY_SIZE > bytes.length) {
      throw new Error(`cawtooth/asc: pattern ${i} entry overruns end of file`);
    }
    patterns.push(parsePattern(bytes, header.patternsOffset, i));
  }

  void id.idSize;
  return {
    tempo: header.tempo,
    loop: header.loop,
    positions,
    title: id.title,
    author: id.author,
    samples,
    ornaments,
    patterns,
  };
}
