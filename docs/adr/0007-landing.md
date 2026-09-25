# Landing: push a change and open its pull request

Status: proposed 2026-09-23, amended 2026-09-24 with automatic landing, and again the same day: Mend
never moves the session's branch, the change's owner lands it, and pulling a change has no side
effects. Commits Mend to one landing action. Mend commits what the worktree holds, pushes it to a
branch on the project's origin, and opens or updates a GitHub pull request whose description is
Mend's review tour. Like Cursor, it can do this automatically when the agent finishes a turn, and it
does not do it for a request that asked a question rather than for a change. Merging stays on
GitHub, and landing again after more work updates the same branch and pull request. The ADR also
makes landing observable: what was pushed, by whom, and whether origin still has it.

**What this ADR does not claim.** It does not make Mend decide whether a change should merge. There
is no approve control, no merge button and no "ready" state. Landing is publication (plan §5.9): it
publishes a change so people can review it where the project already does that, and it stays
optional.

## Context

Nothing on `main` gets a change out of Mend. No surface commits, pushes, opens a pull request,
merges or exports. That covers the API, the CLI, the web, mobile, desktop and VS Code. Plan M5 ("Add
commit creation", "Add optional GitHub PR creation or attachment", "Export the change overview into
the PR while retaining deep links to Mend") has not started.

The one way out today is git inside the workspace:

- The session's workspace has `core.sshCommand` set to Mend's shim. The host carries the SSH
  transport, signs it with the project's `gitAuthMode` (the owner's Mend key, the owner's shared
  agent, or the host's own SSH), and refuses any host other than the origin's
  (`MEND_GIT_TRANSPORT_BIND_ORIGIN`). So `git push` from the agent or from `mend shell` works.
- Every such operation is recorded in `session_git_ops`, including the refs a push updated. Nothing
  reads that table.
- Every harness launch asks for the owner's GitHub connected account, which the platform injects as
  `GH_TOKEN`. `gh` is a default workspace package. So `gh pr create` inside a session works when the
  owner has connected GitHub.

Four facts shape the decision:

1. **Mend cannot read the GitHub token.** `ConnectedAccountsApi` has `list`, `connect` and
   `disconnect`. The token exists only on the platform and in the workspaces it builds. Host `gh`
   exists, but `github-identity.ts` allows it only for the operator on a `single` instance.
2. **The host already owns clone, fetch and push** (decision log 2026-08-14), with the project's
   auth mode. ADR 0002 says landing "pushes with Mend's server-side credentials (the Mend key or the
   bridge), never from an executor".
3. **Checkpoints already snapshot the worktree** without touching HEAD, the index or files
   (`Store.checkpoint`: `add -A` into a throwaway index, `write-tree`, `commit-tree`, and a hidden
   `refs/mend/checkpoints/…` ref). A checkpoint's tree is exactly "what the worktree holds".
4. **Worktree removal asks the user to "review, export, commit, or discard"** the change first, and
   there is no export. It compares against the worktree's recorded base, so a change that was
   already pushed still reads as unlanded.

## Decision

### One action: land

Landing a change runs these steps, in this order, and stops at the first that fails:

1. **Checkpoint.** Mend takes a checkpoint now, so the landed content is a recorded object and not a
   live tree that the agent may still be writing.
