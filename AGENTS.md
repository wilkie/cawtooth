# Agent operating notes

Instructions for AI agents (Claude Code, etc.) and contributors working on
this repo. Read once at the start of a session; come back when starting
work that touches one of the trigger conditions below.

## When you add a new format, you MUST also update the docs

A format is "added" the moment any of the following lands in code:

- a new parser (`packages/core/src/formats/<name>/parser.ts`)
- a new chip emulator vendored under `tools/<name>/`
- a new entry in `detectFormat()` (`packages/core/src/audio/cawtooth-player.ts`)
- a new `cawtooth/worklet/<name>` or `cawtooth/wasm/<name>.wasm` export

When that happens, the same change set must include:

### 1. README.md — "Supported Formats" entry

Add a bullet under `## Supported Formats` describing the format in one
or two sentences. Mention the chip family, the original platform/games,
and any common file extensions (so users searching for `.vtx` or `.ay`
can find us). Match the prose style of the existing bullets — friendly,
slightly historical, no marketing.

### 2. README.md — "Acknowledgements" addition

If the format brings in a new vendored library (chip emulator, CPU
emulator, decompressor, reference player), add it under
`## Acknowledgements` with attribution and a link. Group it with the
existing categories ("Vendored emulator sources", "Build toolchain",
"Reference / cross-check material"). If the format only adds a parser
and reuses an existing chip, no acknowledgement is needed.

### 3. `docs/formats/<name>.md` — full format reference

Create `docs/formats/<name>.md` following the established structure
(see `dro.md`, `imf.md`, `herad.md` as references). Required sections:

- **What it is** — historical origin, motivating games/platforms, why
  the format exists. One or two paragraphs.
- **Binary structure** — every byte. Header layout as a fixed-width
  table; per-event encoding; any compression wrapper. The reader should
  be able to write a parser from this section alone.
- **Quirks / gotchas / variants** — section name varies (e.g. "Tick
  rates" for IMF, "Hardware-type ambiguity" for DRO, "SQX compression"
  for HERAD). One per significant footgun.
- **Our implementation** — what we parse and play correctly, what we
  deliberately skip, and what's known-broken. Be specific: "supports
  variants A and B; rejects variant C; handles the trailing-metadata
  block but not the optional checksum field."
- **References** — links to format wikis, original tooling, reference
  decoders.
- **Maintainer notes** — anything a future contributor needs to know
  before touching the parser. A/B test sources, tricky test fixtures,
  past bugs that informed current code shape.

The "Our implementation" section is the load-bearing one — it tells
users what they can rely on and what they shouldn't.

### 4. README.md — "Examples" / new demo

If the format ships with its own browser demo under `examples/<name>`,
that demo's purpose should be discoverable from the main README's
existing demo enumeration (currently inside the Development section).
Add it to the demo list comment (`# …also: dro, herad, …`).

## Other things that drift if not maintained

- **`tools/versions.sh`**: when you vendor a new emulator or bump a
  pinned commit, record the SHA there so reproducible rebuilds work
  from a fresh clone.
- **`packages/core/package.json` `exports`**: each new worklet bundle
  needs a `./worklet/<name>` entry; each new wasm module needs a
  `./wasm/<file>.wasm` entry. The pattern is uniform — match the
  existing entries exactly.
- **`tests/specs/`**: a new player class warrants at least one e2e
  spec covering its low-level register-write surface (mirrors
  `opl-player.spec.ts`'s `writeRegisters produces audible audio`
  test). High-level format playback gets its own spec when format
  parsers land.

## What you do NOT need to update

- CHANGELOG.md (doesn't exist yet — when it does, this list moves)
- API docs (the in-source TSDoc is the source of truth)
- Per-example READMEs (the demos are read by running them)

## Operating reminder

When a session adds a format, treat the README + `docs/formats/<name>.md`
update as part of the same task, not a follow-up. Documentation written
weeks after the code is uniformly worse than documentation written while
the implementation is still fresh.
