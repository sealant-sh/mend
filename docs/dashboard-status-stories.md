# Dashboard status: user stories

This is what `mend`'s dashboard says about a session, its worktree and its project, in every state a
session can be in. It was written on 2026-10-02, after the first sessions on a self-hosted box read
wrong:

- `claude · 1m` looked like a model name, or a running time.
- A worktree said `running` while its only session was still starting.
- `building the workspace image (first launch after an update, ~8 min)` showed when no image was
  being built.
- `saving · 0 B left` showed while nothing was left to upload.
- After the agent exited, nothing said a save was still pending, so a resume seemed to hang.

The stories are the contract. `dashboard.tsx`, `dashboard-model.ts` and the domain words they use
implement them, and each test names the story it checks. I wrote S1 to S11 first. GPT-6 Astra then
traced the engine, corrected S5 and S7, and added S12 to S31. A story marked follow-up needs the
engine to report a state it does not report yet. Until it does, the dashboard says only what it can
observe.

## Rules every line follows

1. **A number says what it counts.** Never a bare `1m`. Write `up 4m`, `ended 5m ago`,
   `last session created 2h ago`, `12 MB left`, `12s elapsed`.
2. **Say what was observed.** Mend cannot see an image build, because the platform reports none. So
   it says the workspace has no runtime yet, and what that usually means.
3. **One word per state, the same on every row.** A session's word is its status. A worktree's word
   is one of its sessions' words.
4. **A state that lasts has its own words until it ends.** A save uploading, a save with nothing
   queued and a workspace whose end is not confirmed each read differently.
5. **Times are relative.** The one exception is a capture line that names when it observed
   something, such as `capture failing since 16:29:51 UTC`. The web app and the phone show the same
   line.
6. **The state survives a narrow column.** The row cuts the state to fit and never drops it. The
   harness and the counts go first.
7. **Actions ignore the display line.** ⇧K stops Services only when Services hold the workspace,
   whatever the row says.

## The pieces

- The header reads `mend  <n> project(s) · <n> live`.
- A project row and its section summary give the name and what is going on in it.
- A worktree row gives its name and word, then its facts on line 2.
- A session row gives its name and status word, then its facts on line 2. The facts lead with the
  state and end with the harness.
- The detail pane lists the session's facts, a rule, then the conversation. The facts are its name,
  status line, created line, services, comments and summary.

`claude` stands for the harness throughout.

## Session states

### S1. Asked to start, nothing created yet

The CLI has asked and the server has not answered with an id.

- Row: `claude · starting`, word `starting`, facts `launching · claude`.
- Detail status line: `starting · <branch> vs <base>`.
- Created line: `created just now · provisioning`.
- Conversation area: `starting · launching`.

### S2. Starting, the launch under way

The server answered and the session reads `starting`. The launch phase is the last words of its
summary.

| Phase, as the server says it                                | Row facts                                | Conversation area                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `waiting · the previous session in this worktree is saving` | `waiting for the previous save · claude` | `starting · the previous session in this worktree is still saving · this one starts from its save`        |
| `booting`                                                   | `booting · claude`                       | `starting · the workspace is booting · the agent starts when it is up`                                    |
| `preparing the workspace · no runtime yet · …`, after 20 s  | `preparing the workspace · claude`       | `starting · the workspace has no runtime yet · after an update, building its image takes about 8 minutes` |
| none yet                                                    | `launching · claude`                     | `starting · launching`                                                                                    |

- The detail status line reads `starting · <phase> · <branch> vs <base>`. The summary line leaves
  the phase out so it does not say it twice.
- A resume is a start too and uses the same words. The row never shows the session's original age
  while it starts. A session created 21 minutes ago is not 21 minutes into starting.
- When the previous executor drains for this launch, its save line leads. It reads
  `saving · 12 MB left · claude`, then `saving · no uploads pending · claude` once its queue is
  empty.

### S3. Running, waiting or idle

