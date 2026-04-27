/**
 * Shared types for the AY register-dump formats (.psg, .vtx, .ym).
 *
 * Every parser produces a `RegisterEventStream` (the library's universal
 * AoS-of-arrays event format) plus a small metadata bundle. The streams
 * are fed to the AY worklet through `AyPlayer.loadStream`, which times
 * playback at the parser-supplied tick rate.
 */

import type { AyChipModel } from '../../chip/ayumi-chip.js';
import type { RegisterEventStream } from '../../sequencer/types.js';

export interface AySong {
  /** Parsed register-write events. */
  readonly stream: RegisterEventStream;
  /** Ticks per second the file is authored at — usually 50 (PAL) or 60. */
  readonly tickRate: number;
  /** Container the bytes were parsed from. */
  readonly container: 'psg' | 'vtx' | 'ym';
  /** Sub-variant identifier — `'YM5'`, `'ay!'`, etc. Empty when not meaningful. */
  readonly variant: string;
  /** Chip the file was authored against. AY-3-8910 unless the format flags YM. */
  readonly model: AyChipModel;
  /** Host clock the file was authored at, in Hz. */
  readonly clockFrequency: number;
  /** Title from container metadata; empty when not present. */
  readonly title: string;
  /** Author/composer; empty when not present. */
  readonly author: string;
  /** Free-form comment; empty when not present. */
  readonly comment: string;
  /** True if the file declares a loop (most VTX/YM files do). */
  readonly loop: boolean;
}
