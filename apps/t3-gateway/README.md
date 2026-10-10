# @mend/t3-gateway

A t3code environment in front of Mend (ADR 0012, `docs/adr/0012-t3code-gateway.md`). t3code's
desktop, mobile and web clients add it as a remote environment and pair with a Mend pairing code. To
them it is a t3code server; to Mend it is an ordinary client of `/api`, calling with the device
token of the person who paired. Mend stays the only source of truth and its access rules apply
unchanged.

It runs on Effect `4.0.0-rc.115` from the `t3` catalog and speaks t3code's contracts from
`@mend/t3-contracts`, pinned to one t3code nightly tag. It does not import `@mend/api-contracts`: it
decodes only the Mend fields it reads.

## Phase 0: HTTP

| t3code route                      | What the gateway does                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/t3/environment` | The descriptor: a persisted `environmentId`, `orchestrationProtocolVersion` 2, `serverVersion` `<t3code tag>+mend.<n>`, no optional capability |
| `POST /oauth/token`               | Claims the pairing code through Mend's `POST /api/pair`, keeps the device token, answers a bearer of its own (30 days, standard scopes)        |
| `POST /api/auth/websocket-ticket` | A gateway-local ticket for `/ws?wsTicket=`: single use, thirty seconds, in memory                                                              |
| `GET /api/auth/session`           | Authenticated while the bearer is live and Mend still accepts its device token (`GET /api/me/devices`; Mend has no `GET /api/me`)              |
| `POST /api/auth/browser-session`  | Refused: the gateway offers bearer tokens only                                                                                                 |
| pairing links and client sessions | Refused with `insufficient_scope`: devices are administered in Mend                                                                            |

Refusals carry t3code's own error bodies (`EnvironmentAuthInvalidError`,
`EnvironmentRequestInvalidError`, `EnvironmentScopeRequiredError`, `EnvironmentInternalError`).

## Phase 0: the RPC socket

`GET /ws?wsTicket=…&orchestrationProtocol=2` upgrades to Effect RPC in JSON on `rc.115`, serving
t3code's whole `WsRpcGroup`. Without `orchestrationProtocol=2` it answers 426 with t3code's body. A
ticket is spent once; a socket without one may use the request's own bearer, as t3code allows. Each
socket gets its own RPC server, holding the handlers of the person who paired.

| Method                                                  | What the gateway does                                                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscribeServerConfig`, `server.getConfig`             | The config: the descriptor, and one provider per Mend harness from `GET /api/harnesses/models` read as the person; its login from `GET /api/me/sealant` (below) |
| `subscribeServerLifecycle`                              | `welcome` with `bootstrapStatus: "complete"`, then open                                                                                                         |
| `server.probe`                                          | `{}`                                                                                                                                                            |
| `agentSessions.scan`                                    | No candidates: the gateway has no agent history to scan, and Mend's projects are in the shell already                                                           |
| every other command or read                             | A typed failure from the method's own contract, never a defect                                                                                                  |
| feeds of things Mend never has (terminals, previews, …) | Open, and never emit                                                                                                                                            |

`codex` is driver `codex` and `claude` is driver `claudeAgent`; other harnesses are left out. The
capability flags say what Mend does: a session keeps its model (`requiresNewThreadForModelChange`),
no rollback, no plan mode, runtime modes `full-access` (`bypass`) and `approval-required` (`ask`),
and no provider setup through t3code. Mend unreachable answers `ServerSettingsError`, which t3code
retries; a device revoked in Mend answers `EnvironmentAuthorizationError`, which blocks the
connection.

A provider's login is what Mend holds for the person (`GET /api/me/sealant`, read beside the
catalog). An active connected account is `authenticated`. None is `unauthenticated`, with a warning
that says to run `mend connect <harness>`: without it t3code tells the person a provider is
"Connected" when Mend has no login of theirs. It is a warning and not an error, as the turn still
goes to Mend, which decides what runs. When the read fails or takes over two seconds, the login is
`unknown` and the config comes anyway. Whether a login works shows only when a turn runs.

## Phase 1: the projection

