# The agent's pull request, recorded when its turn ends and shown everywhere

- **Release:** 0.36
- **Status:** on main. Every PR below is merged.
- **PRs:** mend#488 (Claude workflows show while they run; the turn that reports them is kept),
  mend#489 (the agent's pull request is recorded when its turn ends; lists carry it), mend#490 (the
  phone: a card in the conversation, a line in the review, a fact on every row), mend#491 (the web:
  Now and the worktree tree link the change's pull request).
- **Decision records:** docs/adr/0007-landing.md, amended 2026-10-03 ("What Mend records and shows",
  "Pull requests opened outside Mend").
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`.

## Why it exists

People tell the agent, often from the phone, "open a pull request". The agent runs `gh pr create`.
Before 0.36 nothing in Mend showed that pull request until the agent stopped:

- `gh pr create` can push over HTTPS itself, which the workspace's git transport never sees, so the
  45 s look after a transport push never ran;
- a protocol (conversation) agent stays up between turns, so the remaining look, when the agent
  ends, came only at a Stop or the idle stop;
- lists had no pull request at all, and the phone had nothing to show either way.

The person then opened GitHub by hand or asked the agent again, and Mend's own landing, if automatic
landing was on, could open a second pull request beside the agent's.

Separately (#488), running a Claude workflow from the phone showed nothing: Claude reports a
workflow on `system` lines Mend dropped, and reports its end in a turn Claude opens itself, which
Mend had no turn for, so the workflow's result never appeared.

## What it does

- When a conversation turn ends that ran `gh pr create`, Mend asks GitHub (as the change's owner,
  with `gh`, in the owner's live workspace) about the pull requests the turn named, and records the
  first one GitHub says was opened since the turn started. It does this before automatic landing
  decides that turn, landing on or off, so a landing the same turn makes updates the agent's pull
  request instead of opening a second.
- Mend keeps each pull request's title (`pull_request_title`).
- **Phone** (protocol session): the conversation shows a card for each pull request the change's
  landings name, where Mend first recorded it; for the agent's own, that is the end of the turn that
  opened it. The card: eyebrow `pull request`, the state as a dot and a word, `#412` and the title,
  the branch, `opened outside Mend` or `opened by Mend's landing` (and `from <owner>'s fork`),
  `observed 2 min ago`, an amber `changed since landing · 3 files` when the worktree moved on,
  `Open on GitHub`, and `Refresh` (`Asking GitHub…` while it runs) for the change's owner only.
- **Phone** (terminal session): the newest pull request closes the transcript.
- **Phone review:** a line for the newest pull request above the change: `#412  <title>`, then
  `opened outside Mend · observed 2 min ago`.
- **Phone rows** on Now, Projects and a project's screen end with `#412 · open` and the title in
  cobalt; tapping opens GitHub, not the session.
- **Web rows** on Now (Needs you, Needs delivery, Ready to review, Live, each project's recent
  sessions) and each worktree in a project's tree show `#412 · open` and the title, opening GitHub
  in a new tab. The tooltip: `<title> · open · observed <time> · opened outside Mend`.
- The web session page's landing line and the change's Land panel show the newest pull request as
  before (`pull request #412 · open · observed`, `Open #412 on GitHub ↗`).
