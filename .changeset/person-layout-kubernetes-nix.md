---
"@sealant/mend": minor
---

Per-person workspaces run on Kubernetes (the runc runtime) and on nix images. Mend no longer rules
out a Kubernetes deployment, the `k8s` and `k3s` runtimes or nix images before it asks Sealant;
Cloudflare sandboxes still take one person. Per-person workspaces need Sealant 0.40.0 or later. With
an older Sealant, on any runtime, every new worktree runs with a shared home and the session says
why, and a worktree that already ran per person is refused, naming the Sealant version it needs,
until Sealant is upgraded. The image check finds `sudo` only when it is setuid. When Sealant could
not check an image, the launch is refused with words to try again, Mend records "the image could not
be checked" without replacing an answer a per-person workspace confirmed, a new worktree's next
launch runs with a shared home, and a shared launch checks the image again after a day. Migration
0138 takes out of each recorded "no" the reasons only Kubernetes caused and the owner-map refusals
an older Sealant gave for an image it had not checked, and drops a "no" left with none, so the next
launch on that image checks again.