One projection hub per paired person (`src/hub.ts`), shared by all of their sockets and requests and
kept two minutes after the last one closes. It holds one `GET /api/events` stream from Mend, read
with one of the person's device tokens, and re-reads what each pointer names through Mend's API:
`project`, `session`, `session-process`, `worktree` and `session-change` re-read the project
(`GET /api/projects/:id`), `agent-conversation` re-reads the session's turns and requests, and
`organization`, `user` and `resync` re-read everything. A project read also re-reads
`GET /api/sessions` for the people live in each executor, whether control is shared and whether the
executor waits to be replaced. A turns read also reads what holds the next sender's turn
(`GET /api/sessions/:id/waiting`), but only while someone is live there and control is shared, and
the retirement is read only while the session says one is under way: with neither, the gateway asks
Mend nothing more. A server without these fields reads as nobody live and nothing waiting. A burst
of pointers for one thing is one read. After the stream drops, the hub reconnects with backoff and
reads everything again.

Each read rebuilds the t3code entities (`src/shell.ts`), encodes them through the vendored schemas,
and sends only what changed, each change stamped with the hub's next sequence. Sequences come in
blocks of a million from one high-water mark for the whole gateway, kept in the state file and
seeded from the clock, so no hub ever stamps one another hub stamped: an earlier hub of the same
person, another person's, or a gateway from before replay, which counted from 0. A hub reserves its
next block when half of one is used; blocks are not contiguous, as other hubs reserve in between. A
hub that runs out with none reserved (the state file refused every reservation) stamps on, says so
in its log, and answers every resume with a snapshot from then on.

### Replay after a sequence

