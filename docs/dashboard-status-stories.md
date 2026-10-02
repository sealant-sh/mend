# Dashboard status: user stories

What `mend`'s dashboard says about a session, its worktree and its project, in every state a session
can be in. Written 2026-10-02 after the first sessions on a self-hosted box read wrong:

- `claude · 1m` looked like a model name or a running time;
- a worktree said `running` while its only session was still starting;
- `building the workspace image (first launch after an update, ~8 min)` showed when no image was
  being built;
- `saving · 0 B left` showed while nothing was left to upload;
- after the agent exited, nothing said the workspace was still being saved, so a resume seemed to
  hang for no reason.

The stories are the contract; `dashboard.tsx`, `dashboard-model.ts` and the domain words they use
implement them, and their tests name the story they check. S1–S11 were written first; an adversarial
review (GPT-6 Astra, 2026-10-02) traced the engine and added S12–S31, and corrected S5 and S7.
Stories marked **follow-up** need the engine to report a state it does not report yet; until then
the dashboard says only what it can observe.

## Rules every line follows

1. **A number always says what it counts.** Never a bare `1m`: `up 4m`, `ended 5m ago`,
   `last session created 2h ago`, `12 MB left`, `12s elapsed`.
2. **Say what was observed, not a guess.** Mend cannot see an image build (the platform reports
   none), so it says the workspace has no runtime yet and what that usually means, never
   `building the image`.
3. **One word for one state, the same on every row.** A worktree's word is one of its sessions'
   words; a session's word is its status.
4. **Something that keeps going says so.** A save still uploading, a save with nothing queued, a
   workspace whose end is not confirmed: each has its own words until it ends.
5. **Relative times**, except the time-of-day a capture line names for an event it observed
   (`capture failing since 16:29:51 UTC`, `discarded … at …`), which the web and phone share.
6. **The state survives a narrow column.** A row's state is cut to fit, never dropped; the harness
   and counts drop first (S31).
7. **An action never reads the display line.** ⇧K stops Services only when Services hold the
   workspace, whatever the row says.

## The pieces

- **Header:** `mend  <n> project(s) · <n> live`.
- **Project row / section summary:** the project's name and what is going on in it.
- **Worktree row:** line 1 the worktree's name and its word; line 2 its facts.
- **Session row:** line 1 the session's name and its status word; line 2 its facts.
- **Detail pane:** the session's facts (name, status line, created line, services, comments,
  summary), a rule, then the conversation area.

## Session states

Each story: the situation, then what each piece says. `claude` stands for the harness.

### S1. Asked to start, nothing created yet (pending id)

The CLI has asked; the server has not answered with an id.

