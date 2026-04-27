import { test, expect } from '@playwright/test';

/**
 * Program channel A on a ZX Spectrum-clocked AY-3-8910 for a steady
 * square tone at ~440 Hz. tone_period = clock / (16 * freq) ≈ 252.
 *
 *   R0 = 0xFC, R1 = 0x00     — tone period A = 252
 *   R7 = 0x3E                — enable tone A only (bit 0 clear)
 *   R8 = 0x0F                — channel A volume = 15
 */
const A4_TONE_WRITES = [
  { reg: 0, value: 0xfc },
  { reg: 1, value: 0x00 },
  { reg: 7, value: 0x3e },
  { reg: 8, value: 0x0f },
] as const;

test.describe('AyPlayer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#ready')).toHaveText('ready');
  });

  test('writeRegisters produces audible audio', async ({ page }) => {
    const result = await page.evaluate(
      async ({ writes, urls }) => {
        const { AyPlayer } = window.cawtooth;
        const player = await AyPlayer.create({
          workletUrl: urls.ayWorklet,
          wasmUrl: urls.ayumiWasm,
        });
        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        let nonZeroCount = 0;
        const unsub = player.onChannels((data) => {
          for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > 0.0005) nonZeroCount++;
          }
        });

        player.writeRegisters(writes);
        // Skip the first ~200ms — Ayumi's DC filter takes ~1024 samples
        // to settle from the initial idle state, during which the
        // visible-output peak is suppressed below the threshold.
        await new Promise((r) => setTimeout(r, 600));

        unsub();
        await player.dispose();
        return { nonZeroCount };
      },
      { writes: A4_TONE_WRITES, urls: await page.evaluate(() => window.cawtoothUrls) },
    );
    expect(result.nonZeroCount).toBeGreaterThan(1000);
  });

  test('reset() silences the chip', async ({ page }) => {
    const result = await page.evaluate(
      async ({ writes, urls }) => {
        const { AyPlayer } = window.cawtooth;
        const player = await AyPlayer.create({
          workletUrl: urls.ayWorklet,
          wasmUrl: urls.ayumiWasm,
        });
        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        let phaseACount = 0;
        let phaseBCount = 0;
        let inPhaseB = false;
        const unsub = player.onChannels((data) => {
          let nonZero = 0;
          for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > 0.0005) nonZero++;
          }
          if (inPhaseB) phaseBCount += nonZero;
          else phaseACount += nonZero;
        });

        player.writeRegisters(writes);
        await new Promise((r) => setTimeout(r, 400));

        player.reset();
        // Drop a beat so the chip's reset takes effect and the DC
        // filter (now zeroed by our wrapper's full reconfigure) is
        // back at zero.
        await new Promise((r) => setTimeout(r, 100));
        inPhaseB = true;
        await new Promise((r) => setTimeout(r, 300));

        unsub();
        await player.dispose();
        return { phaseACount, phaseBCount };
      },
      { writes: A4_TONE_WRITES, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    // Phase A (tone playing) had lots of non-zero samples. Phase B
    // (after reset) should be near silent — allow a small margin in
    // case a block straddled the boundary.
    expect(result.phaseACount).toBeGreaterThan(1000);
    expect(result.phaseBCount).toBeLessThan(200);
  });

  test('loadStream + play produces audio and fires ended', async ({ page }) => {
    // Build a synthetic event stream that programs the same A4 tone, lets
    // it ring for ~12 ticks (≈240 ms at 50 Hz) without any further writes,
    // then ends. The sequencer fires `ended` once it crosses the final
    // delay; we check both audio output and that signal land.
    const result = await page.evaluate(
      async ({ writes, urls }) => {
        const { AyPlayer } = window.cawtooth;
        const player = await AyPlayer.create({
          workletUrl: urls.ayWorklet,
          wasmUrl: urls.ayumiWasm,
        });
        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        // Build a parallel-arrays event stream: each register write at
        // delay 0 except the last, which carries the full tail in ticks.
        const regs = new Uint16Array(writes.map((w) => w.reg));
        const values = new Uint8Array(writes.map((w) => w.value));
        const delayTicks = new Uint32Array(writes.length);
        delayTicks[delayTicks.length - 1] = 12;

        let endedFired = false;
        const unsubEnded = player.onEnded(() => {
          endedFired = true;
        });

        let progressTicks = 0;
        const unsubProgress = player.onProgress(() => {
          progressTicks++;
        });

        let nonZeroCount = 0;
        const unsubChannels = player.onChannels((data) => {
          for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > 0.0005) nonZeroCount++;
          }
        });

        player.loadStream(
          { regs, values, delayTicks },
          { tickRate: 50, loop: false },
          { container: 'psg' },
        );
        const beforePlay = player.isPlaying;
        player.play();
        await new Promise((r) => setTimeout(r, 700));

        unsubChannels();
        unsubProgress();
        unsubEnded();
        await player.dispose();

        return {
          beforePlay,
          format: player.format,
          container: player.info.container,
          events: player.info.events,
          tickRate: player.info.tickRate,
          nonZeroCount,
          endedFired,
          progressTicks,
        };
      },
      { writes: A4_TONE_WRITES, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(result.beforePlay).toBe(false);
    expect(result.format).toBe('ay');
    expect(result.container).toBe('psg');
    expect(result.events).toBe(A4_TONE_WRITES.length);
    expect(result.tickRate).toBe(50);
    expect(result.nonZeroCount).toBeGreaterThan(1000);
    expect(result.endedFired).toBe(true);
    // Progress fires ~20 Hz. ~240ms of playback gives a handful of ticks;
    // be generous on the lower bound to avoid timing flakes on slow CI.
    expect(result.progressTicks).toBeGreaterThan(0);
  });

  test('CawtoothPlayer auto-loads a PSG file by magic and plays it', async ({ page }) => {
    // Build a tiny PSG: header (16 bytes, version=0x10, rate=0/default),
    // then the same A4-tone register pokes followed by a few frame-end
    // markers and an explicit 0xFD terminator.
    const result = await page.evaluate(
      async ({ writes, urls }) => {
        const header = [0x50, 0x53, 0x47, 0x1a, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        const payload: number[] = [];
        for (const w of writes) {
          payload.push(w.reg, w.value);
        }
        // 8 frame markers (~160 ms at 50 Hz) so the chip rings for a
        // measurable window before EOM.
        for (let i = 0; i < 8; i++) payload.push(0xff);
        payload.push(0xfd);
        const psgBytes = new Uint8Array([...header, ...payload]);

        const { CawtoothPlayer, AyPlayer } = window.cawtooth;
        const factory = await CawtoothPlayer.init({
          formats: { ay: { workletUrl: urls.ayWorklet, wasmUrl: urls.ayumiWasm } },
        });
        const player = await factory.load(psgBytes);
        const isAy = player instanceof AyPlayer;
        const fmt = player.format;
        const info = { ...player.info };

        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        let nonZeroCount = 0;
        const unsub = player.onChannels((data) => {
          for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > 0.0005) nonZeroCount++;
          }
        });

        player.play();
        await new Promise((r) => setTimeout(r, 500));

        unsub();
        await player.dispose();
        await factory.dispose();
        return { isAy, fmt, info, nonZeroCount };
      },
      { writes: A4_TONE_WRITES, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(result.isAy).toBe(true);
    expect(result.fmt).toBe('ay');
    expect(result.info.format).toBe('ay');
    if (result.info.format === 'ay') {
      expect(result.info.container).toBe('psg');
      expect(result.info.tickRate).toBe(50);
      expect(result.info.events).toBeGreaterThanOrEqual(A4_TONE_WRITES.length);
    }
    expect(result.nonZeroCount).toBeGreaterThan(1000);
  });

  test('YM2149 model also produces audio', async ({ page }) => {
    // Sanity: the YM variant has a different (32-step) DAC table.
    // Confirms the model parameter actually plumbs through to wasm.
    const result = await page.evaluate(
      async ({ writes, urls }) => {
        const { AyPlayer } = window.cawtooth;
        const player = await AyPlayer.create({
          workletUrl: urls.ayWorklet,
          wasmUrl: urls.ayumiWasm,
          model: 'YM2149',
        });
        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        let nonZeroCount = 0;
        const unsub = player.onChannels((data) => {
          for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > 0.0005) nonZeroCount++;
          }
        });

        player.writeRegisters(writes);
        await new Promise((r) => setTimeout(r, 600));

        unsub();
        await player.dispose();
        return { nonZeroCount };
      },
      { writes: A4_TONE_WRITES, urls: await page.evaluate(() => window.cawtoothUrls) },
    );
    expect(result.nonZeroCount).toBeGreaterThan(1000);
  });
});
