import type { AyChipModel } from '../chip/ayumi-chip.js';
import type { SidChipModel } from '../chip/resid-sid.js';
import type { ChannelsListener } from './opl-player.js';
import type { EndedListener, ProgressListener } from './player-events.js';

/**
 * Discriminated union of player metadata. Narrow on `.format` to access
 * format-specific fields. All variants share `currentTime` / `duration` /
 * `isPlaying` semantics on the parent `Player`; this type is for the
 * intrinsic, mostly-static description of the loaded tune.
 */
export type PlayerInfo = OplPlayerInfo | PsidPlayerInfo | AyPlayerInfo;

export interface OplPlayerInfo {
  readonly format: 'opl';
  /** Container the bytes were parsed from. */
  readonly container: 'imf' | 'dro' | 'herad' | 'unknown';
  /** Sub-variant ('type-0', 'v2', 'sdb1', …). Empty when unknown. */
  readonly variant: string;
  /** Title from container metadata; empty when not present. */
  readonly title: string;
  /** Composer / source field; empty when not present. */
  readonly source: string;
  /** Free-form remarks field; empty when not present. */
  readonly remarks: string;
  /** Tick rate the sequencer is running at (Hz). */
  readonly tickRate: number;
  /** Total register-event count in the loaded stream. */
  readonly events: number;
  /** True when the sequencer is configured to loop. */
  readonly loop: boolean;
}

export interface AyPlayerInfo {
  readonly format: 'ay';
  /** Container the bytes were parsed from. */
  readonly container: 'psg' | 'vtx' | 'ym' | 'unknown';
  /** Sub-variant ('YM5', 'YM6', 'ay!', 'ym!', …). Empty when unknown. */
  readonly variant: string;
  /** Title from container metadata; empty when not present. */
  readonly title: string;
  /** Composer / author field; empty when not present. */
  readonly author: string;
  /** Free-form comment field; empty when not present. */
  readonly comment: string;
  /** Chip variant the file was authored against. */
  readonly model: AyChipModel;
  /** Host clock in Hz (e.g. 1773400 for ZX Spectrum, 2000000 for Atari ST). */
  readonly clockFrequency: number;
  /** Tick rate the sequencer is running at (Hz). 50 for ZX/Atari, 60 occasionally. */
  readonly tickRate: number;
  /** Total register-event count in the loaded stream. */
  readonly events: number;
  /** True when the sequencer is configured to loop. */
  readonly loop: boolean;
}

export interface PsidPlayerInfo {
  readonly format: 'psid';
  readonly name: string;
  readonly author: string;
  readonly released: string;
  /** Number of subsongs. */
  readonly songs: number;
  /** Currently-active subsong (1-based). Mutated by `selectSong()`. */
  readonly subsong: number;
  readonly model: SidChipModel;
  /** Host CPU clock in Hz (PAL ≈ 985248, NTSC ≈ 1022730). */
  readonly clockFrequency: number;
  /** CPU cycles between play-routine invocations. */
  readonly playInterval: number;
}

/**
 * Abstract base for every cawtooth audio player. Subclasses (`OplPlayer`,
 * `PsidPlayer`) implement format-specific transport plumbing on top of a
 * shared event surface — `onProgress`, `onEnded`, `onChannels` — so a
 * downstream UI can be written once against this type.
 *
 * Transport semantics are deliberately uniform across formats:
 *   - `play()`   — start (or resume from `pause`).
 *   - `pause()`  — halt time, preserve state. `currentTime` freezes.
 *   - `stop()`   — halt and rewind. Re-runs the format's own init/reset
 *                  path so subsequent `play()` starts the tune from zero.
 *
 * After construction the player is in the **paused-at-zero** state. The
 * caller must call `play()` to begin audio production.
 */
export abstract class Player {
  protected readonly progressListeners = new Set<ProgressListener>();
  protected readonly endedListeners = new Set<EndedListener>();
  protected readonly channelListeners = new Set<ChannelsListener>();

  protected constructor(
    protected readonly ctx: AudioContext,
    protected readonly ownsContext: boolean,
    protected readonly node: AudioWorkletNode,
  ) {}

  /** The audio context driving this player. */
  get audioContext(): AudioContext {
    return this.ctx;
  }

  /**
   * The worklet node. Connect it wherever you like (analyser, gain,
   * destination). The player does NOT auto-connect.
   */
  get output(): AudioWorkletNode {
    return this.node;
  }

  /**
   * Resume the underlying AudioContext if it was created in the suspended
   * state (typical pre-user-gesture). Idempotent.
   */
  async resumeAudio(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  abstract get format(): 'opl' | 'psid' | 'ay';
  abstract get info(): PlayerInfo;

  /** Begin / resume audio production. */
  abstract play(): void;
  /** Halt audio production while preserving CPU + chip state. */
  abstract pause(): void;
  /** Halt and rewind to the start of the active tune. Chip is silenced. */
  abstract stop(): void;

  /** Seconds elapsed since the active tune was (re-)initialized. */
  abstract get currentTime(): number;
  /** Total expected duration in seconds, or null if unknown. */
  abstract get duration(): number | null;
  /** True between `play()` and the next `pause()` / `stop()` / natural end. */
  abstract get isPlaying(): boolean;

  /**
   * Subscribe to progress ticks (~20 Hz while playing). Returns an
   * unsubscribe function.
   */
  onProgress(cb: ProgressListener): () => void {
    this.progressListeners.add(cb);
    return () => {
      this.progressListeners.delete(cb);
    };
  }

  /**
   * Subscribe to end-of-tune. Fires exactly once when the active tune
   * ends naturally. Looping streams never fire this. Re-loading or
   * `stop()` resets the latch.
   */
  onEnded(cb: EndedListener): () => void {
    this.endedListeners.add(cb);
    return () => {
      this.endedListeners.delete(cb);
    };
  }

  /**
   * Subscribe to per-voice PCM taps. Each subclass manages worklet
   * subscribe/unsubscribe lifecycle (turn the tap on with the first
   * listener, off with the last) since the buffer layout is
   * format-specific (OPL: 18 voices; PSID: 9 voices).
   */
  abstract onChannels(cb: ChannelsListener): () => void;

  /**
   * Tear down: clear listeners, disconnect the worklet node, close its
   * port, and close the AudioContext if we own it.
   */
  async dispose(): Promise<void> {
    this.progressListeners.clear();
    this.endedListeners.clear();
    this.channelListeners.clear();
    try {
      this.node.disconnect();
    } catch {
      // Already disconnected — ignore.
    }
    this.node.port.close();
    if (this.ownsContext) {
      await this.ctx.close();
    }
  }
}