2. **Commit what the agent left uncommitted.** The agent's own commits are pushed exactly as they
   are. Mend squashes nothing and rewrites nothing. Mend adds a commit only for work the agent did
   not commit:

   ```
   agent committed everything     main ── A1 ── A2          Mend adds nothing
   agent committed some of it     main ── A1 ── A2 ── M     M holds only the leftovers
   agent committed nothing        main ── M                 M holds the whole change
   ```

   The third case is the usual one: Claude Code and Codex rarely commit unless asked. `M` has the
   checkpoint's tree. Its author and committer are the change owner's name and email. Its message
   comes from the tour's summary when a tour exists, and from the session's label otherwise, with a
   `Mend-Session:` trailer that links to the session. Mend writes it with `commit-tree` against the
   store, so the worktree's files, index and HEAD are never touched.

   **Mend never moves the session's branch.** `mend/<name>` in the store, and the executor's branch
   for a capture-backed session, stay where the agent left them. `M` is a commit only Mend refers
   to, kept reachable under `refs/mend/landed/<worktree>`, never under `refs/heads`. Moving the
   agent's branch would leave the worktree's index behind a commit it never made, and an agent that
   commits next would make that commit on top of `M` or beside it. What `M` is parented on follows
   from three commits: `L`, the commit the change's last landing pushed; `H`, the agent's branch
   head as the checkpoint saw it; and `T`, the checkpoint's tree.

   ```
   first landing, H has tree T            push H                 nothing written
   first landing, otherwise               M = T on H             push M
   landed before, T is L's tree and
     the agent added nothing past L       nothing new            reported, nothing written
   landed before, the agent added
     nothing past L                       M = T on L             push M
   landed before, H is built on L         as a first landing, from H
   landed before, the agent committed     M = T on L and H       push M, a merge of both
   ```

   So the agent's commits keep their history, nothing is rewritten, and every push fast-forwards
   from `L`. A landing that finds nothing new since the last one says
   `nothing new since the last landing` and records nothing, unless the last landing did not finish
   its pull request, or the owner gave a new title or description.

3. **Push.** The host pushes the landed commit to origin, as `refs/heads/mend/<name>` unless the
   owner names another branch, using the project's `gitAuthMode` and the change owner's key. The
   push only fast-forwards. If origin's branch has commits that Mend's branch does not, landing
   stops and says so. Mend never force-pushes. The branch is never the project's default branch or
   the pull request's base, and a landing that did not push leaves no branch name for the next one
   to reuse.
4. **Pull request.** Optional, and on by default when origin is on GitHub. Mend opens a pull request
   from the pushed branch into the session's base branch, or updates the one it opened before. See
   below for where this step runs.

Landing again after follow-up work repeats the same steps. It adds commits to the same branch and
updates the same pull request.

A project whose origin is not on GitHub gets steps 1 to 3. Step 4 is shown as unavailable, with the
reason.

### Automatic landing

Cursor pushes its agent's branch and opens the pull request itself when a run completes
(`autoCreatePR`). Mend does the same when automatic landing is on: after each turn that completes,
Mend lands the change, and the first landing opens the pull request while later ones update it.

**When it is on.**

- A session started from Slack lands automatically, unless the Slack app's "Land automatically"
  setting is off (it is on by default, as in Cursor) or the request says `autopr=false`.
- A session started from the web or the CLI lands automatically only when its project's "Land when a
  turn completes" setting is on. It is off by default, and the composer and `mend` can override it
  for one session (`--land` / `--no-land`).
- A project can turn it off for every session, Slack included. The project's "off" wins over the
  Slack setting and over `autopr=true`.
- Only protocol turns land by themselves. A terminal session (PTY) has no turns Mend sees end, so it
  never lands automatically, whatever the settings say. `mend land` and the Land panel land it.

**When a completed turn lands.** All of these must hold, and Mend checks them in this order:

1. The turn completed. A turn that failed, was interrupted or was cancelled never lands.
2. The agent is not waiting on a question or an approval.
3. The change owner sent the turn, in a session they own. A follow-up sent by someone else under
   shared control does not land automatically, and neither does a turn in a session a teammate
   started in the owner's worktree, because landing pushes and speaks as the change owner. Mend
   offers the owner the button. A turn with no recorded sender never counts as the owner's: review
   comments sent back to a session record the person who sent them.
4. The change is not empty. The checkpoint's tree differs from the base branch's tree. A turn that
   touched nothing, or put every file back, lands nothing and says nothing about landing.
5. The request asked for a change, as below.

**Questions do not open pull requests.** People ask `@mend why does the login test flake?` as often
as they ask for a fix, and an answer is not a pull request. Mend guards this twice.

- **The prompt.** The opening turn Mend composes for a Slack request, and for any session with
  automatic landing on, tells the agent three things. If the request is a question, answer it and
  change no files. Change code only when the request asks for a change. Never push and never open a
  pull request, because Mend publishes the change. The agent may still commit.
- **The request's intent.** Mend uses inference to read each request as `change` or `question`, from
  the request and its thread context. For Slack this is the same call that reads the thread for its
  project, so it costs no extra call there. Web and CLI sessions with automatic landing on make one
  small call per turn. A session lands automatically only after a turn whose request read as
  `change`. A follow-up that asks for a change turns landing on for the session, even when the first
  request was a question. `autopr=true` and `autopr=false` in the request override the reading.

