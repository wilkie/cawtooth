import { defineConfig, devices } from '@playwright/test';

const HARNESS_URL = 'http://127.0.0.1:5190';

/**
 * Chromium-only by default. Audio worklet behavior is consistent enough
 * across engines that one is plenty for catching regressions; running
 * Firefox/WebKit too is straightforward (add to `projects`) but trades
 * speed for marginal coverage. Revisit if browser-specific bugs show up.
 *
 * `--autoplay-policy=no-user-gesture-required` lets `AudioContext` start
 * without a user click; otherwise we'd need to drive a real click in
 * every test before any audio could play.
 */
export default defineConfig({
  testDir: './specs',
  // Each test may wait up to ~1.5 s for audio to fill ring buffers and
  // for progress events to arrive. Keep the per-test cap generous.
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  // Run tests sequentially. Audio worklets are heavy; running in parallel
  // can starve the CPU and cause flaky audio capture. Single-worker is
  // fast enough for a sub-suite of this size.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: HARNESS_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            // Headless Chromium needs a software audio backend; the
            // default null device records nothing and some worklet code
            // paths short-circuit when no real sink is present.
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'pnpm harness:dev',
    url: HARNESS_URL,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  },
});
