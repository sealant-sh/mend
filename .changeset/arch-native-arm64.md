---
"@sealant/mend": patch
---

On arm64 hosts (Apple silicon, ARM servers), Arch workspaces now build natively for `aarch64`
instead of running `x86_64` under emulation (Sealant 0.39.0-next.721, sealant#360). Dependencies
with native modules installed in an existing worktree (`node_modules`, `.venv`, `target/`) are
`x86_64` builds: reinstall them (`pnpm install`, `uv sync`, …). Each Arch image's first build on
such a host downloads the Arch Linux ARM rootfs (about 300 MB) from `os.archlinuxarm.org`, outside
the mirrors. Every image plan now names its platform, so each workspace image is built once more at
its next launch (on amd64 from the layer cache). The Mac guide and the workspace images guide say
Apple silicon runs every workspace family natively again.
