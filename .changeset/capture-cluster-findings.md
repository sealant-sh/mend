---
"@sealant/mend": patch
---

Capture mode, after the first cluster session on a Garage bucket:

- The capture routes ask the bucket only about capture objects. `capture.register` refuses a
  manifest naming a key that is not `…/packs/<sha256>`, `…/trees/<sha256>` or `…/manifests/<sha256>`
  before any HEAD; `upload.urls` and `upload.complete` drop or refuse such keys; a plan presigns
  object keys alone. Every bucket failure inside a route now names the key.
- Mend verifies a capture's git section itself (`index-pack --verify` plus
  `git rev-list --objects --missing=error` over the refs it names, on the runner) and records the
  outcome in `captures.git_fsck` — `checkpoint`, `turn`, `suspend` and `final` at register, `auto`
  at the first plan that would restore it. A capture whose pack omits a tree it names is accepted
  and marked `failed`; `plan.get` answers the same head with the git section of the newest capture
  that verifies (ADR-0002 16), and reads come from that capture, stamped.
- `review prep` logs a change git cannot read with git's command and stderr, the worktree and the
  chain head's verification state, instead of `Cause([Fail(GitError)])`; the passes are simply not
  queued.
- `scripts/capture-e2e.sh` kills the executor with SIGKILL explicitly and `docs/KUBERNETES.md`
  states the distinction: a graceful `kubectl delete pod` is a planned stop (`final` capture,
  session `completed`); only a forced delete takes the `executor lost · lease expired` pickup path.
