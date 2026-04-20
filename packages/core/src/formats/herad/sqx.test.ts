import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { decompressSqx, isSqx, readSqxHeader } from './sqx.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('SQX header detection', () => {
  it('rejects short input', () => {
    expect(isSqx(new Uint8Array(3))).toBe(false);
  });

  it('rejects flag bytes out of range', () => {
    const bytes = new Uint8Array([0x10, 0x00, 3, 0, 1, 4]);
    expect(isSqx(bytes)).toBe(false);
  });

  it('rejects bit count of 0 or >15', () => {
    const bytes = new Uint8Array([0x10, 0x00, 0, 1, 2, 0]);
    expect(isSqx(bytes)).toBe(false);
    bytes[5] = 16;
    expect(isSqx(bytes)).toBe(false);
    bytes[5] = 15;
    expect(isSqx(bytes)).toBe(true);
  });

  it('readSqxHeader parses the three op codes and the long-ref bit count', () => {
    // GORBI2.SQX actual bytes.
    const bytes = new Uint8Array([0xcd, 0xa1, 0x01, 0x00, 0x02, 0x03]);
    const header = readSqxHeader(bytes);
    expect(header.op0).toBe(1);
    expect(header.op10).toBe(0);
    expect(header.op11).toBe(2);
    expect(header.longRefBits).toBe(3);
  });
});

describe('SQX decompression — real files', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, '../../../../../examples/hsq/data');

  it('decompresses GORBI2.SQX into plausible HERAD bytes', async () => {
    const path = resolve(dataDir, 'GORBI2.SQX');
    if (!(await fileExists(path))) {
      console.warn('[sqx test] skipping GORBI2.SQX — not present');
      return;
    }
    const bytes = new Uint8Array(await readFile(path));
    expect(isSqx(bytes)).toBe(true);
    const out = decompressSqx(bytes);

    // HERAD structural invariants. iInstOffset is the u16 at offset 0 —
    // must be non-zero and fit inside the output.
    const instOffset = out[0] | (out[1] << 8);
    expect(instOffset).toBeGreaterThan(0);
    expect(instOffset).toBeLessThanOrEqual(out.length);

    // First track offset at bytes 2..3 must be 0x32 (OPL2) or 0x52 (AGD).
    const firstTrack = out[2] | (out[3] << 8);
    expect(firstTrack === 0x32 || firstTrack === 0x52).toBe(true);

    // Instrument bank size should fit at least one full instrument (AdPlug
    // and our parser both tolerate a few trailing pad bytes past that).
    const bankSize = out.length - instOffset;
    expect(bankSize).toBeGreaterThanOrEqual(40);

    // Byte distribution sanity — catches "right size, wrong content".
    const unique = new Set(out).size;
    expect(unique).toBeGreaterThan(16);
  });

  it('parseHerad auto-dispatches SQX compression to a usable HeradSong', async () => {
    const path = resolve(dataDir, 'GORBI2.SQX');
    if (!(await fileExists(path))) {
      console.warn('[sqx test] skipping GORBI2.SQX — not present');
      return;
    }
    const { parseHerad } = await import('./parser.js');
    const bytes = new Uint8Array(await readFile(path));
    const song = parseHerad(bytes);
    expect(song.tracks.length).toBeGreaterThan(0);
    expect(song.instruments.length).toBeGreaterThan(0);
    expect(song.speed).toBeGreaterThan(0);
  });
});
