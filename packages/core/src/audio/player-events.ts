/**
 * Shared event shapes for time-progress and end-of-song signalling.
 *
 * Both OplPlayer and PsidPlayer emit progress + ended events with the
 * same surface, so a generic player UI can be built against either.
 *
 * Event semantics:
 *   - `progress` fires frequently (throttled to ~20 Hz on the worklet
 *     side). `currentTimeSec` is monotonic within one song/subsong and
 *     resets to 0 when the tune is (re-)initialized or a new subsong
 *     is selected. `durationSec` is `null` when unknown.
 *   - `ended` fires exactly once per song/subsong, at the moment we
 *     detect the end — either the stream's natural end (OPL) or the
 *     caller-supplied duration has elapsed (PSID, typically from HVSC
 *     SongLengths). It does NOT auto-stop playback; consumers decide
 *     what to do (auto-advance subsong, fade, stop, etc.).
 */

export interface ProgressInfo {
  /** Seconds of audio produced since the current tune/subsong started. */
  readonly currentTimeSec: number;
  /**
   * Expected total duration in seconds, or `null` if unknown. OPL
   * streams derive this from the loaded stream's total ticks; PSID
   * tunes take whatever the caller supplied (typically from HVSC
   * SongLengths) or stay `null`.
   */
  readonly durationSec: number | null;
}

export type ProgressListener = (info: ProgressInfo) => void;

export type EndedListener = () => void;
