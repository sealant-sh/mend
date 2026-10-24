---
"@sealant/mend": patch
---

The Setup page saves its own default packages on Arch again (and on Fedora and Ubuntu): Core
resolves each id from the catalog its images install from, on amd64 and arm64 (sealant#364). On an
arm64 host, the Arch Linux ARM rootfs download leaves a slow mirror, shows its progress and is
downloaded once per host (sealant#362), and pacman in the image installs from measured Arch Linux
ARM mirrors (sealant#365). Waits on a workspace no longer count a wall clock that jumped as time
spent, as a VM's does after its host slept, and stopping a workspace whose image build failed reads
`stopped` instead of being refused as still launching (sealant#363).
