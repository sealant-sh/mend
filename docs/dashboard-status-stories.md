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
implement them, and their tests name the story they check.

## Rules every line follows

1. **A number always says what it counts.** Never a bare `1m`: `up 4m`, `ended 5m ago`,
   `last start 2h ago`, `12 MB left`.
2. **Say what was observed, not a guess.** Mend cannot see an image build (the platform reports
   none), so it says the workspace has no runtime yet and what that usually means, never
   `building the image`.
3. **One word for one state, the same on every row.** A worktree's word is one of its sessions'
   words; a session's word is its status.
4. **Something that keeps going says so.** A workspace still up, a save still uploading, a save
   uploaded and waiting to be confirmed: each has its own words until it ends.
5. **Time-of-day only where a wait has an end Mend knows** (`until 08:04 UTC`); otherwise relative.

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

- Session row: `claude · starting` / `starting`; facts `launching`.
- Detail status line: `starting · <branch> vs <base>`.
- Created line: `created just now · provisioning`.
- Conversation area: `launching` explanation (S2's text without a phase).

### S2. Starting: the launch is under way

The server answered; the session is `starting`. The launch phase is the last words of its summary,
as the server says them:

| Phase (server words)                                                 | Row facts                                | Detail conversation area                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `waiting · the previous session in this worktree is saving`          | `claude · waiting for the previous save` | `starting · waiting for this worktree's previous session to finish saving; this one starts from that save`                     |
| `booting`                                                            | `claude · booting`                       | `starting · the workspace is booting; the agent starts once it is up`                                                          |
| `preparing the workspace · no runtime yet …` (no executor for 45 s+) | `claude · preparing the workspace`       | `starting · the workspace has no runtime yet · building its image, on the first launch after an update, takes about 8 minutes` |
| none yet                                                             | `claude · launching`                     | `starting · launching`                                                                                                         |

- Session row word: `starting`.
- Detail status line: `starting · <phase words> · <branch> vs <base>`; the summary line does not
  repeat the phase.
- A resume is a start too: the same words. The row never shows the session's original age while it
  starts (a resumed session created 21 minutes ago is not 21 minutes into starting).
- When the previous executor is draining for this launch (`captureDrain` `relaunch` or
  `replacement`), its save line leads the facts: `saving · 12 MB left · claude`, then, once the
  upload is done, `uploaded · confirming the save · claude` (S7).

### S3. Running, waiting, idle: the agent is live

- Session row word: `running` (working), `waiting` (asked for input), `idle` (alive, quiet).
- Row facts: `claude · up 4m`, from the current agent's start; when the server sends no agent, from
  the session's creation. Then `1 shell`, `2 agents`, `1 service` when there are any.
- Detail status line: `<word> · <branch> vs <base>`.
- Created line: `created 21m ago · <id> · agent up 4m`.

### S4. The agent ended; Services keep the workspace up

- Row word: the session's status (`idle` as the server folds it).
- Facts lead with the hold: `agent completed · 1 service keeps the workspace up · claude`.

### S5. The agent ended; the workspace is not being saved yet

The agent exited and Mend is finding out how its executor ended before the stop drain begins: the
session reads `stopping` and no drain is reported yet (up to about half a minute).

- Row word: `stopping`.
- Facts: `agent ended · workspace still up · claude`.
- Detail status line: `stopping · agent ended · workspace still up · <branch> vs <base>`.
- Worktree: `stopping`, never `settled`.

### S6. Stopping: the save is uploading

Status `stopping`, `captureDrain` `stop`, pending work reported.

- Row word: `stopping`.
- Facts: `saving · 12 MB left · claude` (`saving · 3 left` before sealantd reports bytes; `saving`
  when it reports neither yet).
- Worktree word: `stopping`; project: counted as `1 stopping`, never `settled`.

### S7. Stopping: uploaded, the save is waiting to be confirmed

Status `stopping` (or `starting`, for S2's drain), the drain reports nothing left: zero bytes, or
zero captures and no bytes.

- Facts: `uploaded · confirming the save · claude`. Never `saving · 0 B left`.

### S8. Stopping: the save stalled or cannot finish

The drain stopped moving; the workspace is kept.

- Facts: the domain's line, unchanged: `not saved · <why> · 3 pending · workspace kept`.

### S9. Settled

The session ended and its workspace is gone (`settledAt` set).

- Row word: `completed`, `failed` or `stopped`.
- Facts: `claude · ended 5m ago` (from `settledAt`; without it, `created 2h ago`).
- Detail status line: `<word> · <branch> vs <base>`.
- Created line: `created 2h ago · <id> · ended 5m ago`.

### S10. Failed to launch

Status `failed`, summary `launch failed: …`.

- Row word `failed`; facts `claude · ended 2m ago`.
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

- Facts: `from <base> · last start 5m ago`, then `2 open`, `3 sessions`, `empty` as today.

## Project states

- Section summary and header count `live` sessions (starting, running, waiting, idle) and, apart,
  `stopping` ones: `1 live`, `1 live · 1 stopping`, `1 stopping`, else `settled`.
- Project row: `<live>/<total>` as today; a stopping session counts as live there (its workspace
  is).

## What the server says, and where

- `LAUNCH_BUILDING_IMAGE` becomes
  `preparing the workspace · no runtime yet (an image build after an update takes about 8 minutes)`.
  The old words stay recognised in stored summaries.
- The capture line's drain with nothing left reads `uploaded · confirming the save` on every surface
  (web, phone, Slack, CLI), since they share `captureStatusLine`.

## Not covered here

- The web app, the phone and the desktop app keep their own layouts; only the shared domain words
  change for them.
- When a confirmation will end is not on the wire; the line says `confirming the save` without a
  time.
