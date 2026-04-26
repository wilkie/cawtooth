import { test, expect } from '@playwright/test';

test.describe('harness', () => {
  test('exposes cawtooth + URLs on window', async ({ page }) => {
    await page.goto('/');

    // Wait for the harness module to settle (we set #ready text from
    // harness.ts after assigning the globals).
    await expect(page.locator('#ready')).toHaveText('ready');

    const probe = await page.evaluate(() => {
      return {
        hasCawtooth: typeof window.cawtooth === 'object',
        hasFactory: typeof window.cawtooth?.CawtoothPlayer === 'function',
        hasUrls: typeof window.cawtoothUrls === 'object',
        oplWorklet: window.cawtoothUrls.oplWorklet,
        psidWorklet: window.cawtoothUrls.psidWorklet,
        oplWasm: window.cawtoothUrls.oplWasm,
        sidplayWasm: window.cawtoothUrls.sidplayWasm,
      };
    });

    expect(probe.hasCawtooth).toBe(true);
    expect(probe.hasFactory).toBe(true);
    expect(probe.hasUrls).toBe(true);
    // URLs are vite-fingerprinted; just check they're non-empty strings.
    expect(probe.oplWorklet).toMatch(/\.js/);
    expect(probe.psidWorklet).toMatch(/\.js/);
    expect(probe.oplWasm).toMatch(/\.wasm/);
    expect(probe.sidplayWasm).toMatch(/\.wasm/);
  });
});