When a question still left files changed, Mend does not land. The thread, or the session page, says
`changes not landed · the request read as a question`, with a "Push and open pull request" button.
When the reading is unavailable, because inference is off or over its budget, Mend treats the
request as a change and relies on the prompt and the empty-change check. The status says
`intent not read`. A spurious pull request is easy to close, and a missing one is the failure people
notice.

**What the thread sees.** The status line gains the branch and the pull request
(`pushed · mend/fix-login · pull request #412 · opened`). Later landings update that line, and they
do not add a new message each time. The pull request opens with the file list and the links. Its
description gains the tour when the tour completes: when a landing finds no tour, Mend queues the
tour and does not wait for it, and when the tour completes for a change whose pull request Mend
opened and GitHub last reported open, the worker updates Mend's section of the description through
the same pull request step. Each tour updates a pull request once.

**Failure is reported and does not retry.** If a push is refused (origin moved, branch protection,
no write access) or the pull request step fails (no GitHub account connected, `gh` refused), the
landing records the outcome, the status line says it in the remote's own words, and nothing retries
until the next completed turn or a manual landing.

### Where each step runs

Steps 1 to 3 run on the host, against the store, like every other git write Mend makes. For a
capture-backed session (ADR 0002), the checkpoint and commit are made in the runner cache that
already serves its review diff, and the push goes from there. It is the same plumbing and never an
executor.

Step 4 needs the owner's GitHub token, which only a workspace holds. So Mend runs it in a workspace
through the SDK (`exec`):

- in the session's own workspace when it is live;
- otherwise, in a short-lived workspace for the change owner with the GitHub credential and nothing
  else: no worktree, no dotfiles and no secrets. It is destroyed when the call returns.

The session's own workspace is used only when that session is the change owner's, so `gh` never runs
with a teammate's token. The short-lived workspace is not as small as it should be. The SDK requires
a harness and a source for every workspace, so Mend names a harness it never starts and mounts an
empty directory from under the store root (PLATFORM-FEEDBACK.md, 2026-09-24). A runtime that takes
no host mounts, such as the MicroVM executors of the AWS private beta, refuses that workspace.
There, a pull request for a session whose workspace is gone fails, and the landing records the
platform's own words as the pull request step's failure, until the platform half ships. The push has
already happened by then and is recorded as such.

The call is `gh pr create` or `gh pr edit`, reading the body from a file Mend writes, with the
repository and branch given explicitly. Mend reads the pull request's number, URL and state from
`gh`'s JSON output. The token never reaches Mend's process or database.

This is the one place where landing depends on a workspace. A platform call that makes a GitHub
request as a user, or hands a short-lived token to the service principal, would move step 4 onto the
host like the others. That is recorded as platform feedback. Mend does not work around it.

### The pull request's description

The description is the review tour's summary and approach, then the changed files with their line
counts, then links back to Mend: the session, the review, and the checkpoint that was landed. The
section Mend writes sits between two HTML comment markers. On update, Mend replaces only that
section, so anything a person wrote above or below it survives.

The title is the session's label. The owner can edit the title and description before landing, and
an edited title is kept on later updates.

The description is evidence, not a verdict. It says what changed and what the record shows, and
never "ready to merge", "tested" or "safe". Checks that ran appear only as the record shows them
(`npm test · exit 0 · observed`), and checks appear once Mend records them. Until then the
description lists none.

If no tour exists yet, the pull request opens with the file list and the links, and says it has no
summary. Mend queues the tour, and the description gains it when the tour completes, as above. When
the project's inference is off, the tour does not complete and the description keeps the file list.

### Who lands

Only the change's owner lands it. A worktree holds one change and can hold many sessions, and a
teammate can start a session in someone else's worktree. The change owner is the owner of the
worktree's first session, the one that started the change. Landing pushes with the change owner's
key, `gh` speaks on GitHub as them, and Mend's commit is authored by them. So shared control does
not extend to landing, joining a teammate's worktree does not, and neither does being an
organization owner. Manual landing and refreshing a pull request's state need the change owner.
Automatic landing needs a turn the change owner sent in a session they own. Anyone who can see the
project can see the landing record.

A change whose first session has no owner, or whose owner has no GitHub account connected, cannot
open a pull request from Mend. The push still works if the project's auth mode allows it.