- **Claude workflows** (#488): a workflow, background agent or background command shows on the turn
  that started it as one task item that keeps updating after that turn ended. When Claude opens a
  turn of its own to report the end, Mend records it (`origin: harness`); the phone shows it as a
  quiet `the agent continued · …` row and the desktop labels it `the agent continued`. A session
  whose task still runs is never idle-stopped.

**Defaults.** On for every protocol session; there is no setting. Automatic landing has its own
settings (ADR 0007, "When it is on") and does not gate the look.

**In scope.**

- The look at a turn's end (#489), its inputs, its gating, its record.
- The newest-pull-request annotation on lists (#489) and every client that draws it (#490, #491).
- The phone's card, its placement, the review line, the terminal transcript, Refresh (#490).
- Harness-opened turns and task items (#488) as far as they bear on what is recorded and shown, and
  the idle stop's task hold.

**Out of scope.**

- Polling GitHub. A list's state is as old as its `observed`.
- Pull requests in other repositories than the project's own (a sibling repository's, a fork's URL
  the turn named in another repository).
- GitHub Enterprise or any host but `github.com`.
- A card in the web or desktop conversation; the web shows the landing line and list links only.
- Pull requests on desktop rows, VS Code, the CLI's `mend sessions`, the t3 gateway.
- Holding the "completed" push until a workflow ends (#488 Open).

## How it works

### The look at a turn's end (#489)

1. Automatic landing (`apps/api/src/automatic-landing.ts`) listens on `mend_events` and, per
   session, `consider`s every ended turn not yet decided (line 423). It claims each turn once in
   Postgres (`claimTurnLanding`), so no second worker or look handles it.
2. For a claimed turn, `lookForOpened` (line 401) runs first:
   - a turn that ended more than 15 minutes ago (`TURN_FRESHNESS_MS`) is history: no look;
   - `pullRequestUrlsOpenedIn(turnItems)` (`packages/landing/src/gh.ts:251`) returns nothing unless
     one of the turn's items of kind `command-execution` or `tool-call` matches
     `\bgh\s+pr\s+create\b` in its title, text or JSON data; then every
     `https://github.com/<owner>/<repo>/pull/<n>` anywhere in the turn's items (a command's output,
     or the agent's own message: Claude's harness records no tool output);
   - with URLs,
     `WorkspaceGitHooks.pullRequestOpened({sessionId, worktreeId, urls, since: turn.startedAt ?? createdAt})`
     (`packages/sessions/src/workspace-git-hooks.ts:84`).
3. The handler (`apps/api/src/pull-request-adoption.ts:126`) finds the change of the worktree and
   calls `Landing.adoptPullRequest({changeId, background: true, openedInTurn: {urls, since}})`,
   synchronously, inside `consider`, before `decide`. Every failure is logged
   (`landing: the look for a pull request opened outside Mend failed`) and swallowed; the decision
   follows either way.
4. `adoptPullRequest` (`packages/landing/src/landing.ts:775`):
   - the project's origin must be a GitHub repository (`pullRequestAvailability`), else skipped;
   - the change's owner (`changeOwnerOf`: the owner of the worktree's first session) must exist;
   - `pullRequestNumbersIn` keeps only URLs of the project's own repository (case-insensitive
     prefix), newest number first;
   - with `background: true`, nothing is asked when there is no agent commit, no agent push and no
     named number;
   - `gh` runs as the owner in the newest live session of the owner's in that worktree; with none,
     skipped (`no live workspace of the owner's to ask gh in`).
5. `PullRequests.find` (`packages/landing/src/pull-requests.ts:314`): first each named number,
   `gh pr view`, keeping the first whose `createdAt` is at or after `since − 2 min`
   (`CLOCK_SLACK_MS`); then the existing branch and commit lookups (ADR 0007).
