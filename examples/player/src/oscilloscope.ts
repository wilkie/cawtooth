import type { ChannelsListener } from 'cawtooth';

/**
 * Per-voice oscilloscope display, generalized over voice count + stride.
 *
 * The worklet's onChannels callback delivers a frame-interleaved buffer
 * containing `stride` voices per frame. We infer the stride from
 * `data.length / numFrames` rather than trusting our display count, so
 * the same code works for OPL (18 voices) and PSID (9 voice slots,
 * usually 3 active).
 */

const RING_SIZE = 2048;
const WINDOW_SAMPLES = 512;

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
  /** Canvas pixel height. Defaults to 60. */
  canvasHeight?: number;
}

export function createOscilloscope(
  container: HTMLElement,
  options: OscilloscopeOptions,
): Oscilloscope {
  const { voiceCount } = options;
  const labelFn = options.label ?? ((v) => `V${v + 1}`);
  const canvasH = options.canvasHeight ?? 60;

  const dpr = window.devicePixelRatio || 1;
  // Canvas width is determined at runtime per-canvas (each may be sized
  // by CSS to 1/N of its grid cell). We measure on first draw.
  const canvases: HTMLCanvasElement[] = [];
  const contexts: CanvasRenderingContext2D[] = [];

  container.replaceChildren();
  for (let v = 0; v < voiceCount; v++) {
    const wrap = document.createElement('div');
    wrap.className = 'scope-voice';

    const canvas = document.createElement('canvas');

    const label = document.createElement('span');
    label.className = 'voice-label';
    label.textContent = labelFn(v);

    wrap.append(canvas, label);
    container.append(wrap);
    canvases.push(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('cawtooth oscilloscope: 2D context unavailable');
    contexts.push(ctx);
  }

  // Match canvas backing-store size to its CSS layout once it's in the DOM.
  function resizeCanvases(): void {
    for (const canvas of canvases) {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, Math.floor(rect.width));
      const cssH = canvasH;
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      canvas.style.height = `${cssH}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  // Defer one frame so the layout has settled.
  requestAnimationFrame(resizeCanvases);
  // Re-size on window resize so the trace doesn't get stretched.
  window.addEventListener('resize', resizeCanvases);

  const rings: Float32Array[] = Array.from(
    { length: voiceCount },
    () => new Float32Array(RING_SIZE),
  );
  let writeIdx = 0;

  const smoothedPeaks = new Float32Array(voiceCount);

  const ingest: ChannelsListener = (data, numFrames) => {
    if (numFrames === 0) return;
    // Stride is inferred from the buffer — always (data.length / numFrames).
    // If the worklet emits more voices than we display (PSID always emits 9
    // even for 1-SID tunes), we just take the first `voiceCount`.
    const stride = (data.length / numFrames) | 0;
    const showCount = Math.min(voiceCount, stride);
    for (let f = 0; f < numFrames; f++) {
      const ringPos = (writeIdx + f) % RING_SIZE;
      const base = f * stride;
      for (let v = 0; v < showCount; v++) {
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
      drawVoice(canvases[v], contexts[v], rings[v], latestIdx, v, smoothedPeaks[v], voiceCount);
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
    window.removeEventListener('resize', resizeCanvases);
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
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  ring: Float32Array,
  latestIdx: number,
  voiceIdx: number,
  scale: number,
  voiceCount: number,
): void {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);

  ctx.fillStyle = '#0e1015';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  if (scale < MIN_PEAK_FOR_SCALE) return;

  const hue = (voiceIdx * 360) / voiceCount;
  ctx.strokeStyle = `hsl(${hue}, 70%, 60%)`;
  ctx.lineWidth = 1;
  ctx.beginPath();

  const halfH = h / 2;
  const drawGain = (halfH - 2) / scale;

  const step = WINDOW_SAMPLES / w;
  const startOffset = latestIdx - (WINDOW_SAMPLES - 1);

  for (let x = 0; x < w; x++) {
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
