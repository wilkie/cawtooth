import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { decompressHsq, isHsq, readHsqHeader } from './hsq.js';

/**
 * Build a minimal valid HSQ file from a literal payload. Every byte in
 * `literals` is emitted as a one-literal code. Useful for testing the header
 * + literal-only path without having to hand-encode references.
 */
function buildHsqAllLiterals(literals: number[]): Uint8Array {
  // Each literal = 1 queue bit (=1) + 1 payload byte.
  // Queue is 16 bits at a time. Pack all literal bits as LSB-first.
  // After all literals, end-of-stream: 0-bit, 1-bit (long ref), then
  // bytes to encode length_field=0 then explicit-length=0.

  // Build bit stream: each literal contributes a '1' bit.
  // Then the terminator: '0' (reference), '1' (long).
  const bits: number[] = [];
  for (let i = 0; i < literals.length; i++) bits.push(1);
  bits.push(0, 1); // long ref
  // Pad queue bits so the queue boundary aligns; pack 16 bits per queue word.
  // We'll emit queue words interleaved with payload in the right order below.

  // Strategy: pack bits into u16 queue words in order. When the decoder
  // needs a bit, it pulls the next one from the queue. We interleave payload
  // bytes between queue words in the same order they'd be consumed.

  // Simpler: just produce the compressed stream by simulating what the
  // decoder expects.
  const data: number[] = [];
  let queue = 0;
  let queueBits = 0;
  const queuePositions: number[] = []; // byte positions reserved for each queue word

  function pushBit(b: number): void {
    if (queueBits === 0) {
      // Reserve two bytes for the upcoming queue word.
      queuePositions.push(data.length);
      data.push(0, 0);
    }
    queue |= (b & 1) << queueBits;
    queueBits++;
    if (queueBits === 16) {
      const pos = queuePositions[queuePositions.length - 1];
      data[pos] = queue & 0xff;
      data[pos + 1] = (queue >> 8) & 0xff;
      queue = 0;
      queueBits = 0;
    }
  }

  function flushQueue(): void {
    if (queueBits > 0) {
      const pos = queuePositions[queuePositions.length - 1];
      data[pos] = queue & 0xff;
      data[pos + 1] = (queue >> 8) & 0xff;
      queue = 0;
      queueBits = 0;
    }
  }

  function pushByte(b: number): void {
    data.push(b & 0xff);
  }

  // Literals
  for (const lit of literals) {
    pushBit(1);
    pushByte(lit);
  }
  // Terminator: '0' (reference), '1' (long), then length-field-byte=0, explicit-length=0
  pushBit(0);
  pushBit(1);
  // For a long ref, the decoder reads 2 bytes (b1, b2) from input. We need
  // b2 & 0x07 = 0 so it falls into the explicit-length path. Any b1 is fine;
  // offset doesn't matter because explicit-length=0 ends the stream.
  pushByte(0x00); // b1
  pushByte(0x00); // b2 (length field bits = 0 → read explicit byte)
  pushByte(0x00); // explicit length = 0 → end of stream

  flushQueue();

  // Prefix header.
  const compressedSize = data.length + 6;
  const decompressedSize = literals.length;
  const header = new Uint8Array(6);
  header[0] = decompressedSize & 0xff;
  header[1] = (decompressedSize >> 8) & 0xff;
  header[2] = 0;
  header[3] = compressedSize & 0xff;
  header[4] = (compressedSize >> 8) & 0xff;
  // Choose byte 5 so the six-byte sum mod 256 = 0xAB.
  let s = 0;
  for (let i = 0; i < 5; i++) s += header[i];
  header[5] = (0xab - s) & 0xff;

  const out = new Uint8Array(6 + data.length);
  out.set(header, 0);
  out.set(data, 6);
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('HSQ header', () => {
  it('accepts a valid checksum', () => {
    const bytes = buildHsqAllLiterals([0x41, 0x42, 0x43]);
    const header = readHsqHeader(bytes);
    expect(header.decompressedSize).toBe(3);
    // compressedSize is the full file length including the 6-byte header.
    expect(header.compressedSize).toBe(bytes.length);
  });

  it('rejects a short input', () => {
    expect(() => readHsqHeader(new Uint8Array(3))).toThrow(/too short/);
  });

  it('rejects a bad checksum', () => {
    const bytes = buildHsqAllLiterals([0x41]);
    bytes[5] ^= 1; // corrupt the checksum byte
    expect(() => readHsqHeader(bytes)).toThrow(/checksum/);
  });

  it('isHsq detects the checksum without throwing', () => {
    const bytes = buildHsqAllLiterals([0x41]);
    expect(isHsq(bytes)).toBe(true);
    bytes[5] ^= 0xff;
    expect(isHsq(bytes)).toBe(false);
  });
});

describe('HSQ decompression', () => {
  it('round-trips an all-literal stream', () => {
    const payload = [0x41, 0x42, 0x43, 0x44, 0x45];
    const compressed = buildHsqAllLiterals(payload);
    const out = decompressHsq(compressed);
    expect(Array.from(out)).toEqual(payload);
  });

  it('produces the exact size declared by the header', () => {
    const payload = Array.from({ length: 40 }, (_, i) => (i * 7) & 0xff);
    const compressed = buildHsqAllLiterals(payload);
    const out = decompressHsq(compressed);
    expect(out.length).toBe(payload.length);
  });
});

/*
 * Integration tests — run against real files dropped into examples/hsq/data/.
 * These files are not checked into the repo (game data from Cryo titles), so
 * the tests skip when the files aren't present. When they ARE present, they
 * exercise the decompressor against content no hand-crafted fixture can.
 */
describe('HSQ decompression — real files', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, '../../../../../examples/hsq/data');

  // Expected sizes are what the file's own 6-byte header declares; we verify
  // the decompressor produces exactly that many bytes.
  const samples = [
    { file: 'SAVAGE.HSQ', expectedDecompressedSize: 44257 },
    { file: 'WORMINTR.HSQ', expectedDecompressedSize: 25956 },
    { file: 'WORMINTR.AGD', expectedDecompressedSize: 23793 },
    { file: 'ALARME.HSQ', expectedDecompressedSize: 41334 },
  ];

  for (const sample of samples) {
    it(`decompresses ${sample.file} to ${sample.expectedDecompressedSize} bytes`, async () => {
      const path = resolve(dataDir, sample.file);
      if (!(await fileExists(path))) {
        console.warn(`[hsq test] skipping ${sample.file} — not present in ${dataDir}`);
        return;
      }
      const bytes = new Uint8Array(await readFile(path));
      expect(isHsq(bytes)).toBe(true);
      const header = readHsqHeader(bytes);
      expect(header.compressedSize).toBe(bytes.length);
      expect(header.decompressedSize).toBe(sample.expectedDecompressedSize);

      const out = decompressHsq(bytes);
      expect(out.length).toBe(sample.expectedDecompressedSize);

      // Content sanity: a correctly decompressed HERAD file has meaningful
      // structure — not all zeros, not trivially repeating, with a
      // distribution of byte values. Catches regressions where the decoder
      // hits the expected size but emits wrong bytes.
      const nonZero = out.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0);
      expect(nonZero).toBeGreaterThan(out.length * 0.1);
      const unique = new Set(out).size;
      expect(unique).toBeGreaterThan(16);
    });
  }

  it('ALARME.HSQ and ALARME.HA2 decompress to identical bytes (same payload, different extension)', async () => {
    const hsqPath = resolve(dataDir, 'ALARME.HSQ');
    const ha2Path = resolve(dataDir, 'ALARME.HA2');
    if (!(await fileExists(hsqPath)) || !(await fileExists(ha2Path))) {
      console.warn('[hsq test] skipping ALARME pair — files not present');
      return;
    }
    const a = decompressHsq(new Uint8Array(await readFile(hsqPath)));
    const b = decompressHsq(new Uint8Array(await readFile(ha2Path)));
    expect(a.length).toBe(b.length);
    // Byte-for-byte identical — the .HA2 extension is just a v2-parsing hint.
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        throw new Error(`differ at byte ${i}: ${a[i]} vs ${b[i]}`);
      }
    }
  });
});