- Word: `running`, `waiting` when the agent asked for input, `idle` when it is alive and quiet.
- Facts: `up 4m · claude`. The time runs from the agent process's own start, and only while that
  process is live. With no agent on the wire it reads `created 9m ago · claude`. Counts follow:
  `1 shell`, `2 agents`, `1 service`.
- `running` means the process is live. It does not prove work. A phone agent quiet between turns
  still reads `running`, as S15 says.
- Created line: `created 21m ago · <id> · up 4m`.

### S4. The agent ended and Services hold the workspace

- Word: `idle`, as the server folds it.
- Facts: `agent completed · 1 service keeps the workspace up · claude`.

### S5. Stopping, with no save to report

The session reads `stopping` and reports no drain. Mend may be finding out how an executor ended,
and the executor may not answer. A save may have finished while the workspace's end is not observed
yet. A launch may have been interrupted. This can last minutes, or until the platform reports the
workspace gone.

- Word: `stopping`.
- Facts: `agent ended · workspace end not confirmed · claude` when the agent's process exited.
  `workspace end not confirmed · claude` when no agent ran, or none is known.
- It never says `workspace still up`, which Mend did not observe, or `saved`, which this state does
  not report.
- ⇧K answers `already stopping · <facts>`. It does not offer to stop Services that do not exist.
- The worktree reads `stopping`, never `settled`.

### S6. Stopping, the save uploading

- Word: `stopping`.
- Facts: `saving · 12 MB left · claude`. Before sealantd reports bytes it reads `saving · 3 left`,
  and `saving` when it reports neither.
- The worktree reads `stopping` and the project counts `1 stopping`.

### S7. Stopping, nothing queued, the drain still running

The executor's last answer reports an empty queue: zero bytes, or zero captures and no bytes. The
final flush may still be snapshotting, or its seal not yet confirmed. Nothing on the wire says
which.

- Facts: `saving · no uploads pending · claude`. Never `saving · 0 B left`, never `uploaded`.
- An overdue step follows: `saving · no uploads pending · capture step overdue · …`.

### S8. The save stalled or cannot finish

- Facts: the domain's line, `not saved · <why> · 3 pending · workspace kept`.

### S9. Settled

The session ended and `settledAt` is set.

- Word: `completed`, `failed` or `stopped`.
- Facts: `ended 5m ago · claude`. An older server sends no `settledAt`, and then it reads
  `created 2h ago · claude`.
- Created line: `created 2h ago · <id> · ended 5m ago`.

### S10. Failed to launch

- Word `failed`, facts `ended 2m ago · claude`.
- The detail summary shows the first line of the failure, `launch failed: …`.

### S11. A capture problem while running

- The domain's line leads the facts: `capture failing since 16:29:51 UTC · <error>`,
  `not saved · 2 refused`, or an overdue step.

### S12. Starting while the previous executor does not answer

- Facts: `waiting for the previous session · claude`.
- The detail keeps the server's full words,
  `waiting · the previous session in this worktree is not answering`.

### S13. Resuming before the replacement agent exists. Follow-up.

PTY and shell resumes reopen the session as `running` before the replacement process exists. The
engine refuses launch phase words for a session that is not `starting`. Today the row reads
`running · agent ended 2h ago · claude`. That is true, and it hides that a resume is under way. The
engine needs to keep a resume `starting` until its process exists.

### S14. The agent process exists and has drawn nothing yet

- Facts: `up <1m · claude`.
- The detail summary keeps the server's `claude is starting on the new machine` until output or
  exit.

### S15. A phone agent quiet between turns, or stopped for idleness

- Quiet: `running · up 40m · claude`.
- Stopped for idleness: settled, and the detail keeps
  `idle · stopped after 15 min · reply to resume`.

### S16. The agent ended and shells hold the workspace

- `idle · agent ended 5m ago · claude · 1 shell`.

### S17. A shell session

- `running · shell up 4m · shell`. Never `agent up`.

### S18. An agent Mend observed rather than launched

- `running · activity seen 4m ago · claude`. Quiet followed by new activity is not a restart.

