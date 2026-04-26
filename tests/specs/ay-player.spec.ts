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
