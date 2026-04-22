# reSID patches

Local modifications applied on top of the pinned upstream commit
(`RESID_COMMIT` in `tools/versions.sh`) after `setup-resid.sh` clones and
resets the tree. Same authoring workflow as `tools/patches/nuked-opl3/` —
edit in-tree, `git diff > ../patches/resid/NNNN-name.patch`, rerun the
setup script to verify a clean re-apply, then commit the patch and the
rebuilt WASM together.
