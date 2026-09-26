# Known bugs

Observed, reproducible, not yet fixed. Newest first; delete entries when they ship.

## 2026-08-30 · root-side git in workspaces can poison a store's ref database

Status 2026-09-26: mitigated by #158 (`core.sharedRepository=group`, `packages/store/src/store.ts`).
It now applies only to the deprecated co-located store (`MEND_SESSION_STORE=colocated`): a captured
workspace mounts no project store, so its git cannot write there.

Observed live (project scribe, k8s PoC): workspace containers run as root and mount the project's
bare repo (a linked worktree's real gitdir), so any git the agent runs writes there as uid 0. A
root-side `git gc --auto` repacked refs and left `packed-refs`, `logs/`, and `refs/heads/mend/`
root-owned — after which the API (uid 1000) could not create a session ref: every provision on the
project failed 422 in ~90ms ("cannot lock ref … Permission denied"). Same class as the known
container-uid worktree leftovers (`removeWorktreeForce`), but the blast radius is the whole project,
not one session's cleanup. Mitigated: stores now run `core.sharedRepository=group` with setgid
group-writable trees (applied at adopt, healed at worktree create), so future root-side writes stay
group-writable for uid 1000. An ALREADY-poisoned store still needs a one-off root
`chown -R 1000:1000` (only root may re-group root's files). The real fix is platform-side — see
PLATFORM-FEEDBACK.md: workspace containers should write the store as uid 1000.

## 2026-08-30 · repeat bridge-mode adopts skip the connected signer

Status 2026-09-26: unknown. Not re-checked since mend 0.11.1, and no fix names it.

First `mend adopt --auth bridge` works end-to-end; later adopts fail "Permission denied (publickey)"
in ~800ms with NO identities request reaching the share client — while `/api/keys/bridge` reports
connected and the identical git command with the same `SSH_AUTH_SOCK` succeeds when run manually in
the API pod. Something between `remoteEnvFor("bridge")` and the spawned git stops consulting the
socket on the non-first adopt. Not yet root-caused; reproduced three times against mend 0.11.1 on
the k8s PoC.

## 2026-08-13 · shell state restore references sessions the CLIs cannot open

Status 2026-09-26: still open. Not reproduced or investigated since it was recorded.

Inside a shell session, the agent CLIs list past conversations that fail to open ("imagined"
sessions). Likely the restored/converted harness state (the conversation-lands-everywhere launch
invariant) placing session files whose provider-side ids or paths don't resolve in this fresh
workspace. Needs: reproduce with a specific harness, inspect what the restore/convert placed in
`$HOME`, and decide what the invariant should write for a session that never ran that harness.

<!--
Fixed and removed:
- 2026-08-13 · shell exit settles the session as failed — bash's `exit` returns $? (^C then exit
  reads 130); the watcher now settles interactive shells as completed regardless of exit code,
  keeping the observed code in the summary. The platform run was never at fault (verified live:
  run settles completed/0).
- 2026-08-13 · shell sessions had no harness credentials — platformShape gained a "shell" branch
  injecting every baked harness's credentials, selected by what actually launches (argv "bash"),
  covering shell sessions AND shell resumes.
-->

## Graceful shutdown can wedge with live sessions

Status 2026-09-26: mitigated, root fix not done. The 5 s deadline is in `apps/api/src/main.ts` (the
`SIGTERM`/`SIGINT` handlers before `NodeRuntime.runMain`). The engine threads an `AbortSignal` into
PTY output reads only; its other pending SDK calls still take none.

Observed 2026-08-13 while live-testing UDP Services: on `node --watch` restart (SIGTERM), the child
released :3105 but hung forever holding the Service listeners (TCP and UDP), all session unix
sockets, and its platform connections — the engine scope's teardown never reached the ServiceHost /
SessionSocketHost finalizers. Inspector dump showed the finalizer chain stalled with live watch
fibers; the suspect is an `Effect.tryPromise` on a pending SDK call (record stream / PTY status)
with no abort signal, which is uninterruptible while pending. Reproduced twice with 3 live sessions.

Mitigated in `apps/api/src/main.ts` with a 5s shutdown deadline (unref'd timer → `process.exit`).
Root fix: thread `AbortSignal` through the engine's SDK polling calls so interruption can actually
cancel them.