### What Mend records and shows

A `change_landings` row for each landing records:

- the change and the checkpoint that was landed;
- the commit Mend wrote, or none;
- the remote branch and the sha that was pushed;
- the pull request's number, URL and state as `gh` last reported it;
- the change owner, the time and the outcome.

It is audited like any other action with the owner's credentials.
`nothing new since the last landing` is not a landing and records no row.

The review page shows landing as observed facts:

- `pushed · mend/fix-login · 3f2a1c0 · observed` after a push;
- `pull request #412 · open · observed 2 min ago`;
- `origin has moved · mend/fix-login has 2 commits Mend has not seen` when a fetch shows the branch
  diverged;
- `changed since landing · 3 files` when the worktree has moved past the landed checkpoint.

Pushes the agent made itself come from `session_git_ops`:
`pushed by the agent · refs/heads/wip · 91bd2e4`. Mend shows them beside its own landings and does
not treat them as landings. They did not go through this path, and the ADR 0002 lease does not fence
them. A pull request opened from one is adopted (below) and reads
`pull request #368 · open · observed · opened outside Mend`.

A pull request's state is refreshed each time Mend runs step 4, and when the change owner asks for
it from the review page. Refreshing needs a workspace for the same reason step 4 does. Mend does not
poll GitHub.

"Check origin" fetches origin's branch as the person who asked, into a ref Mend deletes afterwards,
so nothing lands under `refs/remotes`. Anyone who can see the change may ask, and each account's
checks are bounded by a request budget like other calls to a remote.

### Pull requests opened outside Mend

The prompt tells the agent not to push or open a pull request, and it may do both anyway: through
the workspace's git transport and `gh`, or over HTTPS to a fork of its own. A person may open one by
hand. Mend adopts such a pull request instead of opening a second one beside it (amended 2026-09-25,
closing open question 4).

An adoption is a `change_landings` row with trigger and outcome `adopted`: the pull request's
number, URL and state as `gh` reported them, its head branch, whether its head is in another
repository (a fork) and whose, and no pushed sha. So the commit planning above (`L`, `H`, `T`) never
builds on it, and it pushed nothing.

Mend looks with `gh`, as the change's owner:

- the worktree's branch and every `refs/heads/*` the agent pushed through the transport
  (`session_git_ops.ref_updates`, newest first), keeping only pull requests whose head is on origin.
  A fork's branch of the same name is someone else's, and `gh pr list --head` matches it too, so the
  lookup that finds the pull request to update skips it as well;
- then any pull request into the repository that holds the agent's head commit, a fork's included.
  This finds a pull request whose branch Mend never saw, pushed over HTTPS to a fork.

It looks 45 seconds after a push through the transport that moved a branch, when an agent ends while
its workspace is still up (the last moment `gh` can run there), and when the owner presses "Check
GitHub" in the Land panel (`mend land <session> --check`), even when nothing has landed. The first
two only ever use a live workspace of the owner's and ask nothing when the agent neither committed
nor pushed. The owner's check may use a short-lived workspace, as step 4 does. A pull request
already recorded has its state refreshed instead of a second row.

The next landing then chooses its branch in this order: the one the owner names, the one the
change's last landing pushed, the one the agent last pushed itself, an adopted pull request's head
on origin, the worktree's own. It passes the adopted pull request as the one to update. A pull
request from a fork is shown
(`pull request #367 · merged · observed 2 min ago · opened outside Mend · from anna's fork`) and
never updated: Mend pushes to origin only, the Land button reads "Push to origin", and a landing
skips its pull request step with that reason rather than open a second pull request.

### Worktree removal

Removal stops asking for an export that does not exist. A worktree whose latest checkpoint's tree is
on origin, according to the last landing and a fetch, is removable without `force`. So is one whose
last landing's pull request GitHub last reported merged, even after origin's branch was deleted,
because a squash merge leaves no ancestry to fetch. Anything else is refused, as it is today, and
the refusal names what is unlanded: files and line counts since the last landing.

Landed branches are `mend/*` on origin, like the session branches in the store. Refreshing a project
from origin skips `mend/*`, so a landed branch never collides with the session branch a worktree has
checked out, and the base picker does not offer them.

### Pulling a change into your own checkout