### S19. The agent ended and cleanup still runs. Follow-up.

The engine settles the session before checkpointing, harvest and workspace cleanup. A stop drain can
then move it back to `stopping`. Today it reads `completed · ended just now`, then
`stopping · saving …`. The engine needs to hold the session in `stopping` from the agent's end.

### S20. The agent ended and the executor does not answer

- S5's words: `agent ended · workspace end not confirmed`. No promised duration.

### S21. The save finished and the workspace's end is not confirmed

- S5's words: `workspace end not confirmed`. The detail summary keeps what the server said of the
  save.

### S22. A launch interrupted before an agent ran

- While it stops: `stopping · workspace end not confirmed`, and the detail keeps
  `launch interrupted …`.
- Settled: `stopped · ended … · claude`, and the detail keeps
  `launch cancelled · nothing was created`.

### S23. No transcript, while a save or a recovery remains

- A `stopping` session is never hidden, transcript or not. Its worktree and project count it.

### S24. The queue is empty and the final capture is unfinished

- S7's words, `saving · no uploads pending`, with an overdue step after them when there is one.

### S25. The executor kept for recovery

- The domain's line, `not saved · executor kept for recovery · <reason> · <pending>`. Never
  `workspace end not confirmed`, and never hidden.

### S26. Handoff, replacement, or an executor ended outside Mend

- The row gives the status. The detail summary keeps the server's words, such as `handed off to …`,
  `picked up · executor replaced`, `stopped outside Mend` or `saved at …`.

### S27. Unsaved work discarded

- `stopped · unsaved work discarded by <owner> at <time> UTC · claude`, with the discard first.

### S28. Stop asked and not answered yet

- The row reads `stopping` at once, never `stopped`, because the stop is asked and not observed.
- A session with Services reads `stopped · 1 service keeps the workspace up`, since a stop leaves
  Services running.

### S29. Fields missing, or clocks disagree

- With no agent start, or no `settledAt`, the facts read `created 2h ago`.
- A future or unreadable time leaves the fact out. The created line never reads `created  ·`.

### S30. Empty, resumed and mixed worktrees

- An empty worktree reads `created 2h ago · empty`.
- The fold keeps its order and counts stopping sessions that have no transcript.

### S31. A narrow column

- At 120 terminal columns a session's facts get about 25 characters. They read
  `workspace end not conf… …` or `preparing the wor… …`, never `…` alone.

## Worktree states

A worktree's word is its most pressing session word, in this order:

1. `waiting`
2. `running`
3. `starting`
4. `stopping`
5. `idle`
6. `settled`, when no session is live or stopping

Its facts read `from <base> · last session created 5m ago`, then `2 open` and `3 sessions`. An empty
one reads `from <base> · created 2h ago · empty`. Mend does not carry when a resume started, so the
fact names the creation.

## Project states

- The section summary and the header count live sessions and stopping ones apart: `1 live`,
  `1 live · 1 stopping`, `2 stopping`, else `settled`. Live means starting, running, waiting or
  idle.
- The project row reads `<live>/<total>`, and counts a stopping session as live because its
  workspace still is.

## What the server says

- The phase that guessed at an image build now reads
  `preparing the workspace · no runtime yet · after an update, building the image takes about 8 minutes`.
  Summaries stored with the old words still parse.
- A drain with an empty queue reads `saving · no uploads pending` everywhere, because the web app,
  the phone, Slack and the CLI share `captureStatusLine`.

## Not covered

- The web app, the phone and the desktop app keep their own layouts. Only the shared domain words
  change for them.
- Nothing on the wire says when a seal's wait ends, so no line gives a time for it.

## Engine follow-ups

- S13: keep a resume `starting` until its replacement process exists.
- S19: hold the session in `stopping` from the agent's end until its cleanup and save end.
- A restart between `harnessGone` and its reconciliation may leave a `stopping` session with no
  drain and no cleanup under way. Astra rated this plausible, and it needs a crash-window test.