A client that subscribes with `afterSequence` gets only what changed after it, when the hub still
holds it: the last 1,000 shell changes, at most 8 MiB encoded, and the last 128 changes of each
watched thread, at most 1 MiB encoded (t3code's own limits; t3code has no byte limit for the shell).
Any other sequence (older than that, from another hub, or ahead of the hub) gets a fresh snapshot,
which t3code always takes as a reset. A thread stays watched for two minutes after its last
subscriber leaves, so a client that reconnects resumes it without reloading it.

| t3code                                                         | From Mend                                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `orchestration.subscribeShell`, `GET /api/orchestration/shell` | Every project the person sees, and every session whose current agent is a codex or claude protocol process                    |
| project                                                        | `workspaceRoot` is the store path; no default model; new threads start in a new worktree (`defaultThreadEnvMode: "worktree"`) |
| thread                                                         | the session; title from its label, else its first message; `worktreePath` is the worktree beside the store                    |
| run                                                            | one per turn; a running turn whose agent asked something is `waiting`                                                         |
| shell status                                                   | the latest run's status, else `idle`; the newest pending request; message bodies stay out, as in t3code's shell               |
| pending background tasks                                       | what a waiting turn waits for: the previous sender's own work (ADR 0016, decision 6)                                          |

PTY and shell sessions, and harnesses t3code has no driver for, are not threads.

### Threads

`orchestration.subscribeThread`, `orchestration.getThreadProjection` and the HTTP thread routes
serve one thread in full (`src/thread-projection.ts`). While anyone subscribes to a thread, the hub
keeps its items current: an `agent-conversation` pointer re-reads its turns and requests and the
items past the last change-feed cursor (`GET /api/sessions/:id/items?after=`). Each entity that
changed is one upsert event (`run.updated`, `turn-item.updated`, `message.updated`,
`runtime-request.updated`, …); one that went away sends a fresh snapshot; a session that is no
longer a thread sends `thread.deleted`. A subscription opens with a full snapshot, or, resuming
after a sequence the hub still holds, with only what changed since (see "Replay after a sequence").

| t3code                                     | From Mend                                                                                                                                                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user message                               | the turn's input; a turn the agent opened on its own is a system message                                                                                                                                                                                  |
| assistant message, reasoning               | `assistant-message` and `reasoning` items, `streaming` while in progress                                                                                                                                                                                  |
| command, file change, web search           | read from the harness's own item in `data` (codex app-server items, claude `tool_use` blocks)                                                                                                                                                             |
| other tool calls, plans, background tasks  | a tool row named by the harness                                                                                                                                                                                                                           |
| error                                      | `error` items, and a failed turn's error after everything it did                                                                                                                                                                                          |
| runtime request, approval or question item | the agent's request; answered through Mend while its agent is live                                                                                                                                                                                        |
| system notices                             | ADR 0016's lines, word for word (`src/notices.ts`): the waiting line after the waiting turn's input; the shared-workspace line and, while the thread is watched, the retirement line (`GET /api/sessions/:id/workspace-retirement`) after everything else |
| ordinals                                   | each turn owns a block of 100 000, its input first, then items and requests in the order Mend recorded them                                                                                                                                               |
| `GET …/threads/:id/bounded`                | the whole thread as one window: no cursor, nothing older                                                                                                                                                                                                  |

### Commands

`orchestration.dispatchCommand` takes what Mend can back (`src/commands.ts`); every other command
answers `OrchestrationV2DispatchCommandError` naming it.

| t3code                                                                       | What the gateway does                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.dispatch`                                                           | Checks Mend's steering rule as the sender (`GET /api/sessions/:id`), queues the message, and sends it once no turn is open: `POST /api/sessions/:id/turns`, or, when the agent stopped, `POST /api/sessions/:id/launch` with no prompt and then the turn once the agent runs |
| `run.interrupt`                                                              | `POST /api/turns/:id/interrupt`; with `holdQueue` (t3code always sends it) the queue is held before the turn ends. A queued run is taken back instead                                                                                                                        |
| `queued-run.cancel`, `queue.resume`, `queued-run.edit`, `queued-run.reorder` | The gateway's queue                                                                                                                                                                                                                                                          |
| `runtime-request.respond`                                                    | `POST /api/requests/:id/respond`: decisions as Mend's (`acceptAlways` is `accept-for-session`), answers as lists of strings                                                                                                                                                  |
| `thread.user-input.dismiss`                                                  | The same, answering `cancel`                                                                                                                                                                                                                                                 |

The gateway holds the queue (ADR 0012): it never sends a second turn while one is open in Mend,
whoever opened it. A queued message is a run of the gateway's own (`t3-run:…`) until Mend opens its
turn; from then on the turn keeps that run id and the client's message id, recorded in the state
file's `run_ids` and `message_ids`, so a client's own message is reconciled even after a gateway
restart.

The gateway never guesses which Mend turn is its message's (`src/queue.ts` holds the rules). With
the agent live, the message goes out as `POST /api/sessions/:id/turns`, which answers the turn: an
exact identity. With the agent stopped (the 15-minute idle stop), the session is launched again with
no prompt and no options (Mend reuses what its last protocol agent recorded, mend#493, so an `ask`
session comes back asking), and once Mend reports the agent running the message goes out the same
way. A launch that races another client's (Mend's 422 while the session reads `starting` or its
agent up) is taken as under way, and the message waits for the agent. Every wait is bounded:

- A launch fails when the call fails, when Mend settles the session as ended after the launch
  answered, or when the agent is not up 10 minutes after the launch (above Mend's own launch budget:
  a 30-second answer window plus workspace start, saves and image builds). The message then fails
  with the reason and the queue moves on.
- A `409 ProtocolSessionNotLive` while the row still reads the agent running is retried only after a
  backoff (1 s doubling to 15 s) and a fresh read of the session from Mend, never in the same pass;
  still refused 2 minutes after the first 409, the message fails with Mend's refusal.

- While a message can still reach Mend, the hub holds itself without any socket; a closed client
  never loses an accepted message, and a hub with nothing that can progress is let go.
- A message in the queue or waiting on a launch can be taken back (`queued-run.cancel`,
  `run.interrupt`) and stops blocking at once; one being sent has its own turn interrupted when Mend
  answers. Every interrupt honours `holdQueue`.
- A session removed, or no longer a protocol session, fails what was queued for it.
- Every Mend call made with a device token goes through one gate (`src/device-gate.ts`): a 401
  refuses that token and closes its sockets. When every device of the person is refused, the hub
  fails what was queued, stops Mend's event stream and lets itself go.
- A `commandId` is reserved before anything is read, so a command sent twice at once is one message.

`queued-run.edit` rewrites a message still waiting (t3code sees a `message.updated`), and
`queued-run.reorder` moves one before another waiting message, or after the last one, as t3code's
own server places it. A message on its way to Mend, or settled, is neither rewritten nor moved.

Steering mid-turn and holding a message for later are refused.

### Images

t3code hands the gateway a message's images as data URLs (`assets.persistChatAttachments`, its path
for a server without upload URLs). The gateway keeps each in its state file and answers an id; the
message carries those ids, in the queue and across a restart.

- When the message goes out, each image is placed in the session's workspace with Mend's
  `POST /api/sessions/:id/images`, as the sender, and the turn names its path, as Mend's Slack
  runner does: `[image: screen.png · /workspace/…/paste/….png]`, then "Images from t3code are saved
  as files in the workspace, at the paths shown. Open a path to see the image." The agent opens the
  file. A placement holds for the session and the agent process it was made for: a retry after "not
  live" places only what is not placed yet, and a new agent gets each image placed again.
- Mend's rules are checked before anything reaches it: PNG, JPEG, GIF or WebP by their bytes, 8 MiB
  each. A file that is not an image is refused.
- A message (sent, launched or edited in the queue) carries at most ten images, each once, each one
  the person attached in the same thread, however many uploads they came in.
- The client sees its own words and, once Mend took the turn, the images that turn carried, as the
  message's attachments; an image edited out of a queued message is not among them. It fetches an
  image from `assets.createUrl`: `/api/assets/<token>/<name>`, a random token in the gateway's
  memory for that person's one image, ten minutes, served without a bearer as an `<img>` asks. The
  token is in the path, so these requests are neither logged nor traced.
- An image attached to a message that was never sent is let go after a week: at start, and by each
  person's hub every hour.
- The gateway places images only through Mend's paste route, as the sender, and has no writer of its
  own: the turn names exactly the path Mend answers. With mend#615, in a per-person executor (the
  default) the file is written as the sender into their own directory
  (`/workspace/harness-home/people/<account>/paste/`), which their agent, running as them, reads; in
  a shared executor, into `/workspace/harness-home/paste/`. A steerer's image under shared control
  lands in the steerer's directory, and its turn runs as the steerer (ADR 0016, decision 6): the
  paste and the turn always go with the same sender's token.

### A queue that survives a restart

Each person's queues are kept in the state file (`queued_messages`, `queue_holds`) whenever they
change, and come back when the person's hub starts. A message names its sender by bearer session;
the device token is looked up from `bearer_sessions` when the queue comes back, never copied.

| Kept as           | Comes back as                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------- |
| queued, launching | queued again, its launches still counted; failed when its sender's device is no longer paired |
| sending           | failed, saying the gateway cannot tell whether Mend took it: it is never sent twice           |
| failed, cancelled | as it was                                                                                     |
| held              | held, while anything is still queued                                                          |

After a restart, the gateway opens the hub of every person with a queued message on its own, reads
Mend once, and sends it in order: no client has to come back. Mend not answering yet is tried again
every 30 seconds.

A message is kept as `sending` before it goes to Mend; when the state file cannot take that write,
the message fails with a reason and is not sent. A client that sends the same message again (the
same `messageId`), a restart in between too, gets the message already kept or sent. A kept message
goes to Mend with its sender's own device token, so Mend's rules apply as they would to a fresh one:
a session deleted while the gateway was down fails the message, and so does a sender who may no
longer steer the session.

### Review

`review.getDiffPreview` and `review.getDiffFileContents` (`src/review.ts`) show the thread's change:
the `cwd` t3code names is the thread's `worktreePath`, and the answer is one `branch-range` source,
the change against its base, from `GET /api/changes/:id/diff` read as the person. A preview for one
file is that file's section of the patch. Whole contents (for expanding a hunk) come from the patch
for a file it holds whole, added or deleted; a changed or renamed file is read whole from Mend's
`GET /api/worktrees/:id/contents`: before, at the worktree's first checkpoint, where the change
starts, and after, as the worktree stands. A binary file, or one past the 1 MiB Mend shows, answers
`VcsUnsupportedOperationError`. Whitespace is never ignored: Mend's change diff has no such option.

### Per-turn diffs

Mend keeps checkpoints per worktree and does not link them to turns; the gateway correlates them
(`src/turn-checkpoints.ts`), as ADR 0012 decided:

- a turn's checkpoint is the last `turn-boundary` checkpoint its session took between the turn's
  start and the next turn's (Mend takes one when a turn ends);
- a turn starts from the newest checkpoint of the worktree, any session's, taken before it began, or
  the worktree's base;
- when another session works in the same worktree (one the person sees in the project, or one whose
  checkpoints are in the chain), a turn's changes can include its work from while the turn ran, and
  the thread says so in a notice. A session whose checkpoints failed counts all the same.

While someone watches a thread, the gateway reads its worktree's chain (`GET /api/worktrees/:id`)
when it opens and whenever another turn ended. Mend tells of a turn's end before it takes the turn's
checkpoint, so while the last ended turn has none, the chain is read again when Mend says the
worktree or the conversation moved, at most every 2 seconds and 10 times; `getTurnDiff` reads it
again for a turn whose checkpoint the kept chain lacks. Then each new turn's files from
`GET /api/worktrees/:id/diff?from=&to=`, the last 50 turns at most, in the background. Each turn's
checkpoint goes to t3code as a `ready` checkpoint numbered by its run, so the changed-files card
shows under the turn. A slice never changes, so its files are kept. `orchestration.getTurnDiff` and
`orchestration.getFullThreadDiff` answer from the same slices; a turn with no checkpoint yet answers
the method's own error.

## Phase 2: threads from t3code

### Launching a thread

`orchestration.launchThread` (`src/launch.ts`) is how t3code starts a thread with its first message.
The gateway creates a Mend session as the person who paired, so Mend records them as its owner and
origin `mend`, and its agent runs as them (docs/adr/0016).

| t3code                                       | Mend                                                                                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree { baseRef, branch? }`              | `POST /api/projects/:id/sessions`: a new worktree from `baseRef`, named from the branch's last segment and a random suffix (`health-check-k3x9qa`), so two launches at once never share one; never an existing worktree       |
| `existing_worktree { worktreePath }`         | `POST /api/worktrees/:id/sessions`: the worktree of the project's session at that path                                                                                                                                        |
| `root`                                       | Refused: every Mend session has a worktree of its own                                                                                                                                                                         |
| model, reasoning effort, `fast` service tier | named on each launch until Mend has recorded the session's agent; after that Mend reuses what it recorded                                                                                                                     |
| `full-access`, `approval-required`           | `bypass`, `ask`; other runtime modes are refused                                                                                                                                                                              |
| `title`, `generateTitle`                     | the session's label: the title, or, when t3code asks to generate one, the first line of the first message, cut to Mend's 60 characters; never unlabelled. A title the client sets later renames it (`thread.metadata.update`) |
| `initialMessage`                             | queued like a follow-up; the run is `preparing` while the session launches                                                                                                                                                    |

The opening message goes through the queue: the queue launches the session
(`POST /api/sessions/:id/launch`, no prompt) and sends the message with
`POST /api/sessions/:id/turns` once Mend reports the agent running, so the run is the message's
exact turn. The launch answers as soon as the session exists, and the thread is in the shell, by the
client's own thread id, with its message in it: t3code's client opens a launched thread only once
its shell shows one. The opening message's images go with it, as any message's do (see Images).

A launched thread keeps the id its client gave it: `thread_ids` in the state file maps it to its
session, for the person who launched it only, and every method that names a thread takes that id.
Anyone else who can read the session sees it by its Mend id. A retry of the same `commandId` is the
same thread (`resumed: true`), across a restart too.

The opening message is kept from the moment the launch is accepted. When Mend does not answer the
first reads of the new session, the gateway keeps reading in the background, and fails the message
with a reason if it still cannot read the session after thirty seconds.

### Rename, stop and delete

Each goes through Mend's own route as the person, so Mend's rules decide: a session that is not
theirs answers t3code's authorization error.

| t3code                                     | Mend                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `thread.metadata.update` with only `title` | `POST /api/sessions/:id/label`, its owner's to set. A branch, worktree or pull request is refused  |
| `provider-session.detach`                  | `POST /api/sessions/:id/stop`; what is still queued is held, so nothing relaunches it unasked      |
| `thread.delete`                            | `DELETE /api/sessions/:id`; when Mend answers that the session is live, a stop and one more delete |

t3code's client sends `provider-session.detach` before it deletes a thread with a live agent. Mend
keeps the session's worktree and change after a delete, as it does for every session it removes.
When Mend keeps the session until its workspace has stopped (`removed: false`), the gateway hides it
at once: the client has already let it go. The state file keeps it hidden across a restart
(`pending_removals`) until Mend no longer lists it.

Mend lets a person with shared control stop the owner's session but not delete it. Their delete in
t3code stops the owner's live session first (the client's `provider-session.detach`), and then
answers t3code's authorization error.

