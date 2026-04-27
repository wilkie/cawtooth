import { detectFormat } from './cawtooth-player.js';

describe('detectFormat', () => {
  it('identifies PSID by its 4-byte ASCII magic', () => {
    const bytes = new Uint8Array([0x50, 0x53, 0x49, 0x44, 0, 0, 0, 0]);
    expect(detectFormat(bytes)).toBe('psid');
  });

  it('identifies RSID and collapses it to the same psid bucket', () => {
    // RSID files are sniffed identically to PSID — same parser, same player.
    // The factory's `load()` only needs to know which player class to use.
    const bytes = new Uint8Array([0x52, 0x53, 0x49, 0x44, 0, 0, 0, 0]);
    expect(detectFormat(bytes)).toBe('psid');
  });

  it('identifies DRO by its DBRAWOPL magic', () => {
    const bytes = new Uint8Array([0x44, 0x42, 0x52, 0x41, 0x57, 0x4f, 0x50, 0x4c, 0, 0]);
    expect(detectFormat(bytes)).toBe('dro');
  });

  it('identifies HSQ-compressed HERAD by header checksum', () => {
    // HSQ header: u16 LE decompressed size, u8 zero, u16 LE compressed size,
    // u8 checksum so all six bytes sum to 0xAB. Pick arbitrary plausible
    // values and complete the checksum.
    const decompressedSize = 0x100;
    const compressedSize = 0x40;
    const header = new Uint8Array(6);
    header[0] = decompressedSize & 0xff;
    header[1] = (decompressedSize >> 8) & 0xff;
    header[2] = 0x00;
    header[3] = compressedSize & 0xff;
    header[4] = (compressedSize >> 8) & 0xff;
    let sum = 0;
    for (let i = 0; i < 5; i++) sum += header[i];
    header[5] = (0xab - sum) & 0xff;
    expect(detectFormat(header)).toBe('herad');
  });

  it('falls back to filename extension for IMF (no magic)', () => {
    // Type-0 IMF: just events, no header. There's nothing in the bytes
    // to sniff, so the filename hint is what disambiguates.
    const bytes = new Uint8Array([0xa0, 0x40, 0x10, 0x00]);
    expect(detectFormat(bytes, 'tune.imf')).toBe('imf');
    expect(detectFormat(bytes, 'tune.wlf')).toBe('imf');
    expect(detectFormat(bytes, 'tune.ims')).toBe('imf');
  });

  it('strips path prefixes from filename hints', () => {
    const bytes = new Uint8Array([0xa0, 0x40, 0x10, 0x00]);
    expect(detectFormat(bytes, '/some/path/tune.imf')).toBe('imf');
    expect(detectFormat(bytes, 'C:\\Music\\tune.imf')).toBe('imf');
  });

  it('throws when nothing matches and no filename hint is given', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(() => detectFormat(bytes)).toThrow(/could not detect format/);
  });

  it('mentions the filename in the error when one was provided', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(() => detectFormat(bytes, 'mystery.bin')).toThrow(/mystery\.bin/);
  });

  it('identifies PSG by its 4-byte ASCII magic', () => {
    const bytes = new Uint8Array([0x50, 0x53, 0x47, 0x1a, 0, 0, 0, 0]);
    expect(detectFormat(bytes)).toBe('psg');
  });

  it('identifies raw YM5/YM6 by their uppercase magic', () => {
    expect(detectFormat(new Uint8Array([0x59, 0x4d, 0x35, 0x21]))).toBe('ym');
    expect(detectFormat(new Uint8Array([0x59, 0x4d, 0x36, 0x21]))).toBe('ym');
  });

  it('identifies LHA-wrapped YM by the "-lh5-" method tag plus .ym filename hint', () => {
    // Header byte 0 = headerSize, byte 1 = checksum, then "-lh5-".
    const bytes = new Uint8Array([0x16, 0x00, 0x2d, 0x6c, 0x68, 0x35, 0x2d, 0x00]);
    expect(detectFormat(bytes, 'tune.ym')).toBe('ym');
  });

  it('does NOT classify a bare LHA archive as YM without a filename hint', () => {
    // Same "-lh5-" header but no .ym extension — could be any LHA file,
    // so the sniffer should fall through and ultimately throw.
    const bytes = new Uint8Array([0x16, 0x00, 0x2d, 0x6c, 0x68, 0x35, 0x2d, 0x00]);
    expect(() => detectFormat(bytes)).toThrow(/could not detect/);
  });

  it('identifies VTX by its lowercase 2-byte magic ("ay" or "ym")', () => {
    expect(detectFormat(new Uint8Array([0x61, 0x79, 1, 0, 0, 0, 0, 0]))).toBe('vtx');
    expect(detectFormat(new Uint8Array([0x79, 0x6d, 1, 0, 0, 0, 0, 0]))).toBe('vtx');
  });

  it('falls back to filename extension for the AY family', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectFormat(bytes, 'tune.psg')).toBe('psg');
    expect(detectFormat(bytes, 'tune.vtx')).toBe('vtx');
    expect(detectFormat(bytes, 'tune.ym')).toBe('ym');
  });
});