`mend pull <session>`, run inside a local clone of the same repository, fetches the change's branch
into it as `mend/<name>`. The CLI downloads a git bundle from the API (`GET /changes/:id/bundle`),
which contains the commits from the session's base to the latest checkpoint. Mend commits the
checkpoint's leftovers exactly as step 2 does, without pushing. So pulling works without origin,
before landing, and for projects whose origin nobody can push to.

A download has no side effects on the owner's history. It moves no branch and writes nothing under
`refs/heads`: the bundle is built from a temporary ref in a scratch repository that is deleted
afterwards, and Mend's commit for the leftovers, authored by the change owner, exists only in the
bundle. When the change owner downloads it, Mend takes a checkpoint first. Anyone else gets the
latest checkpoint that already exists, so pulling someone's change never adds to their record.

The bundle endpoint is authorized like the review diff. It is bounded by the request budgets,
refuses a bundle over a size limit with the size in the answer, and every download is audited
(`change.bundle_downloaded`).

This closes plan open decision #8 in one direction: the person pulls from Mend. Mend does not push
into anyone's checkout.

### Surfaces

- **Web:** a Land panel on the change page. It shows the branch, the base, the pull request title
  and description preview, the observed facts above, and one button, "Push and open pull request",
  which reads "Push and update pull request" once there is one. The session page links to it.
- **CLI:** `mend land <session> [--branch <name>] [--no-pr] [--title …]`,
  `mend land <session> --check` (look for a pull request opened outside Mend), and
  `mend pull <session>`.
- **Slack (ADR 0006):** lands automatically as above, and the status line carries the branch and the
  pull request. When a request did not land (a question, automatic landing off, a follow-up from
  someone other than the owner), the end-of-session reply has a "Push and open pull request" button,
  shown to everyone and acting only for the change owner. Anyone else gets an ephemeral refusal. The
  Slack app gains the "Land automatically" setting and the `autopr=` option, and ADR 0006's Cursor
  table and its "No PR" row are corrected to match.
- **Web and CLI composer:** the per-session automatic-landing override, and the project setting
  "Land when a turn completes".

## Consequences

- Product language gains `landing` (one push, plus its pull request, recorded against a checkpoint)
  and `landed checkpoint`. `AGENTS.md` and plan §5.9 need amending.
- Mend writes commits for a session for the first time. It does so only when it lands or pulls, only
  with `commit-tree` against the store or the runner cache, and never on the session's branch, so
  nothing the agent sees in its worktree changes. What origin's branch holds is the agent's commits
  plus Mend's, sometimes joined by a merge commit when the agent committed after a landing.
- With automatic landing, a Slack request that asks for a change produces a pull request on GitHub
  without anyone pressing a button. That is Cursor's default and the reason to copy it. The guards
  above decide when it happens, and the project setting can turn it off.
- Reading a request's intent is inference Mend runs per request. It is one call for Slack, where it
  shares the project-picking call, and one small call per turn for web and CLI sessions that land
  automatically.
- A pull request needs a workspace for a few seconds when the session is not live. That is paid in
  workspace start time on every such landing, until the platform half ships.
- A pull request is authored as the change owner. That is the honest identity: it is their
  credential and their change. A teammate who joined their worktree lands nothing.
- Mobile and desktop show no landing facts yet. That is outside this ADR.
- Squash-merged pull requests are recognized only by the pull request's state, because a squash
  leaves no ancestry to follow. That state is only as fresh as the last refresh.

## Delivery

One ready-for-review PR per step, stacked:

| PR  | What it delivers                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | This ADR, the product-language amendments, and the platform feedback for a GitHub call as a user.                                                                                  |
| 2   | Schema and domain: `change_landings`, landing outcomes, the observed landing facts.                                                                                                |
| 3   | Store and runner: the landing commit from a checkpoint's tree, fast-forward-only push with the project's auth mode, divergence detection, and the git bundle.                      |
| 4   | The pull request step: the workspace `exec` of `gh pr create` / `gh pr edit`, the short-lived workspace, the description with its markers, and reading back number, URL and state. |
| 5   | API: land, landing record, bundle and refresh routes; change-owner authorization; audit; `session_git_ops` exposed; worktree removal that recognizes a landed change.              |
| 6   | Automatic landing: the per-turn trigger and its five checks, the intent reading in `@mend/inference`, the prompt guard, the project setting and the per-session override.          |
| 7   | Web: the Land panel, the session page link, the project setting and the composer override.                                                                                         |
| 8   | CLI: `mend land`, `mend pull`, and `--land` / `--no-land`.                                                                                                                         |
| 9   | Slack: automatic landing from Slack, `autopr=`, the "Land automatically" setting, the status line, the button, and ADR 0006 corrected. Stacked on the Slack stack.                 |

