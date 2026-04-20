/**
 * IMF encoder — writes a `RegisterEventStream` out as an IMF file.
 *
 * See `docs/formats/imf.md` for the on-disk layout. The short version:
 * each event is 4 bytes (reg:u8, val:u8, delay:u16 LE). Type 0 has no
 * header; Type 1 prefixes a u16 LE byte count of the event stream and may
 * carry trailing metadata (0x1A marker + title\0 + source\0 + remarks\0).
 *
 * Because IMF's register byte is 8-bit, OPL3 upper-bank writes (reg >=
 * 0x100) can't round-trip cleanly. By default we throw; callers can pass
 * `opl3: 'drop'` to silently skip those writes.
 *
 * The tick unit in the output matches the input stream's unit — IMF does
 * not record its own tick rate. A caller who wants IMF that plays at a
 * specific game rate (e.g. 700 Hz for Wolf3D) should ensure the stream's
 * `tickRate` is that rate; if not, they'd need to resample before encoding.
 */

import type { RegisterEventStream, TimedRegisterStream } from '../../sequencer/types.js';

export interface EncodeImfOptions {
  /** Output variant. Default 'type1' (the common modern form with metadata). */
  readonly variant?: 'type0' | 'type1';
  /** Trailing metadata for Type 1. Omitted fields become empty strings. */
  readonly title?: string;
  readonly source?: string;
  readonly remarks?: string;
  /**
   * How to handle OPL3 upper-bank writes (reg >= 0x100):
   *   - 'throw' (default): throw an error listing the first offender.
   *   - 'drop': silently skip those events (delay still accumulates).
   *   - 'mask': strip the 0x100 bit and encode as low-bank. Usually wrong —
   *     only useful for debug.
   */
  readonly opl3?: 'throw' | 'drop' | 'mask';
}

const METADATA_MARKER = 0x1a;
const MAX_DELAY_U16 = 0xffff;

/**
 * Encode a stream as IMF. The delay units of the input are passed through
 * verbatim — the caller is responsible for any tick-rate conversion.
 */
export function encodeImf(
  source: TimedRegisterStream | { stream: RegisterEventStream },
  options: EncodeImfOptions = {},
): Uint8Array {
  const stream = source.stream;
  const variant = options.variant ?? 'type1';
  const opl3Mode = options.opl3 ?? 'throw';

  const eventBytes = encodeEventStream(stream, opl3Mode);

  if (variant === 'type0') {
    return eventBytes;
  }

  // Type 1 wraps the event stream with a u16 LE length prefix and may carry
  // trailing metadata. We emit the marker + 3 null-terminated strings when
  // ANY metadata field is provided, mirroring what id's Muse editor wrote.
  const hasMetadata =
    options.title !== undefined || options.source !== undefined || options.remarks !== undefined;
  const metadata = hasMetadata
    ? buildMetadata(options.title ?? '', options.source ?? '', options.remarks ?? '')
    : null;

  const prefixLen = 2;
  const metadataLen = metadata?.length ?? 0;
  const out = new Uint8Array(prefixLen + eventBytes.length + metadataLen);
  out[0] = eventBytes.length & 0xff;
  out[1] = (eventBytes.length >> 8) & 0xff;
  out.set(eventBytes, prefixLen);
  if (metadata) {
    out.set(metadata, prefixLen + eventBytes.length);
  }
  return out;
}

/**
 * Turn the stream into a flat sequence of (reg, val, delay16) IMF events.
 * Delays greater than 65535 are split across multiple no-op (reg=0, val=0)
 * events whose delay fields sum to the intended total.
 */
function encodeEventStream(
  stream: RegisterEventStream,
  opl3Mode: NonNullable<EncodeImfOptions['opl3']>,
): Uint8Array {
  const { regs, values, delayTicks } = stream;
  // Worst case: every event has a delay > u16 max and needs splitting. Pre-
  // allocate generously; trim at the end.
  const bytes: number[] = [];

  for (let i = 0; i < regs.length; i++) {
    const fullReg = regs[i];
    const val = values[i];
    let reg: number;

    if (fullReg >= 0x100) {
      if (opl3Mode === 'throw') {
        throw new Error(
          `cawtooth/imf: event ${i} writes OPL3 upper-bank register 0x${fullReg.toString(16)}; ` +
            `IMF is OPL2-only. Pass { opl3: 'drop' } to skip or { opl3: 'mask' } to encode as low bank.`,
        );
      }
      if (opl3Mode === 'drop') {
        // Skip the write; preserve its delay on a following no-op so timing
        // isn't lost.
        emitDelayOnly(bytes, delayTicks[i]);
        continue;
      }
      reg = fullReg & 0xff; // 'mask'
    } else {
      reg = fullReg;
    }

    // Strategy: attach up to 65535 ticks of delay to the event itself; emit
    // any overflow as separate no-op events afterward.
    const delay = delayTicks[i];
    const attached = delay > MAX_DELAY_U16 ? MAX_DELAY_U16 : delay;
    bytes.push(reg, val, attached & 0xff, (attached >> 8) & 0xff);
    let remaining = delay - attached;
    while (remaining > 0) {
      const chunk = remaining > MAX_DELAY_U16 ? MAX_DELAY_U16 : remaining;
      bytes.push(0, 0, chunk & 0xff, (chunk >> 8) & 0xff);
      remaining -= chunk;
    }
  }

  return new Uint8Array(bytes);
}

/** Emit delay-only no-op events, splitting across multiple if needed. */
function emitDelayOnly(bytes: number[], delay: number): void {
  let remaining = delay;
  while (remaining > 0) {
    const chunk = remaining > MAX_DELAY_U16 ? MAX_DELAY_U16 : remaining;
    bytes.push(0, 0, chunk & 0xff, (chunk >> 8) & 0xff);
    remaining -= chunk;
  }
}

/**
 * Build the Type 1 metadata tail: 0x1A marker + three null-terminated
 * strings. Characters outside the 0x00..0xFF byte range are encoded as
 * their low 8 bits (matches the CP437-era expectations of real players).
 */
function buildMetadata(title: string, source: string, remarks: string): Uint8Array {
  const encode = (s: string): Uint8Array => {
    const out = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out; // trailing byte is already 0
  };
  const t = encode(title);
  const s = encode(source);
  const r = encode(remarks);
  const out = new Uint8Array(1 + t.length + s.length + r.length);
  out[0] = METADATA_MARKER;
  out.set(t, 1);
  out.set(s, 1 + t.length);
  out.set(r, 1 + t.length + s.length);
  return out;
}
