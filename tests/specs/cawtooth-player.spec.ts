import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(here, '../../examples');

async function readB64(rel: string): Promise<string> {
  const bytes = await readFile(resolve(FIXTURES_ROOT, rel));
  return bytes.toString('base64');
}

test.describe('CawtoothPlayer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#ready')).toHaveText('ready');
  });

  test('PSID bytes → PsidPlayer instance, audio flows after play()', async ({ page }) => {
    const b64 = await readB64('sid/data/Batman_the_Movie.sid');
    const result = await page.evaluate(
      async ({ b64, urls }) => {
        const { CawtoothPlayer, PsidPlayer } = window.cawtooth;
        const factory = await CawtoothPlayer.init({
          formats: {
            opl: { workletUrl: urls.oplWorklet, wasmUrl: urls.oplWasm },
            psid: { workletUrl: urls.psidWorklet, wasmUrl: urls.sidplayWasm },
          },
        });
        const bytes = window.b64ToBytes(b64);
        const player = await factory.load(bytes, { filename: 'Batman.sid' });
        const isPsid = player instanceof PsidPlayer;
        const fmt = player.format;
        const playingBeforePlay = player.isPlaying;

        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        let nonZero = 0;
        const unsub = player.onChannels((data) => {
          for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > 0.0005) nonZero++;
          }
        });

        player.play();
        await new Promise((r) => setTimeout(r, 400));

        unsub();
        await player.dispose();
        await factory.dispose();
        return { isPsid, fmt, playingBeforePlay, nonZero };
      },
      { b64, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(result.isPsid).toBe(true);
    expect(result.fmt).toBe('psid');
    // Confirms the paused-at-zero contract.
    expect(result.playingBeforePlay).toBe(false);
    expect(result.nonZero).toBeGreaterThan(1000);
  });

  test('IMF bytes (with filename hint) → OplPlayer instance, audio flows', async ({ page }) => {
    const b64 = await readB64('imf/data/01 - Robo Red Rock.imf');
    const result = await page.evaluate(
      async ({ b64, urls }) => {
        const { CawtoothPlayer, OplPlayer } = window.cawtooth;
        const factory = await CawtoothPlayer.init({
          formats: {
            opl: { workletUrl: urls.oplWorklet, wasmUrl: urls.oplWasm },
            psid: { workletUrl: urls.psidWorklet, wasmUrl: urls.sidplayWasm },
          },
        });
        const bytes = window.b64ToBytes(b64);
        // IMF has no magic — filename hint is required.
        const player = await factory.load(bytes, {
          filename: '01 - Robo Red Rock.imf',
          tickRate: 700,
        });
        const isOpl = player instanceof OplPlayer;
        const info = { ...player.info };

        player.output.connect(player.audioContext.destination);
        await player.resumeAudio();

        let nonZero = 0;
        const unsub = player.onChannels((data) => {
          for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > 0.0005) nonZero++;
          }
        });

        player.play();
        await new Promise((r) => setTimeout(r, 500));

        unsub();
        await player.dispose();
        await factory.dispose();
        return { isOpl, info, nonZero };
      },
      { b64, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(result.isOpl).toBe(true);
    expect(result.info.format).toBe('opl');
    if (result.info.format === 'opl') {
      expect(result.info.container).toBe('imf');
      expect(result.info.tickRate).toBe(700);
      expect(result.info.events).toBeGreaterThan(100);
    }
    expect(result.nonZero).toBeGreaterThan(1000);
  });

  test('DRO bytes → OplPlayer (auto-detected via DBRAWOPL magic)', async ({ page }) => {
    const b64 = await readB64('dro/data/hard_nova_out_6.dro');
    const result = await page.evaluate(
      async ({ b64, urls }) => {
        const { CawtoothPlayer, OplPlayer } = window.cawtooth;
        const factory = await CawtoothPlayer.init({
          formats: {
            opl: { workletUrl: urls.oplWorklet, wasmUrl: urls.oplWasm },
          },
        });
        const bytes = window.b64ToBytes(b64);
        // No filename — sniffing alone must identify DRO.
        const player = await factory.load(bytes);
        const isOpl = player instanceof OplPlayer;
        const info = { ...player.info };
        await player.dispose();
        await factory.dispose();
        return { isOpl, info };
      },
      { b64, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(result.isOpl).toBe(true);
    expect(result.info.format).toBe('opl');
    if (result.info.format === 'opl') {
      expect(result.info.container).toBe('dro');
      expect(['v1', 'v2']).toContain(result.info.variant);
    }
  });

  test('HSQ bytes → OplPlayer (auto-detected as HERAD via checksum)', async ({ page }) => {
    const b64 = await readB64('herad/data/SAVAGE.HSQ');
    const result = await page.evaluate(
      async ({ b64, urls }) => {
        const { CawtoothPlayer, OplPlayer } = window.cawtooth;
        const factory = await CawtoothPlayer.init({
          formats: {
            opl: { workletUrl: urls.oplWorklet, wasmUrl: urls.oplWasm },
          },
        });
        const bytes = window.b64ToBytes(b64);
        const player = await factory.load(bytes);
        const isOpl = player instanceof OplPlayer;
        const info = { ...player.info };
        await player.dispose();
        await factory.dispose();
        return { isOpl, info };
      },
      { b64, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(result.isOpl).toBe(true);
    expect(result.info.format).toBe('opl');
    if (result.info.format === 'opl') {
      expect(result.info.container).toBe('herad');
    }
  });

  test('throws a clear error when a needed format config is missing', async ({ page }) => {
    const b64 = await readB64('sid/data/Batman_the_Movie.sid');
    const error = await page.evaluate(
      async ({ b64, urls }) => {
        const { CawtoothPlayer } = window.cawtooth;
        // Only configure OPL — loading PSID bytes should fail predictably.
        const factory = await CawtoothPlayer.init({
          formats: { opl: { workletUrl: urls.oplWorklet, wasmUrl: urls.oplWasm } },
        });
        try {
          const bytes = window.b64ToBytes(b64);
          await factory.load(bytes);
          await factory.dispose();
          return null;
        } catch (err) {
          await factory.dispose();
          return err instanceof Error ? err.message : String(err);
        }
      },
      { b64, urls: await page.evaluate(() => window.cawtoothUrls) },
    );

    expect(error).not.toBeNull();
    expect(error).toMatch(/psid/);
  });
});
