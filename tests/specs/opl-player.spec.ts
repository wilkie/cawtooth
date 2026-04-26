import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(here, '../../examples');

/** Mirror of TEST_TONE_WRITES — kept inline because it's not in the public API. */
const TEST_TONE_WRITES = [
  { reg: 0x20, value: 0x01 },
  { reg: 0x23, value: 0x01 },
  { reg: 0x40, value: 0x10 },
  { reg: 0x43, value: 0x00 },
  { reg: 0x60, value: 0xf0 },
  { reg: 0x63, value: 0xf0 },
  { reg: 0x80, value: 0x77 },
  { reg: 0x83, value: 0x77 },
  { reg: 0xa0, value: 0x41 },
  { reg: 0xb0, value: 0x32 },
] as const;

test.describe('OplPlayer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#ready')).toHaveText('ready');
  });

  test('writeRegisters produces audible audio', async ({ page }) => {
    // Programs the test tone via direct register writes (bypassing the
    // sequencer). Verifies the worklet's wasm chip wiring is alive.
    const result = await page.evaluate(
      async ({ writes, urls }) => {
        const { OplPlayer } = window.cawtooth;
        const player = await OplPlayer.create({
          workletUrl: urls.oplWorklet,
          wasmUrl: urls.oplWasm,
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
        await new Promise((r) => setTimeout(r, 500));

        unsub();
        await player.dispose();
        return { nonZeroCount };
      },
      { writes: TEST_TONE_WRITES, urls: await page.evaluate(() => window.cawtoothUrls) },
    );
    expect(result.nonZeroCount).toBeGreaterThan(1000);
  });

  test('loadStream + play emits progress events; pause halts time', async ({ page }) => {
    const result = await page.evaluate(
      async ({ writes, urls }) => {
        const { OplPlayer } = window.cawtooth;
        const player = await OplPlayer.create({
          workletUrl: urls.oplWorklet,
          wasmUrl: urls.oplWasm,
        });
        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        // Build a tiny stream from the test-tone writes — every event at
        // tick 0, then one big trailing delay so the stream lasts ~3 s.
        const n = writes.length;
        const regs = new Uint16Array(n);
        const values = new Uint8Array(n);
        const delayTicks = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
          regs[i] = writes[i].reg;
          values[i] = writes[i].value;
        }
        delayTicks[n - 1] = 700 * 3; // 3 s @ 700 Hz

        const progressTicks: number[] = [];
        player.onProgress((info) => progressTicks.push(info.currentTimeSec));

        player.loadStream({ regs, values, delayTicks }, { tickRate: 700 });
        player.play();

        await new Promise((r) => setTimeout(r, 400));
        const tBeforePause = player.currentTime;
        const ticksBeforePause = progressTicks.length;

        player.pause();
        await new Promise((r) => setTimeout(r, 250));
        const tAfterPause = player.currentTime;
        const ticksAfterPause = progressTicks.length;

        await player.dispose();

        return {
          tBeforePause,
          tAfterPause,
          ticksBeforePause,
          ticksAfterPause,
          isPlayingNow: player.isPlaying,
        };
      },
      { writes: TEST_TONE_WRITES, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    // Some progress events should have arrived during the play window.
    expect(result.ticksBeforePause).toBeGreaterThan(0);
    // Time advanced.
    expect(result.tBeforePause).toBeGreaterThan(0);
    // After pause, no further progress events accumulated and time froze.
    // Allow one straggler event (in flight when pause was processed).
    expect(result.ticksAfterPause - result.ticksBeforePause).toBeLessThanOrEqual(2);
    expect(result.tAfterPause).toBeLessThanOrEqual(result.tBeforePause + 0.05);
    expect(result.isPlayingNow).toBe(false);
  });

  test('stop rewinds time to zero', async ({ page }) => {
    const result = await page.evaluate(
      async ({ writes, urls }) => {
        const { OplPlayer } = window.cawtooth;
        const player = await OplPlayer.create({
          workletUrl: urls.oplWorklet,
          wasmUrl: urls.oplWasm,
        });
        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        const n = writes.length;
        const regs = new Uint16Array(n);
        const values = new Uint8Array(n);
        const delayTicks = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
          regs[i] = writes[i].reg;
          values[i] = writes[i].value;
        }
        delayTicks[n - 1] = 700 * 3;

        player.loadStream({ regs, values, delayTicks }, { tickRate: 700 });
        player.play();
        await new Promise((r) => setTimeout(r, 350));
        const tBefore = player.currentTime;

        player.stop();
        await new Promise((r) => setTimeout(r, 100));
        const tAfter = player.currentTime;

        await player.dispose();
        return { tBefore, tAfter };
      },
      { writes: TEST_TONE_WRITES, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(result.tBefore).toBeGreaterThan(0);
    expect(result.tAfter).toBe(0);
  });

  test('parses a real IMF file and plays it', async ({ page }) => {
    // Use the bundled "Robo Red Rock" IMF from the imf demo's data dir.
    // Round-trips the parser → OplPlayer.loadStream → worklet path end to end.
    const imfPath = resolve(FIXTURES_ROOT, 'imf/data/01 - Robo Red Rock.imf');
    const bytes = await readFile(imfPath);
    const b64 = bytes.toString('base64');

    const result = await page.evaluate(
      async ({ b64, urls }) => {
        const { OplPlayer, parseImf } = window.cawtooth;
        const player = await OplPlayer.create({
          workletUrl: urls.oplWorklet,
          wasmUrl: urls.oplWasm,
        });
        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        let nonZeroCount = 0;
        const unsub = player.onChannels((data) => {
          for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > 0.0005) nonZeroCount++;
          }
        });

        // parseImf takes Uint8Array; wrap the harness's ArrayBuffer.
        const bytes = new Uint8Array(window.b64ToBytes(b64));
        const song = parseImf(bytes);
        player.loadStream(song.stream, { tickRate: 700 });
        player.play();

        await new Promise((r) => setTimeout(r, 600));

        unsub();
        const reportedTime = player.currentTime;
        await player.dispose();
        return { nonZeroCount, eventCount: song.stream.regs.length, reportedTime };
      },
      { b64, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(result.eventCount).toBeGreaterThan(100);
    expect(result.nonZeroCount).toBeGreaterThan(1000);
    expect(result.reportedTime).toBeGreaterThan(0.3);
  });
});
