---
"@sealant/mend": patch
---

Runs on Sealant 0.36.1 (sealant-sh/sealant#276). Workspace-scoped Docker inside a Lambda MicroVM
session works on every managed OS family now, and three faults in the families' recipes are fixed on
every runtime: an Arch project could not be built on ARM64 at all (Docker Hub's `archlinux` is
x86_64 only; Sealant now builds Arch from Arch Linux ARM's signed rootfs), no native harness binary
started on the nix family (its image had no FHS dynamic loader path), and a recent npm skipped
opencode's install script. `@sealant/sdk` and `@sealant/api-contracts` move to 0.36.1, and the
bundled server image pins the 0.36.1 API, worker and ssh-gateway digests.
