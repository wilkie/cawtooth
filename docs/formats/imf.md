# IMF (Id Music Format)

## What it is

IMF is id Software's internal format for storing Adlib (Yamaha OPL2) music. It first appeared in commercial games around 1990–1991 (Commander Keen 4, shortly followed by Wolfenstein 3D) and was used through the mid-1990s by id's own games and by licensees — Apogee/3D Realms titles, Raven Software's shareware work, and various FormGen and Softdisk releases.

Conceptually, IMF is a register dump: each event is "write this byte to this OPL register, then wait this long." Playback is just a sequencer that walks the list and pokes the chip. There is no note abstraction, no channel concept, no instrument bank — whatever engine produced the IMF already resolved all of that into bare register writes.

## Binary structure

### Event shape

Every IMF file is a sequence of 4-byte events:

```
offset   size   field
  0       1     register number  (u8, 0x00–0xF5 on OPL2)
  1       1     value to write   (u8)
  2       2     delay in ticks   (u16 little-endian)
```

`delay` is the number of ticks to wait **after** writing this register before the next event fires. A delay of 0 means "next event immediately," which is common for bursts that logically happen together (programming a whole patch, triggering all operators of a voice).

### Type 0

The file IS the raw event stream. No header. Exactly `file_size / 4` events.

### Type 1

Prefixed with a 2-byte little-endian length field giving the size (in bytes) of the event stream. Optional metadata may follow.

```
offset   size   field
  0       2     event stream length in bytes (u16 LE)
  2       N     event stream (N / 4 events)
 2+N      *     optional trailing metadata
```

### Auto-detection

The variant is not recorded in the file. The common heuristic — and what our parser uses — is:

- If the first u16 LE is a positive multiple of 4 **and** `2 + declared_length` fits within the file, treat as type 1.
- Otherwise, treat as type 0.

A type-0 file whose first event happens to look like a plausible length can still fool this. The parser fails closed: if the declared length overruns the file, it falls back to type 0. Callers with ground truth can force a variant: `parseImf(bytes, { variant: 'type1' })`.

### Metadata (type 1, optional)

When there are bytes remaining after the event stream, id's Muse editor writes:

```
0x1A              marker byte (some encoders omit it)
title\0           null-terminated ASCII
source\0          composer or program name
remarks\0         free text
```

Our parser tolerates a missing marker and reads up to three null-terminated strings. Bytes are preserved as-is (codepoints 0–255), not UTF-8 decoded — original Muse output is CP437 and often contains high bytes that would otherwise throw.

## Tick rates (the critical external knowledge)

IMF does **not** record its own tick rate. Without it, the same file plays at vastly different speeds. The rate is game-specific:

| Game                        | Tick rate |
| --------------------------- | --------- |
| Commander Keen 4–6          | 560 Hz    |
| Bio Menace                  | 560 Hz    |
| Wolfenstein 3D              | 700 Hz    |
| Spear of Destiny            | 700 Hz    |
| Blake Stone: Aliens of Gold | 700 Hz    |
| Corridor 7                  | 700 Hz    |
| Operation Body Count        | 700 Hz    |
| Duke Nukem II               | 280 Hz    |

File extension is a weak hint:

- `.imf` — generic; rate unknown without context.
- `.wlf` — Wolfenstein 3D / Spear of Destiny (700 Hz).
- `.ims` — rare; seen in Apogee demos, no single rate.

When in doubt, 700 Hz is the most common guess, but the result is noticeably slow or fast when wrong. Players aimed at unknown files often expose a speed slider for exactly this reason.

## Quirks and gotchas seen in the wild

**Trailing partial events.** Some encoders pad file size to an odd boundary. A leftover byte or three that doesn't form a full event is harmless; we ignore it.

**Overstated type-1 headers.** Rare but present. Some Muse exports claim a longer event stream than they contain. Forcing `variant: 'type1'` clips to whatever actually fits.

**Initial silence events.** Many files start with `(reg=0, val=0, delay=N)` — a no-op write used purely to create a leading pause. The sequencer naturally generates silence during the delay, so this needs no special handling.

