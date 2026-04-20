# capture-herad — AdPlug cross-check harness

A small C++ tool that loads a HERAD file through AdPlug's reference
implementation and dumps every OPL register write as TSV. Paired with
`packages/core/src/formats/herad/adplug-crosscheck.test.ts`, it lets us
verify — tick-for-tick — that our TypeScript HERAD renderer produces the
same output as AdPlug.

## Why this exists

The HERAD format isn't documented at the bit level by anyone. The
community reference is AdPlug, which itself was reverse-engineered by
Stas'M. Without a harness, we can't tell whether our implementation is
correct or just sounds close-enough. With the harness, "does our renderer
match the reference?" becomes a concrete, CI-automatable assertion.

The harness has already caught:

- An inverted-sign bug in the velocity-macro formula.
- An incorrect sensitivity range ([-4,4] is the valid window).
- An off-by-one in first-event tick timing (AdPlug's `+1` counter bump is
  an internal counting quirk, not a semantic delay we should mirror).

Any future change to the renderer should be re-validated with this
harness before shipping.

## Requirements

- **AdPlug 2.3.3.** The shipping Debian version (`libadplug-2.3.3-0`,
  package `libadplug-dev` for the headers). Other versions will likely
  work — there are no semantic changes on master as of this writing —
  but we've only validated 2.3.3.
- **libbinio** (AdPlug's file I/O library). `libbinio-dev` on Debian.
- **g++** or any C++17 compiler. The Makefile uses `pkg-config adplug`
  and the `$CXX` env var (defaults to `g++`).

On Debian / Ubuntu:

```bash
sudo apt install libadplug-dev libbinio-dev build-essential pkg-config
```

## Build

```bash
cd tools/adplug-capture
make
```

Produces `capture-herad` in the same directory. The binary is gitignored;
each contributor builds locally.

## Use

```bash
./capture-herad path/to/some.hsq > events.tsv
./capture-herad --v1 path/to/SAVAGE.HSQ > events.tsv  # force v1 variant
./capture-herad --v2 path/to/file.hsq  > events.tsv   # force v2 variant
```

Output is one write per row:

```
# tick   reg     val
0        1       32
0        189     0
...
```

`tick` is a 0-indexed count of HERAD `processEvents` calls (the same unit
our TypeScript renderer emits). `reg` has the OPL3 upper-bank bit at
`0x100` when applicable. `val` is the 0-255 byte written.

### Forced variants

AdPlug has an "aggressive v2 detection" heuristic (`validTracks`) that
mis-classifies some real v1 files (notably Cryo's `SAVAGE.HSQ`) as v2.
The `--v1` / `--v2` flags let us override, matching what the engine
would do if the file were authored for the intended variant.

## How the cross-check tests use it

`adplug-crosscheck.test.ts` shells out to `./capture-herad` for each
sample file, runs our `renderHeradToStream` on the same file, and
compares multisets of writes per tick. Budget is 10,000 ticks per file
— enough to cover the full playable duration of every sample we have.

Tests skip (with a warning) when the binary isn't built, so suite stays
green for contributors who haven't set up the harness.

## Reproducibility notes

- The AdPlug version we validated against is pinned in
  `tools/versions.sh` as `ADPLUG_VERSION_EXPECTED`. If you see test
  failures after upgrading, check for post-release behaviour changes in
  `src/herad.cpp` and the velocity macros in particular.
- The capture tool uses `getspeed()` (public) to read the song's
  `wSpeed` and mirrors AdPlug's internal `wTime` gate externally. This
  gives us the song-tick counter AdPlug uses internally (`ticks_pos`),
  even though that field is `protected`.
- The `CheradPlayer::v2` field is `protected`, so we subclass to expose
  a forceV1/forceV2 setter. This is brittle but simpler than patching
  AdPlug. If AdPlug refactors the field or exposes a public setter, we
  switch to that.

## Upstreaming

If you find a behaviour we want to question (AdPlug may also have bugs),
the right flow is:

1. Reproduce the divergence concretely with the harness.
2. Read the AdPlug source carefully to determine what it intends to do.
3. Consult HERAD documentation where available — particularly
   [VGMPF's HERAD page](http://www.vgmpf.com/Wiki/index.php/HERAD) —
   to adjudicate.
4. If AdPlug appears wrong, file an issue upstream at
   <https://github.com/adplug/adplug/issues> with the diagnostic. If we
   disagree intentionally, document the divergence in our renderer's
   comments so future readers know it's a considered choice.