6. A pull request already recorded for the change has its state refreshed on its row
   (`observePullRequest`). Otherwise a `change_landings` row is recorded with trigger and outcome
   `adopted`: number, URL, state, title, `observedAt`, head branch (or the worktree's), cross-
   repository and head owner, no pushed sha, `userId` = the owner, `sessionId` = the live session
   used. The adoption is audited (`auditAdoption`).
7. Then `decide` runs (ADR 0007's checks). A landing it makes chooses an adopted pull request's head
   on origin and updates that pull request; a fork's is never updated.
8. The other three looks stay: 45 s after a transport push that moved a branch (job
   `adopt-pull-request`, one per change while queued), when an agent ends while its workspace is up,
   and the owner's "Check GitHub" (`mend land <session> --check`).

### What lists read (#489)

9. Migration `0104_landing_pull_request_title` (`packages/db/src/migrations.ts`):
   `change_landings. pull_request_title text`, and the partial index
   `change_landings_project_pull_request_idx (project_id, change_id, created_at DESC) WHERE pull_request_number IS NOT NULL`.
10. `WorktreeChangesRepo.annotationsForProject` (`packages/db/src/repos/worktree-changes.ts:206`):
    each change's newest landing row with a pull request number
    (`DISTINCT ON (change_id) ORDER BY created_at DESC`), joined to every session of the project.
    `SessionAnnotation.pullRequest` and `WorktreeAnnotation.pullRequest`
    (`packages/api-contracts/src/workbench-views.ts:111`, `133`) carry
    `{number, url, state, title, observedAt, adopted}` (`ChangePullRequest`,
    `packages/domain/src/workbench/landing.ts:62`), or null when any of number, URL, state or
    observed is missing. One indexed read; GitHub is never asked.

### The phone (#490)

11. `pullRequestCards(landings)` (`apps/mobile/src/data/pull-requests.ts:69`): one card per pull
    request number across the change's landings (`GET /sessions/:id` `landings`, newest first),
    walked oldest first. Each card shows the newest landing's report (state, observed, branch, fork)
    and keeps the first landing's `recordedAt`; it is `outside` when the first landing that named it
    was an adoption; the title falls back to an earlier landing's.
12. `withPullRequests(rows, cards)` (line 126): each card goes before the first conversation row
    whose time (turn `createdAt`, item `createdAt`, request `createdAt`; an unsent row is +∞) is
    after the card's `recordedAt`, else at the end.
13. `SessionPullRequest` (`apps/mobile/src/components/pull-request-card.tsx:152`) reads
    `GET /sessions/:id/landings` every 30 s while a card is on screen (`useSessionLandings`) for the
    `changed-since-landing` fact and the `land` flag; Refresh is `POST /landings/:id/refresh` for
    the newest landing naming that pull request. The route refuses anyone but the change's owner who
    made that landing row (`apps/api/src/routes/landing.ts:263-276`) and audits
    `change.pull_request_refreshed`.
14. Terminal sessions: `newestPullRequest` closes the transcript (`pty-conversation.tsx`). Review:
    the newest as a line (`app/review/[id].tsx`). Rows: `session-row.tsx` from the annotation,
    `pullRequestFact` → `#412 · open`; `openPullRequest` → `Linking.openURL(url)`.
15. States read: `merged` with the `observed` tone, `open` and `closed` with `pending`
    (`pullRequestTone`).

### The web (#491)

16. `PullRequestLink` (`apps/web/src/components/pull-request-link.tsx`):
    `<a href=url target="_blank" rel="noreferrer">`, an icon per state, `#412 · open`, the title.
    Used on Now rows (`apps/web/src/routes/index.tsx:224`, `374`; `CardWithPullRequest` keeps the
    card link and the pull request link as siblings, never nested) and the worktree tree
    (`components/project-detail/worktree-tree.tsx:203`).

### Turns Claude opens itself, and task items (#488)

17. `packages/agent-protocol/src/claude-tasks.ts` folds `task_started`, `task_progress`,
    `task_updated` and `task_notification` into one `task` item (`AgentTaskData`) on the turn that
    started the task; the host keeps updating it after that turn ended.
18. A `system init` while no turn is open opens a turn with `origin: "harness"` (migration
    `0105_turn_origin`, `agent_turns.origin` in `request|harness`), id from the line's uuid, input
    the notification's summary (`AgentConversationRepo.openHarnessTurn`,
    `packages/db/src/repos/agent-conversation.ts:513`). A message sent meanwhile is refused by the
    adapter (`AgentTurnBusyError`), put back in the queue (`requeueClaimedTurn`) and sent when the
    harness turn ends (`packages/sessions/src/protocol-host.ts:197`).
19. Automatic landing decides a harness turn by the request behind it: the latest `request` turn
    that started at or before it (`requestBehind`, `automatic-landing.ts:121`), its author and
    intent.
20. Idle stop: a running task holds the session (`protocolIdleReading`,
    `packages/domain/src/workbench/protocol-idle.ts`, hold `task`); the idle clock counts from the
    task's last change. A process that ends marks its unfinished tasks `stopped`.

### Ordering and restart

- The look and the decision run in one fiber per session (`looking`/`again` sets); a burst of events
  is one look plus one more.
- A server restart: the sweep at start (`sweep`) considers every active session's undecided ended
  turns, within the 15 minute freshness.
- The turn claim is durable; a look that failed is not retried for that turn.

## Happy path

Alice owns session `fix-login` in project `api` (origin `github.com/acme/api`), a Claude
conversation, automatic landing off.

1. From her phone she sends "open a pull request for this". The turn runs `gh pr create --fill`;
   Claude's reply says `Opened https://github.com/acme/api/pull/412`.
2. The turn ends. Within seconds Mend runs `gh pr view 412` as Alice in her live workspace, sees it
   was created two minutes ago, after the turn started, and records an adoption.
3. On her phone, right below Claude's reply, a card: `pull request · ● open`,
   `#412 Fix the login redirect`, `mend/fix-login`, `opened outside Mend`, `observed just now`,
   `Open on GitHub`, `Refresh`.
4. Bob opens the web app's Now page; the `fix-login` row under Live ends with
   `#412 · open Fix the login redirect`. He clicks it; GitHub opens in a new tab. He sees no Refresh
   anywhere: he is not the owner.
5. Alice sends "also handle the expired-token case". The agent pushes more commits. The card stays
   where it was. This turn ran no `gh pr create`, so its end looks for nothing; the push through the
   transport queues the 45 s look, which finds #412 already recorded and refreshes its state on its
   row. No second card appears. She presses `Land →` on the web; Mend pushes and updates #412 (no
   second pull request). The card's `observed` moves on.
