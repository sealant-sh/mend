---
"@sealant/mend": patch
---

Mend runs Sealant 0.40.0-next.774. Workspaces on Kubernetes run each person as their own Linux user
under runc, with a working `sudo` and ACLs on the shared worktree; gVisor (`runsc`) still takes one
person (sealant#406). nix images run per person too: they carry the person layout, a setuid `sudo`
and a nix daemon each person builds through, and a nix image build no longer fails on the pi install
(sealant#408). Managed images make `/etc/shadow` readable by its owner, so a person's `sudo` works
on hosts whose AppArmor confines PAM's helper; every managed per-person image rebuilds once
(sealant#410). A launch Core refuses over its owner map keeps the refusal's own code,
`owner-map-unsupported` or `owner-map-unverified` (sealant#407), and a workspace forward can be
bounded to one connection (sealant#411, sealant#412). The workspace package catalog knows what a
screen needs, `tigervnc`, `xauth`, `xdpyinfo`, `openbox`, `chromium` and `fonts-dejavu`, and refuses
`chromium` on Ubuntu 24.04 with its reason (sealant#419), and the XFCE desktop, its session bus and
`ffmpeg` per family: `xfce`, `dbus` and `ffmpeg` (sealant#427).