### Project files and `@`-mentions

`projects.searchEntries` (the composer's `@`) and `projects.listEntries` (the file tree) name the
thread's worktree, or the project's root, as `cwd` (`src/files.ts`). The gateway answers from Mend's
`GET /api/projects/:id/files`, read as the person: the session's worktree for a thread, the default
branch for the project's root, both under Mend's visibility rules. Any other `cwd` answers
`workspace_root_not_found`.

- A search ranks a name that starts with what was typed first, then a name that contains it, a path
  that contains it, and its letters in order anywhere; shorter paths win a tie. An empty query lists
  the shallowest entries first. `kind` and `imageOnly` filter as t3code's own index does.
- Directories are every directory above a listed file.
- A listing answers for 15 seconds, so typing after `@` reads Mend once.
- Mend lists at most 20,000 files, sorted, with no paging and no listing by directory. In a larger
  tree a file past the cut cannot be found or browsed here, and every search or directory listing
  over a cut list says `truncated`, even when nothing matched, so the composer never presents it as
  complete.

### Reading and searching files

`projects.readFile` and `projects.searchContents` (t3code's file preview and content search) read a
thread's worktree as it stands through Mend's `GET /api/worktrees/:id/contents`, as the person.

- A file comes back as text, at most 1 MiB of it (`truncated` says so); a binary file answers
  `binary_file`, a missing one `path_not_file`, a path Mend refuses (outside the worktree, `.git`)
  `workspace_path_outside_root`.
- A search matches across the worktree, untracked files included and ignored ones not, up to 500
  lines. The gateway marks where each line matched, as t3code highlights it: a literal with
  `indexOf`, a regex in a worker stopped after 250 ms (`src/highlight.ts`), so the client's regex
  never runs on the gateway's thread; lines a stopped worker did not finish come without highlights.
  A regex git cannot read is searched as text and answers `regexFallbackError`, as t3code's own
  server does.
- The project's root (its store path) has no files of its own to read or search.

### VCS status

`subscribeVcsStatus` and `vcs.refreshStatus` (`src/vcs.ts`) answer for a thread's worktree from the
change Mend keeps for it (`GET /api/changes/:id/stats`), read as the person.

| t3code                                 | From Mend                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `refName`, `isDefaultRef`              | the session's branch; the project's root is its default branch                                |
| `branchChanges`                        | the change's totals: the worktree against its base, committed or not                          |
| `hasWorkingTreeChanges`, `workingTree` | false and empty: Mend has no read of HEAD, the index or uncommitted files, so none is claimed |
| `hasPrimaryRemote`                     | the project was adopted from an origin                                                        |
| the remote half                        | none: Mend tracks no upstream for a session's branch (landing is its own step)                |

`vcs.listRefs` answers the project's branches as its store holds them
(`GET /api/projects/:id/ branches`, read as the person: no session branch, the default marked as
Mend marks it), and in a thread its own branch, current in its worktree, from Mend's session.
Nothing else is invented: no remote ref, and no default when the store holds none. It filters by
`query` and pages by `cursor` and `limit` (100 by default) as t3code's own server does. t3code takes
the default as a new worktree's base.

The stream sends a snapshot, then the local half again when any thread in the worktree changes in
the shell (every session there adds to the one change) or a thread goes, and every 15 seconds
besides, as a change can move without its threads changing. It reads at most once a second however
busy the worktree is, and sends only what moved.

## Phase 3: the runtime mode

Mend sets a permission mode per launch, so `thread.runtime-mode.set` chooses the mode for the
agent's next start, as ADR 0012 decided ("the next launch"): `approval-required` is `ask`,
`full-access` is `bypass`, and anything between is refused. Only someone who may steer the session
chooses, as Mend decides.

- The running agent is not touched. Until it next starts (the idle stop, a stop), the thread shows
  the chosen mode and says: "From the agent's next start: ask before acting · it runs as it started
  until then", in Mend's own words for its modes.
- The next launch the gateway makes for the thread names the chosen mode; once a live agent runs
  with it, the line goes. Choosing the mode it already runs with is nothing to wait for.
- The choice is kept per person and session in the state file (`next_modes`), across a restart. It
  is written before it is acknowledged: a choice the file does not take is refused with a reason and
  changes nothing, so a restart never brings back a mode the person moved away from.

## Phase 3: archive

Mend has no archive, so archiving in t3code is the person's own view, kept by the gateway
(`archived_threads` in the state file), as ADR 0012 decided. `thread.archive` moves the thread out
of the active shell (`thread.removed`) into the archived one
(`orchestration.getArchivedShellSnapshot`, `subscribeArchivedShell`). What is still queued for it is
held: nothing is sent while it is archived. t3code's own server takes such messages back instead,
but a message taken back is history, which the gateway caps at 20, so an archive of a long queue
would lose the oldest; held, every message is still there, across a restart too, and
`thread.unarchive` brings the thread back with its queue held, to resume or cancel. The archive
itself stops the queue, held or not: an archived thread's queue never sends or launches, and
`queue.resume` is refused until it is unarchived. The hold is kept before the archive, and an
archive whose hold the state file refuses is refused. The session in Mend is not touched, and other
clients of Mend and other people see it as before.

## Phase 3: the terminal

t3code's terminal drawer opens Mend's own terminal (`src/terminals.ts`): a shell Mend opens beside
the agent in the session's live workspace (`POST /api/sessions/:id/shell`), reached over Mend's
`/api/tty?process=` WebSocket, as the person.

- The socket opens with a `tty` upgrade ticket Mend mints for that one process
  (`POST /api/upgrade-tickets`): single use, thirty seconds, spent at once. The gateway holds it
  redacted and never logs or keeps it. A restart is a new shell and a new ticket.
- Mend's rules hold: only a session's owner opens a shell in it, and only its owner types; anyone
  else gets t3code's authorization error. A session whose workspace is not running answers
  `TerminalNotRunningError`.
- Output is Mend's PTY bytes as UTF-8; input goes as bytes, a resize as Mend's `{"t":"resize"}`.
  Mend's `{"t":"end"}`, or the socket closing, is the terminal exiting.
- Terminals are the person's, shared by their sockets, with the last 512 KiB of output kept for a
  client that attaches again. `terminal.close` stops the shell in Mend. A hub that goes closes its
  terminals' sockets and stops their shells in Mend, each with the token of the person who opened
  it. A terminal is kept from before Mend opens its shell: a ticket or socket that fails after, or
  an open that is interrupted, stops that shell rather than leave it running.

## Run it

It is off unless someone turns it on. On a packaged server, `mend server setup --t3-gateway` turns
it on (`--t3-gateway-port <n>` for another port, `--no-t3-gateway` off): the generation gains
`compose.t3.yaml`, which sets `MEND_T3_GATEWAY_ENABLED` in the Mend container, publishes the gateway
on 127.0.0.1 only and mounts its state volume (`mend-t3-gateway`). Setup refuses it on an image
without the gateway and says whether it answered; `mend server status` says it is on and whether
this machine reached it. In Mend's server image it is one bundled file
(`pnpm --filter @mend/t3-gateway build`, `dist/bin.js`), which the bundle's supervisor starts after
Mend is ready when `MEND_T3_GATEWAY_ENABLED` is `1` or `true`: on 3120 in the container, in front of
Mend's API there. It is kept running on its own (`keepRunning`): its exit, or a start that fails, is
logged and it starts again, and it never stops Mend. Mend's health does not wait for it.

It runs confined, as nothing else in the container does (`scripts/bundle-supervisor.mjs`,
`scripts/t3-gateway-root.sh`):

- in a root of its own, `/opt/mend-t3-gateway`: node and its libraries, `setpriv`, the bundle in
  `/app` and its state in `/state` (`/state/state.sqlite`, the `mend-t3-gateway` volume on a
  packaged server). Mend's store, config and SSH keys, the control sockets and the Docker socket are
  not in it;
- as its own uid and gid, 10120, with no supplementary groups, no capabilities and `no_new_privs`;
- with only its own environment: Mend's API on loopback, where it listens, its state and its label.
  No database URL, secret or key of the bundle's reaches it; it reaches Mend over HTTP with each
  paired person's device token;
- bounded: a 256 MiB heap, 768 MiB of data, 1,024 descriptors, 256 processes, and nice 10.

From a checkout, run it beside a Mend server:

```sh
MEND_T3_GATEWAY_MEND_URL=http://127.0.0.1:3101 pnpm --filter @mend/t3-gateway start
```

| Variable                     | Default                                               |
| ---------------------------- | ----------------------------------------------------- |
| `MEND_T3_GATEWAY_MEND_URL`   | `http://127.0.0.1:3101`, Mend's API                   |
| `MEND_T3_GATEWAY_HOST`       | `127.0.0.1`. Anything wider is an exposure (ADR 0004) |
| `MEND_T3_GATEWAY_PORT`       | `3120`                                                |
| `MEND_T3_GATEWAY_STATE_PATH` | `$XDG_STATE_HOME/mend/t3-gateway/state.sqlite`        |
| `MEND_T3_GATEWAY_LABEL`      | `Mend`, the name t3code shows                         |

The gateway needs its own origin: t3code forces a remote environment's base path to `/`.

To pair, mint a code in Mend (`POST /api/me/devices/pairings`, or the devices page) and give t3code
the gateway's host and that code, or `http://<gateway>/pair#token=<code>`. The device shows in
Mend's device list as `t3code · <client label>`; revoking it there ends the bearer.

Mend allows ten failed pairing claims a minute per client address. The gateway sends each claim with
`x-forwarded-for`: the client's own header, if any, then the address the gateway saw. Mend believes
it only from a hop it trusts: loopback (the default `MEND_T3_GATEWAY_MEND_URL`), or an address in
`MEND_TRUSTED_PROXIES`, the same rule as for any proxy in front of Mend. Reached any other way,
every client of the gateway shares the gateway's one budget. Clients on the gateway's own machine
share the loopback budget; a web page can't send `x-forwarded-for` through the gateway's CORS.

A claim Mend refuses for the limit answers `429 Too Many Requests` with Mend's `retry-after` and
`{"error": "rate_limited", "error_description": "…"}`. t3code's token contract declares no
rate-limit error, so its clients report "returned undeclared status 429", as a transient failure,
not as a wrong code. The code is not spent.

## State

One `node:sqlite` file the gateway owns: the environment id, bearer sessions (the bearer's sha256
and the Mend device token it stands for), and the id maps: `run_ids` and `message_ids`, filled by
every turn a t3code client sends, and `thread_ids`, every thread a t3code client launched (its id,
its session, the launch command and what the launch named; no secrets). `project_ids` stays empty.
`queued_messages` and `queue_holds` keep each person's queues: text, ids, state, image ids and the
sender's bearer session, never a device token. `images` keeps the images people attach, with where
Mend last placed each (session, agent process, path), and `sent_images` the images each sent message
carried. Mend's database is never touched. Losing the file loses pairings and t3code-side ids, never
Mend records.

**The file holds every paired person's Mend device token in clear**, and the token acts as that
person in Mend until the device is revoked. The gateway needs it usable: it calls Mend for a person
when no client request is in flight (the event stream, device checks every 60 s, queued sends and
relaunches), and a socket that reconnects after a restart carries only a ticket. A hash cannot make
those calls, and a key kept beside the file would protect nothing the file's mode does not. So:

- the gateway creates the file `0600` and a missing directory `0700`, and narrows the file, and
  SQLite's `-wal` and `-shm` beside it, to `0600` each time it opens an existing one;
- an existing directory keeps its mode: point `MEND_T3_GATEWAY_STATE_PATH` at a directory of its
  own;
- run the gateway as a user no one else shares, and keep the file out of backups that others can
  read. Anyone who can read it, or is root, can act as everyone who paired. Revoking a `t3code · …`
  device in Mend ends that token.

## Tests

`pnpm --filter @mend/t3-gateway test` runs the gateway on an ephemeral port in front of a fake Mend
and drives it with `HttpApiClient` over the vendored `EnvironmentHttpApi`, as a t3code client does.

- `test/ws.test.ts` is the handshake end to end: descriptor, `/oauth/token`, ticket, `/ws`, then the
  config snapshot naming the descriptor's environment, the welcome, and the empty shell. Its client
  is built as t3code's `client-runtime` builds one; `client-runtime` itself is not used (the test
  says why).
- `test/rpc-surface.test.ts` checks that the registered handlers are exactly the vendored group's
  methods, then calls every method not served over a bare socket with a payload generated from its
  own schema: each answers a typed failure its contract decodes, or stays silent if it is a feed.
