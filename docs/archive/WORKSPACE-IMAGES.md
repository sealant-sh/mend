# Workspace Images — facts and direction

> Historical record (2026-09-26): notes from 2026-08-13. Superseded by Sealant's workspace image
> builders design (sealant#266) and the shipped image settings documented at
> https://docs.mend.run/guides/workspace-images/.

Notes from the 2026-08-13 discussion. Most of this work lands in the Sealant platform (Core
`buildkit-builder`), with Mend growing a per-project settings surface at the end.

## Facts (verified against Core source and shipped artifacts)

- **Images are not built per session.** Sessions create _containers_ from
  `sealant-workspace-<os>:latest`, compiled from the blueprint with cache-ordered layers (packages →
  harnesses → env/entrypoint last). Since the unification it is one image with codex + claude-code
  baked in. What _is_ per-create: the buildkit walk + publish runs every time — warm cache makes it
  seconds, but there is no "plan unchanged → skip entirely" content-hash short-circuit yet. Cheap,
  real win.
- **sealantd is a fully static musl binary shipped on `scratch`** (`static-pie`,
  `ldd: statically linked` — checked against the actual `ghcr.io/sealant-sh/sealantd` image).
  Workspace images just `COPY --from=<pin> /usr/local/bin/sealantd` + `ENV` block +
  `ENTRYPOINT sealantd boot`. No libc assumption at all: alpine, ubuntu, distroless-adjacent, arm64
  — all fine.
- Today's distro families: `fedora:41`, `archlinux`, `nixos/nix`.
- The only distro-aware extras: package installs per family, and `socat` (docker-exec control
  relay).

## Direction

1. **Plan-hash short-circuit** (Core, small): content-hash the resolved image plan; identical hash
   skips the buildkit walk entirely. Makes every session start snappier.
2. **Ubuntu family** (Core, mechanical): one distro definition (`ubuntu:24.04`, apt
   `RUN --mount=type=cache` block) + the package-name mapping table + e2e. ~A day, mostly
   package-name tedium.
3. **Custom base image** (Core + SDK + Mend): blueprint gains a `baseImage: <ref>` mode that skips
   distro package installs and overlays only sealantd + env + entrypoint (+ vendored static socat,
   killing the last distro dependency). Contract with the user: any Linux base with a shell (and
   node for the node-based harness CLIs), amd64/arm64.
4. **Mend surface**: per-project "Workspace image" card — os-family picker, or custom image ref + a
   few setup lines. Deliberately _not_ a compose editor: the workspace is one container; compose
   already has a home inside it (the dind sidecar, where project compose files run for Services).
   What people customize is the Dockerfile-ish triple: base image, extra packages, setup commands.
