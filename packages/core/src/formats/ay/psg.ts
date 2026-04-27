/**
 * .PSG (PSG Pack) parser.
 *
 * Tiny container used widely on the ZX Spectrum scene for AY register
 * dumps. The file is a 16-byte header followed by a stream of one-byte
 * opcodes:
 *
 *   - `0xFF`        — end-of-frame; advance one tick at the file rate
 *   - `0xFE n`      — skip `n × 4` frames (multi-frame run-length)
 *   - `0xFD`        — end-of-music (terminates parsing)
 *   - `R V`         — write byte `V` to register `R` (R ∈ 0..15) at the
 *                     current frame; multiple writes between two `0xFF`
 *                     markers all happen at the same tick
 *
 * Header layout (16 bytes):
 *   bytes 0–3  : "PSG\x1A" magic
 *   byte  4    : marker / version (informational; we ignore)
 *   byte  5    : frame rate in Hz, or 0 to mean "default 50 Hz"
 *   bytes 6–15 : reserved (typically zero)
 *
 * The format does not encode loop points, title, or chip model — those
 * arrive via filename / sidecar conventions (or not at all).
 */

import type { RegisterEventStream } from '../../sequencer/types.js';
import type { AySong } from './types.js';

const HEADER_BYTES = 16;
const PSG_MAGIC = [0x50, 0x53, 0x47, 0x1a]; // "PSG\x1A"
const DEFAULT_TICK_RATE = 50;

export function parsePsg(bytes: Uint8Array): AySong {
  if (bytes.length < HEADER_BYTES) {
    throw new Error('cawtooth/psg: file too short to contain a PSG header');
  }
  for (let i = 0; i < PSG_MAGIC.length; i++) {
    if (bytes[i] !== PSG_MAGIC[i]) {
      throw new Error('cawtooth/psg: not a PSG file (missing PSG\\x1A magic)');
    }
  }

  const declaredRate = bytes[5];
  const tickRate = declaredRate === 0 ? DEFAULT_TICK_RATE : declaredRate;

  const regs: number[] = [];
  const values: number[] = [];
  const delays: number[] = [];

  // Pending frame delay accumulates as we cross 0xFF / 0xFE markers and is
  // applied to whichever event was most recently emitted (delayTicks[i] is
  // the wait *after* event i).
  let pendingDelay = 0;
  let i = HEADER_BYTES;
  let ended = false;

  while (i < bytes.length) {
    const op = bytes[i];

    if (op === 0xfd) {
      ended = true;
      break;
    }
    if (op === 0xff) {
      pendingDelay += 1;
      i += 1;
      continue;
    }
    if (op === 0xfe) {
      if (i + 1 >= bytes.length) {
        throw new Error('cawtooth/psg: truncated 0xFE skip opcode at end of stream');
      }
      pendingDelay += bytes[i + 1] * 4;
      i += 2;
      continue;
    }

    // Plain register write. The first byte is the register address (we
    // mask to 4 bits since the upper nibble is "reserved" but a few
    // capture tools have set it to other values historically); the
    // following byte is the data.
    if (i + 1 >= bytes.length) {
      throw new Error(`cawtooth/psg: truncated register write at offset ${i}`);
    }
    const reg = op & 0x0f;
    const value = bytes[i + 1];
    i += 2;

    if (delays.length > 0) {
      delays[delays.length - 1] += pendingDelay;
      pendingDelay = 0;
    }
    regs.push(reg);
    values.push(value);
    delays.push(0);
  }

  // Trailing pendingDelay (frames after the last register write but before
  // 0xFD or EOF) becomes the final event's tail. This keeps `duration`
  // accurate so end-of-tune detection fires at the right time.
  if (delays.length > 0) {
    delays[delays.length - 1] += pendingDelay;
  }

  // If the loop ended without seeing 0xFD, that's allowed — many .psg
  // files in the wild simply truncate at end-of-data with no terminator.
  // But a completely empty payload (no events) is suspicious; flag it so
  // downstream code can fail loudly rather than play silence.
  void ended;
  if (regs.length === 0) {
    throw new Error('cawtooth/psg: file contained no register writes');
  }

  const stream: RegisterEventStream = {
    regs: Uint16Array.from(regs),
    values: Uint8Array.from(values),
    delayTicks: Uint32Array.from(delays),
  };

  return {
    stream,
    tickRate,
    container: 'psg',
    variant: '',
    // PSG carries no model or clock metadata. ZX Spectrum is by far the
    // most common authoring target, so we default to AY-3-8910 at the
    // ZX clock; callers who know better can override at the player layer.
    model: 'AY-3-8910',
    clockFrequency: 1773400,
    title: '',
    author: '',
    comment: '',
    loop: false,
  };
}