6. The pull request is merged on GitHub. Alice presses Refresh on her phone: `Asking GitHub…`, then
   `● merged`. The rows read `#412 · merged` at their next refetch.

## Invariants

1. A pull request is recorded by the turn look only if it is in the project's own GitHub repository,
   was named by a turn that ran `gh pr create`, and GitHub says it was opened no earlier than two
   minutes before that turn started.
2. The look runs before that turn's landing decision; a landing decided for the same turn never
   opens a second pull request beside one the look found.
3. `gh` is run only as the change's owner, only in a live workspace of the owner's own sessions for
   these background looks; no other person's GitHub credential is used.
4. Each turn is looked at once at most (the claim); a pull request already recorded for the change
   gets its state refreshed, never a second row.
5. Lists never ask GitHub: every list's pull request comes from the newest landing row that names
   one, with the time it was observed.
6. Refresh is offered and accepted only for the change's owner on a landing row they made.
7. A pull request opened from a fork is shown and never updated.
8. Status words are observed facts (`#412 · open`, `observed 2 min ago`, `opened outside Mend`);
   nothing says ready, mergeable or approved.
9. A harness-opened turn is never treated as authorless for landing: it carries the request behind
   it.
10. A running background task never lets the idle stop end the session; an ended process leaves no
    task running.

## Edge cases and failure behaviour

**Concurrent actions**