**Register 0 writes.** Some encoders use register 0 as a "do nothing" marker. Register 0 is the OPL test register — writes are harmless in practice but technically observable on real hardware.

**OPL2 vs OPL3.** Classic IMFs are OPL2 (registers 0x00–0xF5). The format can encode OPL3 writes by using register numbers in the high bank (0x100–0x1FF), but this is vanishingly rare — games that wanted OPL3 usually used a different format.

**Looping.** IMF has no loop-point marker. Some games loop the whole file; some play once. Our sequencer's `loop` flag handles the common "restart from the top when the stream ends" case. Games that needed mid-song loops typically pre-looped the event stream at authoring time.

## Our implementation

- Parser: [`packages/core/src/formats/imf/parser.ts`](../../packages/core/src/formats/imf/parser.ts)
- Tests: [`packages/core/src/formats/imf/parser.test.ts`](../../packages/core/src/formats/imf/parser.test.ts)
- Output shape: [`RegisterEventStream`](../../packages/core/src/sequencer/types.ts), the format-agnostic event stream consumed by `RegisterSequencer`.

### Example

```ts
import { OplPlayer, parseImf } from 'cawtooth';
import workletUrl from 'cawtooth/worklet?url';
import wasmUrl from 'cawtooth/wasm/nuked-opl3.wasm?url';

const player = await OplPlayer.create({ workletUrl, wasmUrl });
player.output.connect(player.audioContext.destination);
await player.resume();

const bytes = new Uint8Array(await (await fetch('WONDERIN.WLF')).arrayBuffer());
const song = parseImf(bytes);

// .WLF → Wolfenstein 3D → 700 Hz.
player.loadStream(song.stream, { tickRate: 700, loop: true });
player.play();

// Metadata is optional and may be undefined.
console.log(song.title, song.source, song.remarks);
```

For a working end-to-end demo (file input, tick-rate selector, loop toggle, metadata display), see [`examples/imf/`](../../examples/imf/).

#### Direct sequencer use (Node, offline rendering)

`RegisterSequencer` is also usable outside the worklet — handy for tests and for rendering a song to a file. It takes any `OplChip` implementation:

```ts
import {
  NukedOpl3Chip,
  RegisterSequencer,
  parseImf,
  instantiateNukedOpl3,
  compileNukedOpl3,
} from 'cawtooth';

const module = await compileNukedOpl3(wasmBytes);
const chip = new NukedOpl3Chip(await instantiateNukedOpl3(module), 48000);
const seq = new RegisterSequencer(chip);
seq.loadStream(parseImf(imfBytes).stream, { tickRate: 700 });
seq.play();

const output = new Float32Array(48000 * 2 * 5); // 5 seconds stereo
seq.generate(output);
```

### What the parser handles

- Type 0 and type 1 detection, with forced-variant override.
- Truncated or overstated type-1 lengths (clipped to what fits).
- Trailing partial events (ignored).
- Optional metadata (title, source, remarks), with or without the 0x1A marker.
- Non-ASCII bytes in metadata (preserved as raw codepoints).

### What it does not do

- **Tick-rate detection.** Not possible from the file alone; callers must supply `tickRate`.
- **Game-specific metadata conventions.** We read the three standard Muse fields only.
- **Loop-point discovery.** IMF has no such markers; use the sequencer's `loop` option for whole-file looping.

## References

- [ModdingWiki: IMF Format](https://moddingwiki.shikadi.net/wiki/IMF_Format) — the most thorough community reference, including the per-game tick-rate table this document draws from.
- [AdPlug](https://github.com/adplug/adplug) — the de facto reference C++ implementation; `src/imf.cpp` is a pragmatic comparison point.
- [Wolfenstein 3D source release](https://github.com/id-Software/wolf3d) — id's original playback code in `ID_SD.C` is the ground truth for the 700 Hz rate.

## Maintainer notes

Update this document when:

- The parser's detection heuristic, metadata handling, or error paths change.
- A new game or tick-rate variant is added to the table above.
- A quirk is discovered in the wild that required a parser adjustment.

If the description here diverges from parser behavior, the parser is the source of truth — but the divergence is a bug in the documentation and should be fixed here.
