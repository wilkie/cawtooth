/**
 * HERAD event decoder.
 *
 * Each track stored inside a HERAD song is a MIDI-ish byte stream: pairs of
 * (variable-length delay, status byte + data). Status bytes reuse MIDI's
 * top-nibble dispatch (0x80/0x90/0xA0/.../0xE0) but the semantics are
 * HERAD-specific, and a couple of nibbles are unused. 0xFF terminates the
 * track.
 *
 * This module is pure and format-focused: it turns a track byte-stream into
 * a structured list of `(delay, event)` records. It knows nothing about
 * instruments, voices, or the OPL chip. The player (`render.ts`) walks
 * those records against a shared virtual clock and produces register writes.
 */

export type HeradEvent =
  | { readonly type: 'noteOff'; readonly note: number; readonly velocity: number }
  | { readonly type: 'noteOn'; readonly note: number; readonly velocity: number }
  | { readonly type: 'programChange'; readonly program: number }
  | { readonly type: 'aftertouch'; readonly value: number }
  | { readonly type: 'pitchBend'; readonly value: number }
  | { readonly type: 'unused'; readonly status: number };

export interface HeradTimedEvent {
  /** Delay in HERAD ticks after the preceding event before this one fires. */
  readonly delayTicks: number;
  readonly event: HeradEvent;
}

export interface ParseHeradTrackOptions {
  /**
   * HERAD variant. v1 note-off events are 3 bytes (status + note + velocity);
   * v2 note-off events are 2 bytes (status + note only). This is the
   * "truncated note-off" the user-facing docs mention as a v2 tell.
   */
  variant: 'v1' | 'v2';
}

/**
 * Decode a single track byte-stream. Stops on the 0xFF end-of-track marker
 * or when the stream is exhausted. Malformed tail bytes (insufficient data
 * for a status) are treated as end-of-track rather than thrown — real songs
 * occasionally have a short trailing delay that nothing consumes.
 */
export function parseHeradTrack(
  bytes: Uint8Array,
  options: ParseHeradTrackOptions,
): HeradTimedEvent[] {
  const events: HeradTimedEvent[] = [];
  let pos = 0;

  while (pos < bytes.length) {
    const delayResult = readVlq(bytes, pos);
    if (delayResult === null) break;
    const [delay, afterDelay] = delayResult;
    pos = afterDelay;

    if (pos >= bytes.length) break;
    const status = bytes[pos++];

    if (status === 0xff) {
      // End of track. Don't emit an event for it; the delay we just read
      // would be trailing silence if anyone cares, but nothing consumes it.
      break;
    }

    const upper = status & 0xf0;
    let event: HeradEvent | null = null;

    switch (upper) {
      case 0x80: {
        // Note Off. v1: note + velocity; v2: note only.
        if (pos >= bytes.length) return events;
        const note = bytes[pos++];
        const velocity = options.variant === 'v2' ? 0 : pos < bytes.length ? bytes[pos++] : 0;
        event = { type: 'noteOff', note, velocity };
        break;
      }
      case 0x90: {
        if (pos + 1 > bytes.length) return events;
        const note = bytes[pos++];
        if (pos >= bytes.length) return events;
        const velocity = bytes[pos++];
        event = { type: 'noteOn', note, velocity };
        break;
      }
      case 0xa0:
      case 0xb0: {
        // Unused in HERAD; skip 2 data bytes per the AdPlug reference.
        pos += 2;
        if (pos > bytes.length) return events;
        event = { type: 'unused', status };
        break;
      }
      case 0xc0: {
        if (pos >= bytes.length) return events;
        const program = bytes[pos++];
        event = { type: 'programChange', program };
        break;
      }
      case 0xd0: {
        if (pos >= bytes.length) return events;
        const value = bytes[pos++];
        event = { type: 'aftertouch', value };
        break;
      }
      case 0xe0: {
        // HERAD pitch bend is a single byte (MIDI uses 2). 0x40 = center.
        if (pos >= bytes.length) return events;
        const value = bytes[pos++];
        event = { type: 'pitchBend', value };
        break;
      }
      default:
        // Anything else ends the track per the reference implementation.
        return events;
    }

    events.push({ delayTicks: delay, event });
  }

  return events;
}

/**
 * MIDI variable-length quantity. Reads 7-bit groups MSB-first; the high bit
 * of each byte signals a continuation. Returns `[value, nextPos]` or `null`
 * if the stream is exhausted before a complete VLQ can be read.
 */
function readVlq(bytes: Uint8Array, pos: number): [value: number, nextPos: number] | null {
  if (pos >= bytes.length) return null;
  let result = 0;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    result = (result << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return [result, pos];
  }
  return null;
}
