---
"@sealant/mend": patch
---

On arm64 hosts (Apple silicon, ARM servers), Arch workspaces now build natively for `aarch64`
instead of running `x86_64` under emulation (Sealant 0.39.0-next.721, sealant#360). Dependencies
with native modules installed in an existing worktree (`node_modules`, `.venv`, `target/`) are
`x86_64` builds: reinstall them (`pnpm install`, `uv sync`, …). The first Arch build on such a host
downloads the Arch Linux ARM rootfs (829 MB) from `os.archlinuxarm.org`, outside the mirrors, and
keeps it for every later Arch build there; a mirror slower than 1 MB/s is left for another
(sealant#362). Every image plan now names its platform, so each workspace image is built once more
at its next launch (on amd64 from the layer cache). The Mac guide and the workspace images guide say
Apple silicon runs every workspace family natively again.
