/**
 * IMF (Id Music Format) parser.
 *
 * Format:
 *   - Each event is 4 bytes: [reg:u8, value:u8, delay:u16LE]
 *   - `delay` is the number of ticks to wait AFTER writing this event
 *   - Type 0: raw events, no header
 *   - Type 1: leading u16LE giving the length (bytes) of the event stream,
 *             followed by events, followed by optional trailing metadata
 *   - Trailing metadata (optional): 0x1A marker + up to three null-terminated
 *             strings (title, source/composer, remarks). Not all files include
 *             all three; encoders vary.
 *
 * The tick rate is NOT stored in the file — it's game-specific (Wolf3D and
 * derivatives use 700 Hz, Commander Keen uses 560 Hz, some others 280 Hz).
 * Callers pass the tick rate at playback time.
 */

import type { RegisterEventStream } from '../../sequencer/types.js';

export interface ImfSong {
  /** Parsed register-write events, ready to feed a sequencer. */
  readonly stream: RegisterEventStream;

  /** Detected file variant. */
  readonly variant: 'type0' | 'type1';

  /** Title from trailing metadata, if present. */
  readonly title?: string;

  /** Source / composer field from trailing metadata, if present. */
  readonly source?: string;

  /** Remarks / program name from trailing metadata, if present. */
  readonly remarks?: string;
}

export interface ParseImfOptions {
  /** Force a specific variant. Default: 'auto'. */
  variant?: 'auto' | 'type0' | 'type1';
}

const EVENT_SIZE = 4;
const METADATA_MARKER = 0x1a;

export function parseImf(bytes: Uint8Array, options: ParseImfOptions = {}): ImfSong {
  const variantOption = options.variant ?? 'auto';
  const detected =
    variantOption === 'auto' ? detectVariant(bytes) : (variantOption as 'type0' | 'type1');

  let eventsOffset: number;
  let eventsLength: number;

  if (detected === 'type1') {
    if (bytes.length < 2) {
      throw new Error('cawtooth/imf: file too short to contain a type-1 header');
    }
    const declaredLen = bytes[0] | (bytes[1] << 8);
    eventsOffset = 2;
    // Clip to what actually fits in the file — some encoders overstate the
    // length, and we'd rather play what's there than throw.
    eventsLength = Math.min(declaredLen, bytes.length - 2);
  } else {
    eventsOffset = 0;
    eventsLength = bytes.length;
  }

  // Round down to whole events; trailing partial event is ignored.
  const wholeEventBytes = eventsLength - (eventsLength % EVENT_SIZE);
  const eventCount = wholeEventBytes / EVENT_SIZE;

  const regs = new Uint16Array(eventCount);
  const values = new Uint8Array(eventCount);
  const delayTicks = new Uint32Array(eventCount);

  for (let i = 0; i < eventCount; i++) {
    const o = eventsOffset + i * EVENT_SIZE;
    regs[i] = bytes[o];
    values[i] = bytes[o + 1];
    delayTicks[i] = bytes[o + 2] | (bytes[o + 3] << 8);
  }

  const metadata = readMetadata(bytes, eventsOffset + wholeEventBytes);

  return {
    stream: { regs, values, delayTicks },
    variant: detected,
    ...(metadata.title !== undefined && { title: metadata.title }),
    ...(metadata.source !== undefined && { source: metadata.source }),
    ...(metadata.remarks !== undefined && { remarks: metadata.remarks }),
  };
}

function detectVariant(bytes: Uint8Array): 'type0' | 'type1' {
  // Fewer than 4 bytes can't even be one event; treat as type0 to let the
  // zero-event path handle it uniformly.
  if (bytes.length < 4) return 'type0';

  const firstU16 = bytes[0] | (bytes[1] << 8);

  // A type-1 header declares the event-stream size in bytes. A legitimate
  // value is a positive multiple of EVENT_SIZE that fits within the file.
  if (firstU16 > 0 && firstU16 % EVENT_SIZE === 0 && firstU16 + 2 <= bytes.length) {
    return 'type1';
  }

  // Known type-1 sentinel: length 0 with trailing metadata only.
  // Uncommon; treat as type0 to keep detection conservative.
  return 'type0';
}

interface Metadata {
  title?: string;
  source?: string;
  remarks?: string;
}

function readMetadata(bytes: Uint8Array, offset: number): Metadata {
  if (offset >= bytes.length) return {};
  // Many encoders put the 0x1A marker right after the event stream; some
  // skip it. Tolerate both.
  let cursor = offset;
  if (bytes[cursor] === METADATA_MARKER) {
    cursor++;
  }
  if (cursor >= bytes.length) return {};

  const strings: string[] = [];
  while (cursor < bytes.length && strings.length < 3) {
    const nul = bytes.indexOf(0, cursor);
    const end = nul === -1 ? bytes.length : nul;
    strings.push(decodeAscii(bytes.subarray(cursor, end)));
    cursor = end + 1;
  }

  return {
    title: strings[0],
    source: strings[1],
    remarks: strings[2],
  };
}

function decodeAscii(bytes: Uint8Array): string {
  // IMF metadata is conventionally ASCII; a few late encoders include
  // CP437 graphics. Leave high bytes as-is rather than UTF-8 decoding,
  // which would choke on them.
  let out = '';
  for (const b of bytes) {
    out += String.fromCharCode(b);
  }
  return out;
}
