import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(here, '../../examples');

async function loadSidB64(name: string): Promise<string> {
  const bytes = await readFile(resolve(FIXTURES_ROOT, 'sid/data', name));
  return bytes.toString('base64');
}

test.describe('PsidPlayer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#ready')).toHaveText('ready');
  });

  test('Batman loads, init reports correct metadata', async ({ page }) => {
    const b64 = await loadSidB64('Batman_the_Movie.sid');
    const result = await page.evaluate(
      async ({ b64, urls }) => {
        const { PsidPlayer } = window.cawtooth;
        const sidBytes = window.b64ToBytes(b64);
        const player = await PsidPlayer.create({
          workletUrl: urls.psidWorklet,
          wasmUrl: urls.sidplayWasm,
          sidBytes,
        });
        const info = { ...player.info };
        await player.dispose();
        return info;
      },
      { b64, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    // Batman_the_Movie is by Matthew Cannon (1989). Header strings come
    // straight off the .sid file, so this also exercises the
    // Windows-1252 decoding path.
    expect(result.format).toBe('psid');
    expect(result.name).toMatch(/Batman/i);
    expect(result.author).toMatch(/Cannon/i);
    expect(result.songs).toBeGreaterThanOrEqual(1);
    expect(result.subsong).toBeGreaterThanOrEqual(1);
    expect(result.clockFrequency).toBeGreaterThan(900_000);
  });

  test('after play(), audio flows; pause then play resumes', async ({ page }) => {
    const b64 = await loadSidB64('Batman_the_Movie.sid');
    const result = await page.evaluate(
      async ({ b64, urls }) => {
        const { PsidPlayer } = window.cawtooth;
        const sidBytes = window.b64ToBytes(b64);
        const player = await PsidPlayer.create({
          workletUrl: urls.psidWorklet,
          wasmUrl: urls.sidplayWasm,
          sidBytes,
        });
        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        let nonZeroCount = 0;
        const unsub = player.onChannels((data) => {
          for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > 0.0005) nonZeroCount++;
          }
        });

        // Pre-play: paused-at-zero, no audio yet.
        await new Promise((r) => setTimeout(r, 100));
        const samplesBeforePlay = nonZeroCount;

        player.play();
        await new Promise((r) => setTimeout(r, 400));
        const samplesAfterPlay = nonZeroCount;
        const tAfterPlay = player.currentTime;

        player.pause();
        await new Promise((r) => setTimeout(r, 200));
        const samplesAfterPause = nonZeroCount;

        player.play();
        await new Promise((r) => setTimeout(r, 300));
        const samplesAfterResume = nonZeroCount;

        unsub();
        await player.dispose();
        return {
          samplesBeforePlay,
          samplesAfterPlay,
          samplesAfterPause,
          samplesAfterResume,
          tAfterPlay,
        };
      },
      { b64, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    // Ring buffers may carry a trickle of pre-play samples (worklet
    // boots into a "playing=false" state but the channel tap path still
    // emits zero-fill blocks). Give it a generous budget rather than
    // requiring exact zero.
    expect(result.samplesBeforePlay).toBeLessThan(50);
    // Active playback fills the buffer fast.
    expect(result.samplesAfterPlay - result.samplesBeforePlay).toBeGreaterThan(1000);
    // Pause halts new audio. Allow a small margin for one or two blocks
    // already in flight when pause was processed.
    expect(result.samplesAfterPause - result.samplesAfterPlay).toBeLessThan(500);
    // Resuming after pause adds more audio.
    expect(result.samplesAfterResume - result.samplesAfterPause).toBeGreaterThan(500);
    // Time advanced.
    expect(result.tAfterPlay).toBeGreaterThan(0.3);
  });

  test('stop rewinds currentTime; subsequent play starts from zero', async ({ page }) => {
    const b64 = await loadSidB64('Batman_the_Movie.sid');
    const result = await page.evaluate(
      async ({ b64, urls }) => {
        const { PsidPlayer } = window.cawtooth;
        const sidBytes = window.b64ToBytes(b64);
        const player = await PsidPlayer.create({
          workletUrl: urls.psidWorklet,
          wasmUrl: urls.sidplayWasm,
          sidBytes,
        });
        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        player.play();
        await new Promise((r) => setTimeout(r, 400));
        const tBeforeStop = player.currentTime;

        player.stop();
        // currentTime resets to 0 immediately on the main thread; we
        // don't need to wait for a worklet round-trip.
        const tAfterStop = player.currentTime;

        player.play();
        await new Promise((r) => setTimeout(r, 250));
        const tAfterReplay = player.currentTime;

        await player.dispose();
        return { tBeforeStop, tAfterStop, tAfterReplay };
      },
      { b64, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(result.tBeforeStop).toBeGreaterThan(0.3);
    expect(result.tAfterStop).toBe(0);
    // After re-play, time advances from zero again. The new currentTime
    // should be well below the pre-stop value (we played for 400 ms then
    // 250 ms).
    expect(result.tAfterReplay).toBeGreaterThan(0);
    expect(result.tAfterReplay).toBeLessThan(result.tBeforeStop);
  });

  test('selectSong updates info.subsong and resets currentTime', async ({ page }) => {
    const b64 = await loadSidB64('Batman_the_Movie.sid');
    const result = await page.evaluate(
      async ({ b64, urls }) => {
        const { PsidPlayer } = window.cawtooth;
        const sidBytes = window.b64ToBytes(b64);
        const player = await PsidPlayer.create({
          workletUrl: urls.psidWorklet,
          wasmUrl: urls.sidplayWasm,
          sidBytes,
        });
        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();
        player.play();

        const songs = player.info.songs;
        const subsongInitial = player.info.subsong;

        await new Promise((r) => setTimeout(r, 300));
        const tBeforeSwitch = player.currentTime;

        // If the tune has more than one subsong, switch to (initial + 1)
        // wrapping back to 1. Otherwise re-select the same subsong (still
        // exercises the path).
        const nextSubsong = songs > 1 ? (subsongInitial % songs) + 1 : subsongInitial;
        player.selectSong(nextSubsong);
        const subsongAfterSwitch = player.info.subsong;
        const tImmediatelyAfter = player.currentTime;

        await new Promise((r) => setTimeout(r, 250));
        const tAfterRunning = player.currentTime;

        await player.dispose();
        return {
          songs,
          subsongInitial,
          subsongAfterSwitch,
          nextSubsong,
          tBeforeSwitch,
          tImmediatelyAfter,
          tAfterRunning,
        };
      },
      { b64, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(result.subsongAfterSwitch).toBe(result.nextSubsong);
    expect(result.tBeforeSwitch).toBeGreaterThan(0.2);
    // currentTime resets on the main thread immediately after selectSong.
    expect(result.tImmediatelyAfter).toBe(0);
    // After running for ~250 ms more, time has advanced from the new zero.
    expect(result.tAfterRunning).toBeGreaterThan(0);
    expect(result.tAfterRunning).toBeLessThan(result.tBeforeSwitch);
  });
});
