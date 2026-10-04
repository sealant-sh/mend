# t3code parity with Mend's phone app

Status: written 2026-10-04 with phase 1 of ADR 0012 (`docs/adr/0012-t3code-gateway.md`). The owner's
ask: a t3code client (web, desktop, mobile) in front of Mend through `apps/t3-gateway` should do
what Mend's own phone app (`apps/mobile`) does. This list maps each phone feature to the t3code
surface that would carry it, and says where that surface sits in the ADR: done in phase 1, planned
for phase 2, 3 or 4, in the ADR's "never" row, or not in t3code at all.

Inventory of `apps/mobile` as of `main` at `6abd2ab9f` (after #479 model picker, #487/#450 Stop,
#490 pull request card, #436 unfolded layouts, #394 image attach, #397 notifications, #478 secret
files).

## The list

| Phone feature                                                                                           | t3code surface                                                                                            | Where                                                                                            |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Pair by QR, typed code or deep link                                                                     | Remote environment by pairing URL or host plus code                                                       | Phase 0 (code); phase 4 (`mend t3 pair` prints the URL and a QR)                                 |
| Now: sessions grouped Needs you / Live / Recently settled, live                                         | Shell: threads with status, pending request, latest run                                                   | **Phase 1, done** (protocol sessions only; PTY sessions hidden)                                  |
| Session list rows: harness, model, status, worktree                                                     | Thread shell: provider, model, status, branch, worktree path                                              | **Phase 1, done**                                                                                |
| Row: the change's pull request (#490)                                                                   | `branchPullRequest` / `linkedPullRequest` on the thread shell                                             | Not in the ADR; read-only fields, about 1 day (from `GET /sessions/:id/landings`)                |
| Swipe to rename                                                                                         | `thread.metadata.update` (title)                                                                          | Phase 2                                                                                          |
| Swipe to delete, Clear settled                                                                          | `thread.delete`; `thread.archive` for the bulk tidy                                                       | Phase 2 (delete), phase 3 (archive)                                                              |
| Start a session: harness, worktree name, model, effort, base branch, priority chips (#479)              | `orchestration.launchThread` with `modelSelection` (+ effort and service tier options), worktree strategy | Phase 2 (the server config already lists Mend's models, efforts and fast tier)                   |
| Adopt a project from GitHub or a clone URL                                                              | `projects.createNew`, `sourceControl.cloneRepository`, `projectClone.*`                                   | ADR: refused ("projects are adopted in Mend"); about 2 days if wanted                            |
| Conversation: turns, markdown, reasoning, tool items, workflow cards (#488)                             | Thread projection: user/assistant messages, reasoning, tool rows                                          | **Phase 1, done** (workflows and tasks show as tool rows, not cards)                             |
| Composer send, optimistic bubble, Retry/Edit on refusal                                                 | `message.dispatch` (client-side optimism)                                                                 | **Phase 1, done**                                                                                |
| Follow-up to a stopped session (Resume, idle stop)                                                      | `message.dispatch` relaunches                                                                             | **Phase 1, done**                                                                                |
| Image attach: library, camera, clipboard, up to 10 (#394)                                               | `attachments.createUploadUrl`, `assets.persistChatAttachments`, message `attachments`                     | Phase 2                                                                                          |
| Approvals: allow once, for session, decline                                                             | `runtime-request.respond`                                                                                 | **Phase 1, done**                                                                                |
| Questions: option chips, multi-select, written answer                                                   | `runtime-request.respond` with answers; dismiss                                                           | **Phase 1, done**                                                                                |
| Stop the current turn (composer)                                                                        | `run.interrupt`                                                                                           | **Phase 1, done**                                                                                |
| Stop session, with confirm (#450, #487)                                                                 | `provider-session.detach` (t3code's "stop session")                                                       | Not in the ADR table; about half a day (`POST /sessions/:id/stop`)                               |
| Queue a message behind a running turn                                                                   | Queued runs, cancel, resume                                                                               | **Phase 1, done** (edit and reorder: phase 2)                                                    |
| Shared control: non-owners see read-only                                                                | Authorization error on commands                                                                           | **Phase 1, done** for refusals; t3code has no read-only thread state                             |
| Hand off a PTY session to protocol on first send                                                        | None: PTY sessions are not threads                                                                        | Not in t3code; ADR hides PTY sessions                                                            |
| PTY transcript and typing into the terminal                                                             | Terminal panel                                                                                            | Phase 3 (`/api/tty`)                                                                             |
| Deliver a review follow-up                                                                              | None                                                                                                      | Not in t3code (ADR: review and follow-ups stay in Mend's clients)                                |
| Pull request card in the conversation, Refresh (#490)                                                   | `pullRequests.detail`, `pullRequests.subscribeRefreshes`, thread PR fields                                | ADR "never" (PR watch); a read-only view is 2–3 days                                             |
| Shell in the worktree, stop with confirm                                                                | `terminal.open/attach/write/resize/close`                                                                 | Phase 3                                                                                          |
| Diff of the whole change                                                                                | `review.getDiffPreview`                                                                                   | **Phase 1, done** (the change against its base; whole-file expansion for changed files: phase 3) |
| Per-turn diff                                                                                           | `orchestration.getTurnDiff`, checkpoint scopes                                                            | Phase 3                                                                                          |
| Review: pinned slice, line comments, accept/dismiss/addressed, tour, read and suggest passes            | None (t3code's review comments are GitHub pull request comments)                                          | Not in t3code (ADR: stays in Mend's clients)                                                     |
| Unfolded layouts, split two sessions (#436)                                                             | Client layouts                                                                                            | Client-side in t3code; nothing for the gateway to serve                                          |
| Push notifications: turn finished, needs input, failed, Slack sessions; on-screen session silent (#397) | t3code mobile pushes through the T3 Connect relay (agent awareness)                                       | ADR "never" (the relay is refused); not possible without T3's cloud relay                        |
| Notification preferences (`PUT /me/notifications`)                                                      | None: t3code's server settings have no notification preferences                                           | Not in t3code; ADR "never" for settings writes                                                   |
| Secret files list (#478)                                                                                | None                                                                                                      | Not in t3code                                                                                    |
| Theme, text size                                                                                        | Client settings                                                                                           | Client-side                                                                                      |
| Test connection, unpair                                                                                 | Client environment management                                                                             | Client-side; revoking the device in Mend ends the bearer (phase 0)                               |
| Model picker mid-session                                                                                | `thread.model-selection.set`, `provider.switch`                                                           | ADR "never"; the phone does not have it either (it picks the model at launch)                    |
| Permission mode switch                                                                                  | `thread.runtime-mode.set`                                                                                 | Phase 3 (applies on the next launch); the phone does not have it                                 |

## Where the ask meets the ADR's "never" row

- **Model switch.** No conflict for parity: the phone chooses model, effort and priority at launch
  only (#479), which is `launchThread` in phase 2. A mid-thread switch stays off
  (`requiresNewThreadForModelChange`), as on the phone.
- **Pull request watch.** The phone shows the change's pull request (row line, conversation card,
  Refresh, #490); it never watches or acts on it. Showing it is two read-only pieces the ADR did not
  list: the thread's `branchPullRequest` field from Mend's landings (about 1 day), and
  `pullRequests.detail` for the card (2–3 days with Refresh). Watching, merging and commenting stay
  "never".
- **Preview.** No conflict: the phone has no preview or Services surface.
- **Settings writes.** The phone writes notification preferences and lists secret files. Neither has
  a t3code setting to map to, so they stay in Mend's clients whatever the ADR says.
- **Notifications** are the real gap. t3code mobile only receives pushes through T3 Connect's relay,
  which the gateway refuses and which belongs to T3's cloud. A t3code phone in front of Mend gets no
  pushes; Mend's own phone app stays the way to be told a turn ended or needs you.
- **Review** (slices, comments, tour, passes, follow-up delivery) has no t3code surface at all. A
  t3code client sees the diff; reviewing and sending comments back stays in Mend's clients.

## Estimate for phases 2–4

| Phase | Scope                                                                                                                                                                | Size         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 2     | `launchThread` (model, effort, tier, base branch), rename, delete, images, `@`-mentions, VCS status, persisted queue with edit and reorder, replay after a sequence  | about 1 week |
| 2+    | Pulled in by the ask: Stop session (`provider-session.detach`), the thread's pull request fields and a read-only pull request card                                   | 3–4 days     |
| 3     | Checkpoint-range diff and worktree file read (two additive Mend reads), per-turn diffs, whole-file expansion, terminal over `/api/tty`, runtime-mode switch, archive | about 1 week |
| 4     | `mend server setup` opt-in, `mend t3 pair` with QR, exposure gate entry, docs page, drift job                                                                        | 3–5 days     |

About 3–3.5 weeks in all. Push notifications, review and notification settings are left out: there
is no t3code surface to carry them.
