import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { parseAsc } from './asc-parser.js';
import { ASC_TICK_RATE, parseAscToAySong, renderAsc } from './asc-render.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('renderAsc', () => {
  it('renders the user-supplied POPSA file into a register stream', async () => {
    const path = resolve(HERE, '../../../../../examples/ay/data/Dreamer - POPSA-2 (1994).asc');
    const bytes = new Uint8Array(await readFile(path));
    const module = parseAsc(bytes);

    expect(module.title).toBe('POPSA HALF TWO');
    expect(module.tempo).toBe(6);
    expect(module.positions.length).toBeGreaterThan(0);

    const result = renderAsc(module);

    expect(result.tickRate).toBe(ASC_TICK_RATE);
    expect(result.totalTicks).toBeGreaterThan(0);
    expect(result.stream.regs.length).toBeGreaterThan(0);
    expect(result.stream.regs.length).toBe(result.stream.values.length);
    expect(result.stream.regs.length).toBe(result.stream.delayTicks.length);

    // The sum of per-event delays should equal the total tick count, so
    // playback timing exactly matches the rendered duration.
    let sumDelays = 0;
    for (let i = 0; i < result.stream.delayTicks.length; i++) {
      sumDelays += result.stream.delayTicks[i];
    }
    expect(sumDelays).toBe(result.totalTicks);

    // Every register index must be in the AY's 14-register space.
    for (let i = 0; i < result.stream.regs.length; i++) {
      expect(result.stream.regs[i]).toBeGreaterThanOrEqual(0);
      expect(result.stream.regs[i]).toBeLessThan(14);
    }

    // 6 ticks/row × 64 rows × 41 positions = 15744 ticks for the POPSA
    // file (nothing changes the tempo). Sanity-check we're in the right
    // ballpark; tempo overrides via 0xF4 commands could shift this.
    expect(result.totalTicks).toBeGreaterThan(10_000);
    expect(result.totalTicks).toBeLessThan(20_000);
  });

  it('parseAscToAySong wraps render output in an AySong', async () => {
    const path = resolve(HERE, '../../../../../examples/ay/data/Dreamer - POPSA-2 (1994).asc');
    const bytes = new Uint8Array(await readFile(path));

    const song = parseAscToAySong(bytes);

    expect(song.container).toBe('asc');
    expect(song.tickRate).toBe(50);
    expect(song.model).toBe('AY-3-8910');
    expect(song.title).toBe('POPSA HALF TWO');
    expect(song.author).toContain('MURENKO');
    expect(song.loop).toBe(true);
    expect(song.stream.regs.length).toBeGreaterThan(0);
  });
});