- Session row: `claude · starting` / `starting`; facts `launching · claude`.
- Detail status line: `starting · <branch> vs <base>`.
- Created line: `created just now · provisioning`.
- Conversation area: `launching` explanation (S2's text without a phase).

### S2. Starting: the launch is under way

The server answered; the session is `starting`. The launch phase is the last words of its summary,
as the server says them:

| Phase (server words)                                                 | Row facts                                | Detail conversation area                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `waiting · the previous session in this worktree is saving`          | `waiting for the previous save · claude` | `starting · waiting for this worktree's previous session to finish saving; this one starts from that save`                     |
| `booting`                                                            | `booting · claude`                       | `starting · the workspace is booting; the agent starts once it is up`                                                          |
| `preparing the workspace · no runtime yet …` (no executor for 20 s+) | `preparing the workspace · claude`       | `starting · the workspace has no runtime yet · building its image, on the first launch after an update, takes about 8 minutes` |
| none yet                                                             | `launching · claude`                     | `starting · launching`                                                                                                         |

- Session row word: `starting`.
- Detail status line: `starting · <phase words> · <branch> vs <base>`; the summary line does not
  repeat the phase.
- A resume is a start too: the same words. The row never shows the session's original age while it
  starts (a resumed session created 21 minutes ago is not 21 minutes into starting).
- When the previous executor is draining for this launch (`captureDrain` `relaunch` or
  `replacement`), its save line leads the facts: `saving · 12 MB left · claude`, then, once its
  queue is empty, `saving · no uploads pending · claude` (S7).

### S3. Running, waiting, idle: the agent is live

- Session row word: `running` (working), `waiting` (asked for input), `idle` (alive, quiet).
- Row facts: `up 4m · claude`, from the current agent process's own start, only while that process
  is live; `created 9m ago · claude` when the server sends no agent. Then `1 shell`, `2 agents`,
  `1 service` when there are any.
- `running` is process liveness, not proof of work: a phone agent quiet between turns reads
  `running` (S15).
- Detail status line: `<word> · <branch> vs <base>`.
- Created line: `created 21m ago · <id> · up 4m`.

### S4. The agent ended; Services keep the workspace up

- Row word: the session's status (`idle` as the server folds it).
- Facts lead with the hold: `agent completed · 1 service keeps the workspace up · claude`.

### S5. Stopping, no save to report

The session reads `stopping` and reports no drain: Mend is finding out how an executor ended (it may
not be answering), a save finished and the workspace's end is not observed yet, or a launch was
interrupted. This can last minutes, or until the platform reports the workspace gone.

- Row word: `stopping`.
- Facts: `agent ended · workspace end not confirmed · claude` when the agent's process exited;
  `workspace end not confirmed · claude` when no agent ran or none is known.
- Never `workspace still up` (not observed) and never `saved` (not reported here).
- ⇧K: `already stopping · <facts>`; it does not offer to stop Services that do not exist.
- Worktree: `stopping`, never `settled`.

### S6. Stopping: the save is uploading

Status `stopping`, `captureDrain` `stop`, pending work reported.

- Row word: `stopping`.
- Facts: `saving · 12 MB left · claude` (`saving · 3 left` before sealantd reports bytes; `saving`
  when it reports neither yet).
- Worktree word: `stopping`; project: counted as `1 stopping`, never `settled`.

### S7. Stopping: nothing queued, the drain still runs

Status `stopping` (or `starting`, for S2's drain), the executor's last answer reports an empty
queue: zero bytes, or zero captures and no bytes. The final flush may still be snapshotting, or its
seal not yet confirmed; nothing on the wire says which.

- Facts: `saving · no uploads pending · claude`. Never `saving · 0 B left`, never `uploaded`.
- An overdue step follows it: `saving · no uploads pending · capture step overdue · …`.

### S8. Stopping: the save stalled or cannot finish

The drain stopped moving; the workspace is kept.

- Facts: the domain's line, unchanged: `not saved · <why> · 3 pending · workspace kept`.

### S9. Settled

The session ended and its workspace is gone (`settledAt` set).

- Row word: `completed`, `failed` or `stopped`.
- Facts: `ended 5m ago · claude` (from `settledAt`; without it, `created 2h ago · claude`).
- Detail status line: `<word> · <branch> vs <base>`.
- Created line: `created 2h ago · <id> · ended 5m ago`.

### S10. Failed to launch

Status `failed`, summary `launch failed: …`.

- Row word `failed`; facts `ended 2m ago · claude`.
- Detail summary line: the failure's words (first line).

### S11. A capture problem while running

`capture failing since 16:29:51 UTC · <error>`, `not saved · 2 refused`, or an overdue step: the
domain's line leads the facts while the session runs, as today.

## Worktree states

The worktree's word is its most pressing session word, in this order:

1. `waiting` (a session asked for input)
2. `running`
3. `starting`
4. `stopping` (a session is saving)
5. `idle`
6. `settled` (no session is live or stopping)

- Facts: `from <base> · last session created 5m ago`, then `2 open`, `3 sessions`; an empty one
  `from <base> · created 2h ago · empty`. Mend does not carry when a resume started, so this names
  the creation, not a start.

## Project states

- Section summary and header count `live` sessions (starting, running, waiting, idle) and, apart,
  `stopping` ones: `1 live`, `1 live · 1 stopping`, `1 stopping`, else `settled`.
- Project row: `<live>/<total>` as today; a stopping session counts as live there (its workspace
  is).

## What the server says, and where

- `LAUNCH_BUILDING_IMAGE` becomes
  `preparing the workspace · no runtime yet (an image build after an update takes about 8 minutes)`.
  The old words stay recognised in stored summaries.
- The capture line's drain with an empty queue reads `saving · no uploads pending` on every surface
  (web, phone, Slack, CLI), since they share `captureStatusLine`.

## Not covered here

- The web app, the phone and the desktop app keep their own layouts; only the shared domain words
  change for them.
- When a seal's wait will end is not on the wire; the line says nothing about a time.

## Added by review (S12–S31)

### S12. Starting: the previous executor is not answering, or its end is unconfirmed

- Row: `waiting for the previous session · claude`; detail keeps the server's full reason
  (`waiting · the previous session in this worktree is not answering`).

### S13. Resuming before a replacement agent exists — **follow-up**

PTY and shell resumes reopen the session as `running` before the replacement process exists, and the
engine refuses launch phase words for a session that is not `starting`. Today the row reads
`running` with the previous agent's `agent ended 2h ago`, which is true but does not say a resume is
under way. Needs the engine to keep a resume `starting` until its process exists.

### S14. The agent process exists but has drawn nothing yet

- Row: `running · up <1m · claude`; detail summary keeps the server's
  `claude is starting on the new machine` until output or exit.

### S15. A phone agent quiet between turns, or stopped for idleness

- Quiet: `running · up 40m · claude` (process liveness).
- Idle-stopped: settled; detail keeps `idle · stopped after 15 min · reply to resume`.

### S16. The agent ended; shells keep the workspace up

- Row: `idle · agent ended 5m ago · claude · 1 shell`.

### S17. A shell session

- Row: `running · shell up 4m · shell`; never `agent up`.

### S18. An agent observed rather than launched (`agent-external`)

- Row: `running · activity seen 4m ago · claude`; quiet then new activity is not a restart.

### S19. The agent ended; harvest and cleanup still run — **follow-up**

The engine settles the session before checkpointing, harvesting and workspace cleanup, then a stop
drain can move it back to `stopping`. Today it reads `completed · ended just now`, then
`stopping · saving …`. Needs the engine to hold the session in `stopping` from the agent's end.

### S20. The agent ended; the executor is not answering

- S5's words: `agent ended · workspace end not confirmed`; no promised duration.

### S21. Saving finished; the workspace's end is not confirmed

- S5's words: `workspace end not confirmed`. The detail summary keeps what the server said of the
  save.

### S22. A launch interrupted before an agent ran

- `stopping · workspace end not confirmed`; detail keeps `launch interrupted …`. Settled:
  `stopped · ended … · claude`, detail `launch cancelled · nothing was created`.

### S23. No transcript, but saving or recovery remains

- A `stopping` session is never hidden, transcript or not; worktree and project count it.

### S24. The queue is empty but the final capture is unfinished

- S7's words: `saving · no uploads pending`, with an overdue step after it when there is one.

### S25. The executor kept for recovery

- The domain's line: `not saved · executor kept for recovery · <reason> · <pending>`; never
  `workspace end not confirmed`, never hidden.

### S26. Handoff, replacement, an executor ended outside Mend

- The row says the status; the detail summary keeps the server's words (`handed off to …`,
  `picked up · executor replaced`, `stopped outside Mend`, `saved at …`).

### S27. Unsaved work discarded

- `stopped · unsaved work discarded by <owner> at <time> UTC · claude`, the discard first.

### S28. Stop asked, not answered yet

- The row reads `stopping` at once (not `stopped`): asked, not observed. A session with Services
  reads `stopped · 1 service keeps the workspace up`, as a stop leaves Services.

### S29. Fields missing, or clocks disagree

- No agent start: `created 2h ago`. No `settledAt`: `created 2h ago`. A future or unreadable time:
  the fact is left out, never an empty `created  ·`.

### S30. Empty, resumed and mixed worktrees

- Empty: `created 2h ago · empty`. The fold keeps waiting > running > starting > stopping > idle,
  and counts transcript-less stopping sessions.

### S31. A narrow column

- At 120 terminal columns a session's facts get about 25 characters: `workspace end not conf… …`,
  `preparing the wor… …` — the state first, cut, never `…` alone.

### Engine follow-ups

- S13: keep a resume `starting` until its replacement process exists.
- S19: hold the session in `stopping` from the agent's end until its cleanup and save end.
- A restart between `harnessGone` and its reconciliation can leave a `stopping` session with no
  drain and no cleanup under way (plausible; needs a crash-window test).
