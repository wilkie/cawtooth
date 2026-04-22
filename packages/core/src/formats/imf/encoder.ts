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
  /**
   * Output variant. Default 'type1' (the common modern form with metadata).
   *
   * - 'type0' — no length header, no metadata, no size limit. Correct for
   *   any stream but loses the metadata fields.
   * - 'type1' — u16 length prefix + optional metadata tail. Imposes a
   *   65,535-byte limit on the encoded event stream; throws if exceeded.
   * - 'auto' — 'type1' when it fits AND metadata fields are present or
   *   absent; otherwise 'type0'. Throws only if metadata was explicitly
   *   requested but the stream won't fit in type-1.
   */
  readonly variant?: 'type0' | 'type1' | 'auto';
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
  /**
   * Target playback tick rate for the output file, in Hz. When provided,
   * delays are resampled from the source stream's `tickRate` to this
   * value via `round(delay * targetTickRate / sourceTickRate)`.
   *
   * IMF does not record its own tick rate — the number is a convention
   * between the file and the player. Common targets:
   *   - 560 Hz: Commander Keen, Bio Menace, most .imf files
   *   - 700 Hz: Wolfenstein 3D, Spear of Destiny, most .wlf files
   *   - 280 Hz: Duke Nukem II
   *
   * Omit this option to pass delays through unchanged — correct when the
   * source stream is already at the intended output rate (e.g. re-encoding
   * an IMF file you just parsed). Supply a value when converting from a
   * stream with a mismatched rate (HERAD's ~40 Hz → WLF 700 Hz, DRO's
   * 1000 Hz → IMF 560 Hz, etc.).
   */
  readonly targetTickRate?: number;
}

const METADATA_MARKER = 0x1a;
const MAX_DELAY_U16 = 0xffff;

/**
 * Encode a stream as IMF.
 *
 * Delays pass through unchanged by default. Set `targetTickRate` to
 * resample them — required when the source stream's rate doesn't match the
 * rate the consumer will play the file at. When `targetTickRate` is set but
 * `source.tickRate` is missing or zero, the encoder throws — it can't
 * resample without knowing the source rate.
 */
export function encodeImf(
  source: TimedRegisterStream | { stream: RegisterEventStream },
  options: EncodeImfOptions = {},
): Uint8Array {
  const stream = source.stream;
  const variant = options.variant ?? 'type1';
  const opl3Mode = options.opl3 ?? 'throw';

  // Resolve delay scaling once so the inner loop stays simple.
  let delayScale = 1;
  if (options.targetTickRate !== undefined) {
    const sourceRate = 'tickRate' in source ? source.tickRate : undefined;
    if (!sourceRate || sourceRate <= 0) {
      throw new Error(
        'cawtooth/imf: encodeImf({ targetTickRate }) requires the source stream ' +
          'to carry a positive tickRate for resampling.',
      );
    }
    delayScale = options.targetTickRate / sourceRate;
  }

  const eventBytes = encodeEventStream(stream, opl3Mode, delayScale);

  const hasMetadata =
    options.title !== undefined || options.source !== undefined || options.remarks !== undefined;
  const fitsType1 = eventBytes.length <= 0xffff;

  // Resolve the variant when 'auto' is in play.
  let resolvedVariant: 'type0' | 'type1';
  if (variant === 'auto') {
    if (fitsType1) {
      resolvedVariant = 'type1';
    } else if (hasMetadata) {
      throw new Error(
        `cawtooth/imf: event stream is ${eventBytes.length} bytes, which exceeds the ` +
          `type-1 length limit (65,535). Metadata was supplied, which requires type-1. ` +
          `Options: drop the metadata and accept type-0, or shorten the song.`,
      );
    } else {
      resolvedVariant = 'type0';
    }
  } else {
    resolvedVariant = variant;
  }

  if (resolvedVariant === 'type0') {
    return eventBytes;
  }

  // type-1 wraps the event stream with a u16 LE length prefix and may carry
  // trailing metadata. We emit the 0x1A marker + 3 null-terminated strings
  // when ANY metadata field is provided, mirroring what id's Muse editor wrote.
  if (!fitsType1) {
    throw new Error(
      `cawtooth/imf: event stream is ${eventBytes.length} bytes, which exceeds the ` +
        `type-1 u16 length field's 65,535-byte limit. Pass { variant: 'type0' } for a ` +
        `headerless encoding, or { variant: 'auto' } to fall back automatically.`,
    );
  }

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
 * Delays are multiplied by `delayScale` (1.0 = passthrough) and then split
 * across multiple no-op (reg=0, val=0) events when any single value exceeds
 * the u16 max.
 */
function encodeEventStream(
  stream: RegisterEventStream,
  opl3Mode: NonNullable<EncodeImfOptions['opl3']>,
  delayScale: number,
): Uint8Array {
  const { regs, values, delayTicks } = stream;
  const bytes: number[] = [];

  const scaledDelay = (d: number): number => (delayScale === 1 ? d : Math.round(d * delayScale));

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
        emitDelayOnly(bytes, scaledDelay(delayTicks[i]));
        continue;
      }
      reg = fullReg & 0xff; // 'mask'
    } else {
      reg = fullReg;
    }

    // Attach up to 65535 ticks of delay to the event itself; emit any
    // overflow as separate no-op events afterward.
    const delay = scaledDelay(delayTicks[i]);
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