PRs 2 and 3 depend on nothing else. After PR 5, landing works from the API and every client can use
it. After PR 6, sessions land themselves. PR 9 is the Cursor experience end to end.

## Decision log

1. **Push and open a pull request, not merge.** Review of a published change happens where the
   project already reviews, and a merge is a verdict Mend does not give. This is Cursor's model and
   plan M5's.
2. **The owner's GitHub account, not a GitHub App.** It is already connected, already in every
   workspace, and needs no new setup. A GitHub App remains the better answer for teams that want
   pull requests opened by a bot identity, and nothing here prevents adding one.
3. **The pull request call runs in a workspace, not on the host.** The token lives on the platform
   and in workspaces, and Mend does not import platform internals to read it. Asking the platform
   for the missing call is the rule.
4. **Commit a checkpoint's tree, not the live worktree.** A live tree can change under the commit. A
   checkpoint is recorded, and the landing names it, so "what was landed" has one answer.
5. **Fast-forward only.** A force push can destroy a teammate's commits on the branch, and Mend
   would be the one that did it.
6. **Only the change's owner lands.** Landing speaks as the owner on GitHub and pushes with their
   key. Shared control lets others steer an agent, and a teammate may start a session in someone
   else's worktree. Neither lets them publish as someone else. The change's owner, not the calling
   session's, is the one identity a landing uses.
7. **Pull from Mend with a bundle.** It works before landing and without origin, and it needs no git
   server in Mend.
8. **Land automatically, as Cursor does.** A pull request the requester did not have to ask for is
   what makes `@mend fix …` in Slack finish the job. It is on by default for Slack and off for
   sessions people run themselves, where they are already watching the change.
9. **Guard questions twice.** The prompt stops most unwanted edits, and the intent reading catches
   the rest before they are published. The empty-change check alone would publish a question whose
   answer the agent wrote into a file.
10. **Push the agent's commits, add one for leftovers.** Squashing would destroy the agent's
    history. Asking the agent to commit would make landing depend on a live agent doing it
    correctly. Refusing would make the common case, an agent that never commits, fail.
11. **Never move the session's branch.** The first version moved `mend/<name>` to Mend's commit. In
    a co-located worktree that left the index behind a commit the agent never made. In a
    capture-backed one the executor never saw the commit, so the next landing diverged from origin
    as soon as the agent committed. Keeping Mend's commit under `refs/mend/landed/` and parenting
    the next one on the last landing and the agent's head fixes both and still only fast-forwards.
12. **Pulling is a read.** A bundle download by anyone who can read the review diff must not change
    what the owner sees. So it moves nothing, writes no branch, and takes a checkpoint only for the
    change owner.
13. **Adopt a pull request opened outside Mend; never update a fork's.** An agent that opened its
    own pull request left the change under review there, and a second one from Mend splits the
    review. Adopting it keeps one. A fork's pull request is someone's own branch in someone's own
    repository, and Mend's push to origin cannot reach it, so Mend states it and pushes to origin
    only.

## Open questions

1. **Branch protection and required reviewers.** A pull request into a protected branch works
   unchanged. A push to a protected `mend/*` branch pattern fails, and that failure should read as
   the remote's words, not Mend's.
2. **GitLab and others.** Steps 1 to 3 work for any origin. A merge request needs `glab` in the
   workspace and the owner's GitLab account, which is not a connected-account provider today.
3. **Draft pull requests.** Should the owner be able to open a draft? It is one flag on `gh`. The
   question is whether a draft state belongs in Mend's copy at all.
4. ~~**The agent opens its own pull request anyway.**~~ Closed 2026-09-25: Mend adopts it ("Pull
   requests opened outside Mend").
5. **Commit message by inference.** The tour summary is written for a reviewer, not as a commit
   message. A dedicated one-line subject is cheap, but it is a new claim Mend makes.
