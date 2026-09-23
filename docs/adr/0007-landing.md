# Landing: push a change and open its pull request

Status: proposed 2026-09-23, amended 2026-09-24 with automatic landing. Commits Mend to one landing
action. Mend commits what the worktree holds, pushes the session's branch to the project's origin,
and opens or updates a GitHub pull request whose description is Mend's review tour. Like Cursor, it
can do this automatically when the agent finishes a turn, and it does not do it for a request that
asked a question rather than for a change. Merging stays on GitHub, and landing again after more
work updates the same branch and pull request. The ADR also makes landing observable: what was
pushed, by whom, and whether origin still has it.

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
   checkpoint's tree and is parented on the branch head. Its author and committer are the owner's
   name and email. Its message comes from the tour's summary when a tour exists, and from the
   session's label otherwise, with a `Mend-Session:` trailer that links to the session. Mend writes
   it with `commit-tree` against the store and moves `mend/<name>` to it, so the worktree's files,
   index and HEAD are never touched.

3. **Push.** The host pushes `mend/<name>` to origin, as `refs/heads/mend/<name>` unless the owner
   names another branch, using the project's `gitAuthMode`. The push only fast-forwards. If origin's
   branch has commits that Mend's branch does not, landing stops and says so. Mend never
   force-pushes.
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

**When a completed turn lands.** All of these must hold, and Mend checks them in this order:

1. The turn completed. A turn that failed, was interrupted or was cancelled never lands.
2. The agent is not waiting on a question or an approval.
3. The turn was sent by the owner, or the session came from the owner's own request. A follow-up
   sent by someone else under shared control does not land automatically, because landing pushes and
   speaks as the owner. Mend offers the owner the button.
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
description gains the tour when the tour completes.

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
- otherwise, in a short-lived workspace for the owner with the GitHub credential and nothing else:
  no harness, no worktree mount and no dotfiles. It is destroyed when the call returns.

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
(`npm test · exit 0 · observed`).

If no tour exists yet, Mend composes one first when the project's inference is available. Otherwise
the description has only the file list and the links, and says it has no summary.

### Who lands

Only the session's owner lands its change. Landing pushes with the owner's key and speaks on GitHub
as the owner, so shared control does not extend to it and neither does being an organization owner.
Anyone who can see the project can see the landing record.

A session with no owner, or whose owner has no GitHub account connected, cannot open a pull request
from Mend. The push still works if the project's auth mode allows it.

### What Mend records and shows

A `change_landings` row for each landing records:

- the change and the checkpoint that was landed;
- the commit Mend wrote, or none;
- the remote branch and the sha that was pushed;
- the pull request's number, URL and state as `gh` last reported it;
- the owner, the time and the outcome.

It is audited like any other action with the owner's credentials.

The review page shows landing as observed facts:

- `pushed · mend/fix-login · 3f2a1c0 · observed` after a push;
- `pull request #412 · open · observed 2 min ago`;
- `origin has moved · mend/fix-login has 2 commits Mend has not seen` when a fetch shows the branch
  diverged;
- `changed since landing · 3 files` when the worktree has moved past the landed checkpoint.

Pushes the agent made itself come from `session_git_ops`:
`pushed by the agent · refs/heads/wip · 91bd2e4`. Mend shows them beside its own landings and does
not treat them as landings. They did not go through this path, and the ADR 0002 lease does not fence
them.

A pull request's state is refreshed each time Mend runs step 4, and when someone asks for it from
the review page. Refreshing needs a workspace for the same reason step 4 does. Mend does not poll
GitHub.

### Worktree removal

Removal stops asking for an export that does not exist. A worktree whose latest checkpoint's tree is
on origin, according to the last landing and a fetch, is removable without `force`. Anything else is
refused, as it is today, and the refusal names what is unlanded: files and line counts since the
last landing.

### Pulling a change into your own checkout

`mend pull <session>`, run inside a local clone of the same repository, fetches the change's branch
into it as `mend/<name>`. The CLI downloads a git bundle from the API (`GET /changes/:id/bundle`),
which contains the commits from the session's base to the latest checkpoint. Mend commits the
checkpoint first, exactly as step 2 does, without pushing. So pulling works without origin, before
landing, and for projects whose origin nobody can push to.

The bundle endpoint is authorized like the review diff. It is bounded by the request budgets and
refuses a bundle over a size limit, with the size in the answer.

This closes plan open decision #8 in one direction: the person pulls from Mend. Mend does not push
into anyone's checkout.

### Surfaces

- **Web:** a Land panel on the change page. It shows the branch, the base, the pull request title
  and description preview, the observed facts above, and one button, "Push and open pull request",
  which reads "Push and update pull request" once there is one. The session page links to it.
- **CLI:** `mend land <session> [--branch <name>] [--no-pr] [--title …]`, and `mend pull <session>`.
- **Slack (ADR 0006):** lands automatically as above, and the status line carries the branch and the
  pull request. When a request did not land (a question, automatic landing off, a follow-up from
  someone other than the owner), the end-of-session reply has a "Push and open pull request" button,
  shown to everyone and acting only for the owner. Anyone else gets an ephemeral refusal. The Slack
  app gains the "Land automatically" setting and the `autopr=` option, and ADR 0006's Cursor table
  and its "No PR" row are corrected to match.
- **Web and CLI composer:** the per-session automatic-landing override, and the project setting
  "Land when a turn completes".
- **Mobile and desktop:** the landing facts, read-only, in this ADR's scope. Their buttons come
  later.

## Consequences

- Product language gains `landing` (one push, plus its pull request, recorded against a checkpoint)
  and `landed checkpoint`. `AGENTS.md` and plan §5.9 need amending.
- Mend writes commits on a session's visible branch for the first time. It does so only when it
  lands or pulls, and only with `commit-tree` against the store, so nothing the agent sees in its
  worktree changes.
- With automatic landing, a Slack request that asks for a change produces a pull request on GitHub
  without anyone pressing a button. That is Cursor's default and the reason to copy it. The guards
  above decide when it happens, and the project setting can turn it off.
- Reading a request's intent is inference Mend runs per request. It is one call for Slack, where it
  shares the project-picking call, and one small call per turn for web and CLI sessions that land
  automatically.
- A pull request needs a workspace for a few seconds when the session is not live. That is paid in
  workspace start time on every such landing, until the platform half ships.
- A pull request is authored as the owner. That is the honest identity: it is their credential and
  their change.
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
| 5   | API: land, landing record, bundle and refresh routes; owner-only authorization; audit; `session_git_ops` exposed; worktree removal that recognizes a landed change.                |
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
6. **Only the owner lands.** Landing speaks as the owner on GitHub and pushes with their key. Shared
   control lets others steer an agent. It does not let them publish as someone else.
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

## Open questions

1. **Branch protection and required reviewers.** A pull request into a protected branch works
   unchanged. A push to a protected `mend/*` branch pattern fails, and that failure should read as
   the remote's words, not Mend's.
2. **GitLab and others.** Steps 1 to 3 work for any origin. A merge request needs `glab` in the
   workspace and the owner's GitLab account, which is not a connected-account provider today.
3. **Draft pull requests.** Should the owner be able to open a draft? It is one flag on `gh`. The
   question is whether a draft state belongs in Mend's copy at all.
4. **The agent opens its own pull request anyway.** The prompt tells it not to, and it may still do
   it. Mend could recognize a pull request from the session's branch and adopt it as the landing's
   pull request, rather than failing to open a second one.
5. **Commit message by inference.** The tour summary is written for a reviewer, not as a commit
   message. A dedicated one-line subject is cheap, but it is a new claim Mend makes.
