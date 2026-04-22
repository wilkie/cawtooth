# fake6502 patches

Local modifications applied on top of the pinned upstream commit
(`FAKE6502_COMMIT` in `tools/versions.sh`) after `setup-fake6502.sh` clones
and resets the tree. Same authoring workflow as `tools/patches/nuked-opl3/`
and `tools/patches/resid/` — edit in-tree, `git diff > ../patches/fake6502/NNNN-name.patch`,
rerun the setup script to verify a clean re-apply, then commit the patch
and the rebuilt WASM together.
