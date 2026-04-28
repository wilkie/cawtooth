import type { ChannelsListener } from 'cawtooth';

/**
 * Per-voice oscilloscope display, generalized over voice count.
 *
 * Mirrors the OPL example's oscilloscope — owns one ring buffer per voice,
 * ingests blocks via the `onChannels` callback, and repaints each canvas
 * from a requestAnimationFrame loop. The only SID-specific bit is that we
 * default to 3 voices; the code path is identical otherwise.
 */

const RING_SIZE = 2048;
const WINDOW_SAMPLES = 512;
const CANVAS_W = 240;
const CANVAS_H = 80;

const MIN_PEAK_FOR_SCALE = 0.005;
const PEAK_DECAY_PER_FRAME = 0.97;

export interface Oscilloscope {
  ingest: ChannelsListener;
  start(): void;
  stop(): void;
  dispose(): void;
}

export interface OscilloscopeOptions {
  voiceCount: number;
  /** Per-voice display label, called once at construction. Defaults to `V{n}`. */
  label?: (voiceIdx: number) => string;
}

export function createOscilloscope(
  container: HTMLElement,
  options: OscilloscopeOptions,
): Oscilloscope {
  const { voiceCount } = options;
  const labelFn = options.label ?? ((v) => `V${v + 1}`);

  const dpr = window.devicePixelRatio || 1;
  const canvases: HTMLCanvasElement[] = [];
  const contexts: CanvasRenderingContext2D[] = [];

  container.replaceChildren();
  for (let v = 0; v < voiceCount; v++) {
    const wrap = document.createElement('div');
    wrap.className = 'scope-voice';

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W * dpr;
    canvas.height = CANVAS_H * dpr;
    canvas.style.width = `${CANVAS_W}px`;
    canvas.style.height = `${CANVAS_H}px`;

    const label = document.createElement('span');
    label.className = 'voice-label';
    label.textContent = labelFn(v);

    wrap.append(canvas, label);
    container.append(wrap);
    canvases.push(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('cawtooth oscilloscope: 2D context unavailable');
    ctx.scale(dpr, dpr);
    contexts.push(ctx);
  }

  const rings: Float32Array[] = Array.from(
    { length: voiceCount },
    () => new Float32Array(RING_SIZE),
  );
  let writeIdx = 0;

  const smoothedPeaks = new Float32Array(voiceCount);

  const ingest: ChannelsListener = (data, numFrames) => {
    // data layout: frame-interleaved [f0_v0..f0_v(n-1), f1_v0..f1_v(n-1), ...]
    for (let f = 0; f < numFrames; f++) {
      const ringPos = (writeIdx + f) % RING_SIZE;
      const base = f * voiceCount;
      for (let v = 0; v < voiceCount; v++) {
        rings[v][ringPos] = data[base + v];
      }
    }
    writeIdx = (writeIdx + numFrames) % RING_SIZE;
  };

  let rafHandle = 0;
  let running = false;

  function draw() {
    const latestIdx = (writeIdx - 1 + RING_SIZE) % RING_SIZE;
    for (let v = 0; v < voiceCount; v++) {
      const windowPeak = peakInWindow(rings[v], latestIdx);
      smoothedPeaks[v] =
        windowPeak > smoothedPeaks[v]
          ? windowPeak
          : Math.max(windowPeak, smoothedPeaks[v] * PEAK_DECAY_PER_FRAME);
      drawVoice(contexts[v], rings[v], latestIdx, v, smoothedPeaks[v], voiceCount);
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

function drawVoice(
  ctx: CanvasRenderingContext2D,
  ring: Float32Array,
  latestIdx: number,
  voiceIdx: number,
  scale: number,
  voiceCount: number,
): void {
  ctx.fillStyle = '#0e1015';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_H / 2);
  ctx.lineTo(CANVAS_W, CANVAS_H / 2);
  ctx.stroke();

  if (scale < MIN_PEAK_FOR_SCALE) return;

  // Spread hue across the voice range. For 3 voices we get three
  // well-separated colors (red-ish, green-ish, blue-ish).
  const hue = (voiceIdx * 360) / voiceCount;
  ctx.strokeStyle = `hsl(${hue}, 70%, 60%)`;
  ctx.lineWidth = 1;
  ctx.beginPath();

  const halfH = CANVAS_H / 2;
  const drawGain = (halfH - 2) / scale;

  const step = WINDOW_SAMPLES / CANVAS_W;
  const startOffset = latestIdx - (WINDOW_SAMPLES - 1);

  for (let x = 0; x < CANVAS_W; x++) {
    const sampleOffset = Math.floor(x * step);
    const ringPos = (startOffset + sampleOffset + RING_SIZE) % RING_SIZE;
    const sample = ring[ringPos];
    const scaled = sample * drawGain;
    const y = halfH - Math.max(-(halfH - 1), Math.min(halfH - 1, scaled));
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
