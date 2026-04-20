# Nuked-OPL3 patches

Local modifications applied on top of the pinned upstream SHA (`NUKED_OPL3_COMMIT` in `tools/versions.sh`) after `setup-nuked.sh` clones and resets the tree.

Patches are applied in **alphabetical order**, so the numeric prefix establishes ordering. Use the `NNNN-short-description.patch` convention (e.g. `0001-add-per-voice-output.patch`).

## Authoring a new patch

1. Start from a clean tree:

   ```
   tools/setup-nuked.sh
   ```

   This clones, resets to the pinned SHA, and re-applies any existing patches.

2. Make your edits inside `tools/nuked-opl3/` (the vendored source).

3. Generate the patch from the working tree diff:

   ```
   cd tools/nuked-opl3
   git diff > ../patches/nuked-opl3/0001-short-description.patch
   ```

   Use whatever next number is free. Keep each patch narrow and single-purpose — bug fix, feature, API addition. One concern per file.

4. Rerun `tools/setup-nuked.sh` on a fresh tree to confirm the patch applies cleanly from scratch, then rebuild:

   ```
   tools/build-wasm.sh
   ```

5. Commit the patch file **and** the rebuilt `packages/core/wasm/nuked-opl3.wasm` together. Consumers install the `.wasm` from the repo; they don't run the build pipeline themselves.

## Updating an existing patch

Same flow — edit, regenerate, overwrite the existing `.patch` file, rerun setup to verify, rebuild, commit. Don't "stack" a second patch on top of a conceptually-related one; update in place.

## When the pinned SHA is bumped

Bumping `NUKED_OPL3_COMMIT` in `tools/versions.sh` may make patches fail to apply against the new base. When that happens:

1. Temporarily disable the failing patch (rename it `.disabled`), rerun setup, reapply the change by hand against the new base, regenerate the patch, re-enable.
2. Note the bump and any conflict resolution in the commit message so the history is legible later.
3. Rebuild and commit the fresh `.wasm`.

## When to upstream instead

If a change is broadly useful and not cawtooth-specific, consider sending it upstream to [nukeykt/Nuked-OPL3](https://github.com/nukeykt/Nuked-OPL3) rather than carrying it as a local patch. Once merged and released, we bump the SHA and drop the patch.

Candidates for **keeping local**: cawtooth-specific API additions (per-voice taps tailored to our wrapper), experimental features, workarounds for quirks specific to our usage.

Candidates for **upstreaming**: bug fixes, portability improvements, spec-conformance corrections.
