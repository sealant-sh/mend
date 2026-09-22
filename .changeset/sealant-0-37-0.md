---
"@sealant/mend": patch
---

Runs on Sealant 0.37.0 (sealant-sh/sealant#278, #279). Sealant now owns a catalog of workspace
packages: every id in Mend's default workspace list installs on fedora, arch, ubuntu and nix, on
x86_64 and ARM64, from the family's repositories or from a pinned, checksum-verified release where
the family has no package (`mise`, `lazygit`, `uv`). Until now the default list only built on Arch
x86_64, so a new project on a Lambda MicroVM deployment failed at its first build. A package id
Sealant does not know is refused when the session's workspace is created, naming it, rather than
minutes later as a failed build. An Arch image build also fails at the package step now when pacman
cannot install something, instead of two steps later on a missing `npm`. `@sealant/sdk` and
`@sealant/api-contracts` move to 0.37.0, and the bundled server image pins the 0.37.0 API, worker
and ssh-gateway digests.