- Two workers see the same turn end: one claims it; the other skips it.
- A message sent while a harness turn runs: refused by Claude's adapter, requeued, sent after; it is
  listed above that turn (ordinal order) though answered after it (#488 Open).
- A follow-up queued while the turn that opened the pull request ran: its turn row's `createdAt` is
  earlier than the card's `recordedAt`, so on the phone the card appears after the queued request.

**Partial failures**

- `gh` fails (no GitHub account connected, network, rate limit): logged; nothing recorded; the
  decision proceeds; the next look (agent end, a push, Check GitHub) finds it.
- The owner has no live session in the worktree (the turn was a teammate's session in the owner's
  worktree, with the owner's own session stopped): skipped; nothing shown until a later look.
- The turn named the URL only in a command's output that the harness did not record and in no
  message: nothing to look up; found later by the branch or commit lookups.

**Odd input**

- The turn ran `gh pr create` but it failed, and its message cites an older pull request: GitHub's
  `createdAt` is before the turn; not adopted (unless within the 2 minute slack).
- The turn names several pull requests of the repository: newest number first; the first opened
  since the turn wins.
- A pull request in another repository (a sibling repository at `/workspace/repos/<name>`, a fork,
  another project): not recorded for this change.
- A GitHub Enterprise or non-`github.com` URL: not matched.
- A workflow or background agent (a Claude task) that runs `gh pr create`: its command is inside the
  task item of an earlier, already-decided turn, and the harness turn that reports it ran no
  command; no turn-end look. Found at agent end, after a transport push, or by Check GitHub.
- A pull request title that is null (rows before 0104, older servers): the phone shows
  `pull request`, the web shows the number and state only.

**Restarts**

- Mend restarts after a turn ended but before it was considered: the start sweep considers it if it
  ended less than 15 minutes ago; older turns are history (no look, skipped decision).
- A workflow running across a server upgrade: the rehydrate replay rebuilds it; harness turns from
  before the upgrade are not in the record, so their output can attach to the next turn.

**Older data**

- Landings before 0104 have no title; annotations show none.
- Sessions with adopted rows from before 0.36 show their cards in the conversation by `createdAt`.

**Permissions**

- Owner: sees, refreshes, lands.
- Member who can see the project: sees rows, cards, review line; no Refresh (the route answers
  `only the change's owner lands it`).
- Steerer: as a member; a steerer's turn that ran `gh pr create` still triggers a look as the owner,
  but its landing decision is "not the owner" (ADR 0007).
- Operator: nothing of organization content.

**Every client**

- Phone: cards, review line, terminal transcript, rows.
- Web: Now rows, worktree tree, session landing line, Land panel.
- Desktop: the Land panel and landing facts as before; no row link.
- CLI: `mend land`, `mend land --check` print the pull request; `mend sessions` does not.
- Slack: the thread's status line as before (ADR 0006/0007).
- VS Code, t3 gateway: nothing.

## Known limits

- Mend does not poll GitHub; states are as old as their `observed` (ADR 0007).
- Only protocol (conversation) turns have a turn end. A terminal session's pull request is found
  when its agent ends, 45 s after a transport push, or by Check GitHub.
- A turn that only starts a workflow rings the "completed" push when it ends, before the workflow
  ends (#488 Open).
- `MEND_MODE=api` and `worker` split: `WorkspaceGitHooks` is in-process; handlers are registered by
  the worker's `PullRequestAdoptionLive`. The turn look runs in the worker too, so it is covered;
  reports the engine makes in an api-only process reach no handler.

## How to verify

**Tests.**

- `apps/api/src/automatic-landing.test.ts:937` (look when the turn ends, landing on or off), `:960`
  (no look without `gh pr create`, or for history), `:468` (a harness turn decided by its request).
- `packages/landing/test/gh.test.ts:206`, `:226` (URL scan).
- `packages/landing/test/pull-requests.test.ts:347` (takes the named pull request opened during the
  turn).
- `packages/db/test/landing.test.ts:271`, `:391`, `:463` (records, adoption, newest pull request per
  change with `adopted`).
- `apps/mobile/src/data/pull-requests.test.ts` (cards, fork, placement), `routes.test.ts`,
  `contract-shapes.test.ts`; `apps/web/src/components/pull-request-link.test.tsx`.
- `packages/agent-protocol/test/claude-tasks.test.ts`,
  `packages/sessions/test/protocol-host.test.ts`, `packages/db/test/migrations.test.ts` (harness
  turns, requeue, task activity), `packages/domain/test/protocol-idle.test.ts`,
  `packages/jobs/test/protocol-idle-stop.test.ts`.
- Not covered: a real `gh` in a real workspace end to end; the phone card on a device (#488's task
  card was rendered with react-native-web only).

**By hand on the box.**

```sh
mend claude "make a one-line README change, commit it, push it and open a pull request with gh" -d
# after the turn ends:
psql "$DATABASE_URL" -c "select trigger, pull_request_number, pull_request_state, pull_request_title, pr_observed_at from change_landings order by created_at desc limit 3"
```

Then check the phone's conversation card, the web Now row, and Refresh from the owner's phone.

**Signals.** Logs `automatic landing: <decision> · <why>`,
`landing: a pull request opened outside Mend was adopted`,
`landing: the look for a pull request opened outside Mend failed`; audit
`change.pull_request_refreshed`.

## Divergences found while writing

- `apps/api/src/automatic-landing.ts:401-413` with `packages/landing/src/gh.ts:251-264`: a pull
  request opened inside a Claude task (workflow, background agent) is never looked for at a turn's
  end: the command lives in a task item on a turn already decided, and the harness turn that reports
  it has no `command-execution`/`tool-call` item. #488 and #489 shipped together without covering
  their meeting point.
- `packages/landing/src/landing.ts:814-825`: the turn look runs `gh` only in a live session of the
  change's owner. A teammate's conversation session in the owner's worktree whose turn opens a pull
  request records nothing while the owner's own session is stopped, though the teammate's workspace
  is live. Consistent with "gh speaks as the owner", but the ADR's "shown as soon as the turn ends"
  does not hold there.
- `docs/adr/0007-landing.md` "What Mend records and shows" (amended 2026-10-03): "A session's
  conversation shows a card for each pull request where Mend first recorded it". Only the phone
  does; the web session page and the desktop show the landing line and Land panel, with no card in
  the conversation.
- `apps/mobile/src/data/pull-requests.ts:107-118`: placement compares the card's `recordedAt` with a
  turn's `createdAt`, the time it was queued; a request queued while the opening turn ran sorts
  before the card.
- `packages/landing/src/pull-requests.ts:118-123`: the two-minute clock slack lets a pull request
  opened up to two minutes before the turn started, and only mentioned in it, be adopted.
- `packages/landing/src/pull-requests.ts:317-327`: a named pull request is taken whatever its head
  branch; one the agent opened from an unrelated branch of the same repository becomes this
  change's, and the next landing pushes the change to that branch and updates it.
- `apps/api/src/pull-request-adoption.ts:51`: the comment says "Look once, in the background", and
  the header lists "Two moments" then three, then "the third, on demand" as a fourth. The turn look
  runs inline in `consider`, holding that session's decision while `gh` answers.
