# HSQ (HERAD compression)

> **Status: Phase A.** This document covers the _compression layer_ only — turning an HSQ file into its decompressed HERAD payload. Parsing that payload (patterns, instruments, events) is a separate concern and will be documented in a companion file when the HERAD format parser lands.

## What it is

HSQ is the LZSS-variant compression scheme Cryo Interactive used for music files shipped with their HERAD audio engine. HERAD (_Herbulot Adlib_) was written by Stéphane Herbulot and powered music in Cryo's game catalogue from Dune (1992) through Atlantis (1997) and beyond.

The same compression scheme underlies several file extensions:

| Ext    | Meaning                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.HSQ` | HERAD v1 compressed music — OPL2 / AdLib.                                                                                                            |
| `.AGD` | HERAD compressed music targeted at AdLib Gold (uses OPL3 features).                                                                                  |
| `.HA2` | HERAD v2 compressed music. On-disk bytes are identical to `.HSQ`; the extension flags that the decompressed payload should be parsed under v2 rules. |
| `.SQX` | A newer Cryo compression variant with different LZ parameters. Not handled here.                                                                     |

All of HSQ / AGD / HA2 are compressed with the same codec, and our decompressor handles all three.

## Binary structure

### Header (6 bytes)

```
offset   size   field
  0       2     Decompressed size (u16 LE) — bytes of output to produce
  2       1     Always 0x00 in captures we've seen
  3       2     Compressed size (u16 LE) — INCLUDING this header, so == fileSize
  5       1     Checksum byte, chosen so the sum of all 6 bytes mod 256 == 0xAB
```

The checksum is both a format marker and an integrity check. The probability of a random 6-byte tail summing to exactly `0xAB` is 1/256, so in practice the checksum is a reliable "is this an HSQ file?" signal regardless of extension.

### Data stream

A variable-length encoding of literal bytes and back-references, controlled by a 16-bit **queue** of compression flags. Queue bits are consumed LSB-first; when drained, the next 2 bytes of input are read as a fresh u16 LE queue.

For each output operation:

1. Consume one queue bit.
   - **`1` → literal.** Copy one byte from the input to the output.
   - **`0` → reference.** Consume another queue bit to pick the sub-form:
     - **`1` → long reference.** Read 2 input bytes as a u16 LE, call it `packed`:
       - `offset = (packed >> 3) - 8192` — in range `[-8192, -1]`.
       - `length = packed & 0x07`.
       - If `length == 0`: read one more input byte as an explicit length. A byte of `0` here marks **end-of-stream**.
       - `length += 2`.
     - **`0` → short reference.** Consume 2 more queue bits as `length = (hi << 1) | lo`, then read 1 input byte:
       - `offset = inputByte - 256` — in range `[-256, -1]`.
       - `length += 2`.
   - Copy `length` bytes from `output[outPos + offset]` to `output[outPos]`, advancing `outPos` each step. The source range may overlap the destination — that's how HSQ encodes a repeating-byte run.

The stream terminates on the long-reference escape sentinel (`length = 0; nextByte = 0`). Our decompressor additionally rejects streams that end without filling the declared decompressed size.

### Sentinel-bit queue trick

The reference AdPlug implementation uses a clever 17-bit queue trick: after loading the 16-bit queue from input, it OR's in `0x10000`. Each `queue >>= 1` shifts that sentinel bit closer to the LSB. When `queue == 1`, it means "only the sentinel is left, all 16 real bits consumed" — time to refill. Starting the queue at `1` forces the initial refill on the first call.

Our implementation uses the same trick. It's equivalent to a separate bit-counter but has one fewer mutable variable.

## Our implementation

- Module: [`packages/core/src/formats/hsq/decompress.ts`](../../packages/core/src/formats/hsq/decompress.ts)
- Tests: [`packages/core/src/formats/hsq/decompress.test.ts`](../../packages/core/src/formats/hsq/decompress.test.ts)
- Exports: `readHsqHeader`, `isHsq`, `decompressHsq`.

### Validation strategy

Hand-crafted fixtures cover the literal-only path (easy to encode) and the header checksum. Real-file validation runs against Cryo game data dropped into `examples/hsq/data/` — `SAVAGE.HSQ`, `WORMINTR.HSQ`, `WORMINTR.AGD`, `ALARME.HSQ`, `ALARME.HA2`. Those tests assert:

- The 6-byte header checksum equals `0xAB`.
- `header.compressedSize == fileSize`.
- Decompression produces exactly `header.decompressedSize` bytes.
- The output is non-trivial (byte-distribution sanity check) — catches the degenerate "correct size, wrong bytes" failure mode.
- `ALARME.HSQ` and `ALARME.HA2` decompress to byte-identical output, confirming the extension is purely a parser-side hint.

The real-file tests skip (with a warning) when the files aren't present, so the suite stays green for anyone cloning without the game data.

### Example

```ts
import { decompressHsq, isHsq, readHsqHeader } from 'cawtooth';

const bytes = new Uint8Array(await (await fetch('WORMINTR.HSQ')).arrayBuffer());

if (!isHsq(bytes)) {
  throw new Error('Not an HSQ-compressed file');
}

const header = readHsqHeader(bytes);
console.log(`${header.compressedSize} → ${header.decompressedSize} bytes`);

const payload = decompressHsq(bytes);
// payload is now raw HERAD data ready for the HERAD parser (Phase B).
```

## References

- [AdPlug](https://github.com/adplug/adplug) — `src/herad.cpp` contains the reference `HSQ_decompress`. The canonical implementation and what we matched ours against.
- [ModdingWiki: HERAD](https://moddingwiki.shikadi.net/wiki/HERAD) — community spec for both the compression and the format; written up by people who reverse-engineered the engine.

## Maintainer notes

Update this document when:

- The decompression function changes behaviour (end-of-stream handling, truncated-input semantics, reference-copy semantics for overlapping ranges).
- A new sample file uncovers a variant we need to handle specially.
- SQX support is added — it's a related but distinct compression; likely gets its own file rather than expanding this one.

If the description here diverges from `decompress.ts`, the code is the source of truth and the doc is the bug.
