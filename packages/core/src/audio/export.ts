/**
 * Offline render + audio-file export helpers.
 *
 * These are the functions that let a caller take a `RegisterEventStream`
 * (from any parser/renderer), drive an `OplChip` through it synchronously,
 * and produce either raw Float32 PCM or a WAV file.
 *
 * MP3/OGG/Opus encoders are intentionally NOT bundled — they're 100+ KB
 * each and LGPL, and the browser's `MediaRecorder` API produces them for
 * free. Callers wanting lossy export should feed our PCM output to
 * MediaRecorder (in-browser) or ffmpeg (Node).
 */

import type { OplChip } from '../chip/types.js';
import { RegisterSequencer } from '../sequencer/register-sequencer.js';
import type { TimedRegisterStream } from '../sequencer/types.js';

export interface RenderToPcmOptions {
  /** Chip to drive. Its `sampleRate` determines the output sample rate. */
  readonly chip: OplChip;
  /**
   * Safety cap on output length in seconds. Used to bound memory and to
   * prevent a pathological looping stream from rendering forever. Default
   * 600 (ten minutes); set higher for long-form content.
   */
  readonly maxDurationSec?: number;
  /**
   * Extra seconds of tail after the last event to let envelopes decay.
   * Default 1.0. Set to 0 to cut off exactly at the final tick.
   */
  readonly tailSec?: number;
}

/**
 * Render a stream through the given chip into stereo-interleaved Float32
 * PCM. The chip's sample rate determines the output rate. One frame = two
 * samples (left, right).
 */
export function renderToPcm(timed: TimedRegisterStream, options: RenderToPcmOptions): Float32Array {
  const { chip, maxDurationSec = 600, tailSec = 1.0 } = options;
  const { stream, tickRate } = timed;

  let totalTicks = 0;
  for (let i = 0; i < stream.delayTicks.length; i++) totalTicks += stream.delayTicks[i];
  const songDurationSec = totalTicks / tickRate;
  const targetSec = Math.min(songDurationSec + tailSec, maxDurationSec);
  const numFrames = Math.max(1, Math.round(targetSec * chip.sampleRate));

  const seq = new RegisterSequencer(chip);
  seq.loadStream(stream, { tickRate });
  seq.play();

  const pcm = new Float32Array(numFrames * 2);
  seq.generate(pcm);
  return pcm;
}

export interface EncodeWavOptions {
  /**
   * PCM encoding format.
   *   - 'pcm16' (default): 16-bit signed integer samples, universal support.
   *   - 'float32': IEEE float32, no precision loss but double the file size
   *     and slightly less portable to old players.
   */
  readonly format?: 'pcm16' | 'float32';
}

/**
 * Wrap stereo-interleaved Float32 PCM in a WAV (RIFF/WAVE) file. Returns
 * the file bytes; the caller is responsible for saving or transferring
 * them. Samples outside [-1, 1] are clipped when encoding to pcm16.
 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
  options: EncodeWavOptions = {},
): Uint8Array {
  const format = options.format ?? 'pcm16';
  const numChannels = 2;
  const numFrames = samples.length / numChannels;

  const bytesPerSample = format === 'pcm16' ? 2 : 4;
  const formatCode = format === 'pcm16' ? 1 : 3;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const fileSize = 12 /* RIFF header */ + 8 + 16 /* fmt chunk */ + 8 + dataSize; /* data chunk */
  const out = new Uint8Array(fileSize);
  const dv = new DataView(out.buffer);

  // "RIFF" chunk header.
  writeAscii(out, 0, 'RIFF');
  dv.setUint32(4, fileSize - 8, true);
  writeAscii(out, 8, 'WAVE');

  // "fmt " sub-chunk.
  writeAscii(out, 12, 'fmt ');
  dv.setUint32(16, 16, true); // chunk size
  dv.setUint16(20, formatCode, true);
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bytesPerSample * 8, true);

  // "data" sub-chunk.
  writeAscii(out, 36, 'data');
  dv.setUint32(40, dataSize, true);

  const dataOffset = 44;
  if (format === 'pcm16') {
    for (let i = 0; i < samples.length; i++) {
      let s = samples[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      dv.setInt16(dataOffset + i * 2, Math.round(s * 0x7fff), true);
    }
  } else {
    for (let i = 0; i < samples.length; i++) {
      dv.setFloat32(dataOffset + i * 4, samples[i], true);
    }
  }

  return out;
}

/**
 * Convenience: render a stream through a chip and return the resulting
 * audio as a ready-to-save WAV file.
 */
export function renderToWav(
  timed: TimedRegisterStream,
  options: RenderToPcmOptions & EncodeWavOptions,
): Uint8Array {
  const pcm = renderToPcm(timed, options);
  return encodeWav(pcm, options.chip.sampleRate, options);
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}
