import { OPL_CHANNEL_COUNT, type ChannelsListener } from 'cawtooth';

/**
 * Per-voice oscilloscope display.
 *
 * Owns one ring buffer per OPL3 voice (18 total). `ingest` is the
 * `onChannels` callback — it writes the latest block into the rings. A
 * requestAnimationFrame loop independently reads the rings and redraws the
 * 18 canvases, decoupling draw rate from audio block rate.
 */

const RING_SIZE = 2048;
const WINDOW_SAMPLES = 512; // ~10.7 ms at 48 kHz
const CANVAS_W = 160;
const CANVAS_H = 52;

/** Fraction of full scale below which a voice is considered silent. */
const MIN_PEAK_FOR_SCALE = 0.005;
/** Per-draw exponential decay of the auto-scale peak. ~0.97^15 ≈ 0.5 → ~250ms half-life at 60fps. */
const PEAK_DECAY_PER_FRAME = 0.97;

export interface Oscilloscope {
  ingest: ChannelsListener;
  start(): void;
  stop(): void;
  dispose(): void;
}

export function createOscilloscope(container: HTMLElement): Oscilloscope {
  const dpr = window.devicePixelRatio || 1;
  const canvases: HTMLCanvasElement[] = [];
  const contexts: CanvasRenderingContext2D[] = [];

  container.replaceChildren();
  for (let v = 0; v < OPL_CHANNEL_COUNT; v++) {
    const wrap = document.createElement('div');
    wrap.className = 'scope-voice';

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W * dpr;
    canvas.height = CANVAS_H * dpr;
    canvas.style.width = `${CANVAS_W}px`;
    canvas.style.height = `${CANVAS_H}px`;

    const label = document.createElement('span');
    label.className = 'voice-label';
    label.textContent = `V${String(v).padStart(2, '0')}`;

    wrap.append(canvas, label);
    container.append(wrap);
    canvases.push(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('cawtooth oscilloscope: 2D context unavailable');
    ctx.scale(dpr, dpr);
    contexts.push(ctx);
  }

  // One ring per voice; write-cursor is shared because ingest writes all
  // voices at identical sample offsets.
  const rings: Float32Array[] = Array.from(
    { length: OPL_CHANNEL_COUNT },
    () => new Float32Array(RING_SIZE),
  );
  let writeIdx = 0;

  // Per-voice smoothed peaks, used to auto-scale each trace so a single
  // OPL voice (which typically maxes around ±0.1–0.2 because the chip is
  // designed to mix many voices without clipping) still fills its canvas.
  // Attack is instant; decay is slow so brief silence doesn't snap the
  // visible amplitude to zero.
  const smoothedPeaks = new Float32Array(OPL_CHANNEL_COUNT);

  const ingest: ChannelsListener = (data, numFrames) => {
    // data layout: frame-interleaved [f0_v0..f0_v17, f1_v0..f1_v17, ...]
    for (let f = 0; f < numFrames; f++) {
      const ringPos = (writeIdx + f) % RING_SIZE;
      const base = f * OPL_CHANNEL_COUNT;
      for (let v = 0; v < OPL_CHANNEL_COUNT; v++) {
        rings[v][ringPos] = data[base + v];
      }
    }
    writeIdx = (writeIdx + numFrames) % RING_SIZE;
  };

  let rafHandle = 0;
  let running = false;

  function draw() {
    const latestIdx = (writeIdx - 1 + RING_SIZE) % RING_SIZE;
    for (let v = 0; v < OPL_CHANNEL_COUNT; v++) {
      const windowPeak = peakInWindow(rings[v], latestIdx);
      // Attack: snap up to any new higher peak. Decay: exponential per frame.
      smoothedPeaks[v] =
        windowPeak > smoothedPeaks[v]
          ? windowPeak
          : Math.max(windowPeak, smoothedPeaks[v] * PEAK_DECAY_PER_FRAME);
      drawVoice(contexts[v], rings[v], latestIdx, v, smoothedPeaks[v]);
    }
    rafHandle = requestAnimationFrame(draw);
  }

  function start() {
    if (running) return;
    running = true;
    rafHandle = requestAnimationFrame(draw);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafHandle);
  }

  function dispose() {
    stop();
    container.replaceChildren();
  }

  return { ingest, start, stop, dispose };
}

/** Peak absolute value across the visible window of a voice. */
function peakInWindow(ring: Float32Array, latestIdx: number): number {
  const startOffset = latestIdx - (WINDOW_SAMPLES - 1);
  let peak = 0;
  for (let i = 0; i < WINDOW_SAMPLES; i++) {
    const pos = (startOffset + i + RING_SIZE) % RING_SIZE;
    const a = Math.abs(ring[pos]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Draw the most recent WINDOW_SAMPLES samples of one voice.
 *
 * `scale` is the smoothed peak amplitude we should treat as "full height".
 * A single OPL voice typically peaks well below ±1.0, so without this each
 * trace would be a flat-looking squiggle a few pixels tall. Triggering is
 * not applied — the waveform shifts left as new samples arrive; this is
 * plenty for seeing shape, envelope, and activity.
 */
function drawVoice(
  ctx: CanvasRenderingContext2D,
  ring: Float32Array,
  latestIdx: number,
  voiceIdx: number,
  scale: number,
): void {
  ctx.fillStyle = '#0e1015';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_H / 2);
  ctx.lineTo(CANVAS_W, CANVAS_H / 2);
  ctx.stroke();

  // Don't bother drawing a waveform for a silent voice — the reference
  // mid-line alone makes it clear it's inactive.
  if (scale < MIN_PEAK_FOR_SCALE) return;

  const hue = (voiceIdx * 20) % 360;
  ctx.strokeStyle = `hsl(${hue}, 70%, 60%)`;
  ctx.lineWidth = 1;
  ctx.beginPath();

  // Leave a 1-pixel margin top/bottom so the peaks don't touch the edges.
  const halfH = CANVAS_H / 2;
  const drawGain = (halfH - 2) / scale;

  const step = WINDOW_SAMPLES / CANVAS_W;
  const startOffset = latestIdx - (WINDOW_SAMPLES - 1);

  for (let x = 0; x < CANVAS_W; x++) {
    const sampleOffset = Math.floor(x * step);
    const ringPos = (startOffset + sampleOffset + RING_SIZE) % RING_SIZE;
    const sample = ring[ringPos];
    const scaled = sample * drawGain;
    // Clamp in case a fresh transient briefly exceeds the smoothed peak.
    const y = halfH - Math.max(-(halfH - 1), Math.min(halfH - 1, scaled));
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
