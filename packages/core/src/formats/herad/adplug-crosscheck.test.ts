/**
 * Cross-check the TypeScript HERAD renderer against AdPlug's reference
 * implementation.
 *
 * For each real HERAD sample file in examples/herad/data/, we:
 *   1. Run our `renderHeradToStream` and normalise to (tick, reg, val).
 *   2. Shell out to tools/adplug-capture/capture-herad on the same file and
 *      read its TSV output.
 *   3. Compare. The expectation is multiset equality per tick — writes
 *      within a single tick may appear in different order (we process all
 *      voice slides before voice events; AdPlug interleaves them) but the
 *      MULTISET of (reg, val) pairs at each tick must match exactly.
 *
 * The tests skip (with a warning) when either the capture binary or the
 * game data files aren't available, so contributors without the capture
 * harness built can still run the suite.
 *
 * Tick budget: currently 100 ticks per file. All five sample files match
 * AdPlug exactly over this range. Widening to 1000 ticks surfaces
 * divergences on some files starting at tick ~384 or ~576 — those are
 * tracked as a follow-up and likely involve a subtle event-dispatch quirk
 * (possibly related to looping or measure boundaries).
 */

import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parseHerad } from './parser.js';
import { renderHeradToStream } from './render.js';
import type { HeradVariant } from './types.js';

const exec = promisify(execFile);

type Write = { reg: number; val: number };

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../../../../../examples/herad/data');
const captureBin = resolve(here, '../../../../../tools/adplug-capture/capture-herad');

interface Sample {
  file: string;
  /** Forced variant for OUR renderer (matches `parseHerad({variant})`). */
  variant?: HeradVariant;
  /**
   * Forced variant for ADPLUG via `capture-herad --v1|--v2`. Needed on a
   * couple of files where AdPlug's aggressive v2 detection mis-classifies
   * the file and produces a trace that doesn't match what the engine would
   * actually play on real hardware.
   */
  adplugForceVariant?: HeradVariant;
  /** Max ticks to compare. Long songs produce huge traces; we stop earlier. */
  tickBudget?: number;
}

const samples: Sample[] = [
  { file: 'WORMINTR.HSQ', tickBudget: 10000 },
  {
    // AdPlug's `validTracks()` heuristic mis-flags SAVAGE as v2. SAVAGE is
    // actually v1 — we force both sides to v1 for a fair comparison.
    file: 'SAVAGE.HSQ',
    adplugForceVariant: 'v1',
    tickBudget: 10000,
  },
  { file: 'WORMINTR.AGD', tickBudget: 10000 },
  { file: 'ALARME.HSQ', variant: 'v2', adplugForceVariant: 'v2', tickBudget: 10000 },
  { file: 'DETRITUS.HSQ', tickBudget: 10000 },
];

/**
 * Run our renderer and index writes by tick. Returns a map from tick
 * number to the multiset of writes that happen at that tick, truncated at
 * `tickBudget`.
 */
function indexOurs(fileBytes: Uint8Array, variant: HeradVariant | undefined, tickBudget: number) {
  const song = parseHerad(fileBytes, variant ? { variant } : {});
  const { stream } = renderHeradToStream(song);
  const byTick = new Map<number, Write[]>();
  let tick = 0;
  for (let i = 0; i < stream.regs.length; i++) {
    if (tick > tickBudget) break;
    if (!byTick.has(tick)) byTick.set(tick, []);
    byTick.get(tick)!.push({ reg: stream.regs[i], val: stream.values[i] });
    tick += stream.delayTicks[i];
  }
  return byTick;
}

async function indexAdplug(
  filePath: string,
  tickBudget: number,
  forceVariant: HeradVariant | undefined,
) {
  const args = forceVariant ? [`--${forceVariant}`, filePath] : [filePath];
  const { stdout } = await exec(captureBin, args, { maxBuffer: 32 * 1024 * 1024 });
  const byTick = new Map<number, Write[]>();
  for (const line of stdout.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [t, r, v] = line.split('\t');
    const tick = Number(t);
    if (tick > tickBudget) break;
    if (!byTick.has(tick)) byTick.set(tick, []);
    byTick.get(tick)!.push({ reg: Number(r), val: Number(v) });
  }
  return byTick;
}

/** Compare multisets of writes. Returns null if equal, or a description. */
function diffWrites(a: Write[], b: Write[]): string | null {
  if (a.length !== b.length) {
    return `count ${a.length} vs ${b.length}`;
  }
  // Build multiset keys and compare counts.
  const key = (w: Write) => `${w.reg}=${w.val}`;
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const w of a) countA.set(key(w), (countA.get(key(w)) ?? 0) + 1);
  for (const w of b) countB.set(key(w), (countB.get(key(w)) ?? 0) + 1);
  const allKeys = new Set([...countA.keys(), ...countB.keys()]);
  const diffs: string[] = [];
  for (const k of allKeys) {
    const ca = countA.get(k) ?? 0;
    const cb = countB.get(k) ?? 0;
    if (ca !== cb) diffs.push(`${k} ours=${ca} adplug=${cb}`);
  }
  return diffs.length ? diffs.join(', ') : null;
}

describe('HERAD renderer cross-check against AdPlug', () => {
  let captureAvailable = false;
  let dataAvailable = false;

  beforeAll(async () => {
    captureAvailable = await fileExists(captureBin);
    dataAvailable = await fileExists(dataDir);
    if (!captureAvailable) {
      console.warn(
        `[crosscheck] capture binary not found at ${captureBin} — ` +
          `build it with 'cd tools/adplug-capture && make' (requires libadplug-dev).`,
      );
    }
  });

  for (const sample of samples) {
    it(`matches AdPlug tick-for-tick: ${sample.file}`, async () => {
      if (!captureAvailable || !dataAvailable) return;
      const path = resolve(dataDir, sample.file);
      if (!(await fileExists(path))) {
        console.warn(`[crosscheck] skipping ${sample.file} — not present`);
        return;
      }

      const budget = sample.tickBudget ?? 1000;
      const bytes = new Uint8Array(await readFile(path));
      const ours = indexOurs(bytes, sample.variant, budget);
      const theirs = await indexAdplug(path, budget, sample.adplugForceVariant);

      // Collect the set of ticks that have any events in either stream.
      const allTicks = new Set<number>([...ours.keys(), ...theirs.keys()]);
      const divergences: Array<{ tick: number; detail: string }> = [];
      for (const tick of Array.from(allTicks).sort((a, b) => a - b)) {
        const a = ours.get(tick) ?? [];
        const b = theirs.get(tick) ?? [];
        const diff = diffWrites(a, b);
        if (diff) divergences.push({ tick, detail: diff });
      }

      if (divergences.length > 0) {
        const first = divergences.slice(0, 5);
        const msg = first.map((d) => `  tick ${d.tick}: ${d.detail}`).join('\n');
        const total = divergences.length;
        throw new Error(
          `${sample.file}: ${total} divergent tick(s) within first ${budget} ticks.\n` +
            `First ${first.length}:\n${msg}`,
        );
      }
    });
  }
});
