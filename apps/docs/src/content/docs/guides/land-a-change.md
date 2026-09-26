---
title: Land a change
description:
  Push a session's change to origin and open or update its pull request, by hand or after each
  completed turn, and pull a change into your own clone.
sidebar:
  order: 2
---

Landing publishes a change. Mend commits what the worktree holds, pushes it to a branch on the
project's origin, and opens or updates a GitHub pull request into the session's base branch. Landing
again after more work adds commits to the same branch and updates the same pull request. Merging
stays on GitHub. Mend never merges, never force-pushes, and never says a change is ready to merge.

Landing is optional. You can [review a change](/guides/review-a-change/), send comments back, and
[pull it into your own clone](#pull-a-change-into-your-own-clone) without ever landing it.

## What a landing does

A landing runs four steps in order and stops at the first one that fails.

1. Mend takes a checkpoint of the worktree, so what lands is a recorded object and not a tree the
   agent may still be writing. This is the landed checkpoint.
2. Mend commits what the agent left uncommitted. The agent's own commits are pushed as they are, and
   Mend squashes and rewrites nothing. Mend's commit, `M` below, has the checkpoint's tree:

   ```text
   agent committed everything     main ── A1 ── A2          Mend adds nothing
   agent committed some of it     main ── A1 ── A2 ── M     M holds only the leftovers
   agent committed nothing        main ── M                 M holds the whole change
   ```

   The author of `M` is the change's owner. Its message comes from the tour's summary when a tour
   exists, or from the session's label, and ends with a `Mend-Session:` trailer that links to the
   session. On later landings `M` is parented on the last landed commit, and on the agent's head too
   when the agent committed since, so every push is a fast-forward.

3. Mend pushes to origin with the project's [git access](/guides/git-access/) and the change owner's
   key. The push only fast-forwards. If origin's branch has commits Mend has not seen, or origin
   refuses the push for any other reason, nothing is pushed and Mend reports the remote's own words.
4. When origin is on github.com, Mend opens a pull request into the session's base branch, or
   updates the one it opened or adopted before. For any other origin the push happens and the pull
   request step says why it did not run, for example
   `pull request unavailable · origin is on gitlab.com, not GitHub`.

Mend never moves the session's branch. `mend/<name>` in the store, and the worktree's files, index,
and HEAD, stay where the agent left them. Mend's commit is kept under `refs/mend/landed/<worktree>`,
never under `refs/heads`.

When nothing is new since the last landing, Mend pushes nothing, records nothing, and says
`landing not started · nothing new since the last landing`. A landing whose pull request step
failed, or one given a new title or description, still goes ahead.

### The branch on origin

Unless you name a branch, the landing pushes to the first of these that applies:

1. the branch the change's last landing pushed;
2. the branch the agent last pushed itself;
3. the head branch of a pull request [opened outside Mend](#pull-requests-opened-outside-mend);
4. the worktree's own branch, `mend/<worktree>`.

The branch is never the project's default branch or the pull request's base. Naming one of those is
refused with `landing not started · <branch> is the project's default branch · name another branch`.

### The pull request

The pull request step needs the change owner's GitHub account, connected with `mend connect github`
(see [provider accounts](/guides/provider-accounts/#connect-github)). The token stays on the
platform and in workspaces, so Mend runs `gh` in a workspace:

- in the session's own workspace when it is live and belongs to the change's owner;
- otherwise in a short-lived workspace with the owner's GitHub account and nothing else: no
  worktree, no dotfiles, no secrets. Mend stops it when `gh` returns.

The short-lived workspace adds workspace start time to the landing. It mounts an empty directory
from the Mend host, so a workspace runtime that accepts no host mounts refuses it. The push has
already happened by then, and the landing records the platform's refusal as the pull request step's
failure.

The title defaults to the session's label. A title edited on GitHub is kept on later updates. The
description is Mend's section between `<!-- mend:landing:start -->` and `<!-- mend:landing:end -->`:
the tour's summary and approach, the changed files with their line counts, and links to the session,
the review, and the landed checkpoint. An update replaces only that section, so text people wrote
above or below it on GitHub survives. When no tour exists yet, the pull request opens with the file
list and the links, Mend queues the tour, and the description gains it when the tour completes.

## Who lands

Only the change's owner lands it. The change's owner is the owner of the worktree's first session,
the one that started the change. A teammate who starts a session in that worktree later, steers it
under shared control, or is an organization owner cannot land it. The push uses the owner's key,
Mend's commit is authored as the owner, and `gh` speaks on GitHub as the owner, so no one else can
publish as them.

Anyone who can see the project can see the landing record and the observed facts.

## Land from the web

The change's review page has a `Land` panel. The session page links to it with `Land →` (or
`Landing →` for someone other than the owner) beside its latest landing fact.

The panel's header says where the change goes, for example
`push mend/fix-login to origin · pull request into main`. Below it are the observed facts, or
`not landed · nothing pushed from Mend yet`.

For the change's owner, the panel has `Pull request title`, `Your description` (written above Mend's
section), `Preview description`, and one button:

- `Push and open pull request` for the first landing on GitHub;
- `Push and update pull request` once there is an open pull request to update;
- `Push to origin` when origin is not on GitHub, or when the change's pull request is from a fork.

Everyone else sees `only the change's owner lands it`.

The panel also has:

- `Check origin`, which fetches origin's branch with your git access and compares it with the landed
  commit;
- `Check GitHub`, for the owner, which looks for a pull request opened outside Mend;
- `Refresh pull request`, for the owner, which asks GitHub for the pull request's state now;
- `Open #412 on GitHub ↗`.

Mend does not poll GitHub. A pull request's state is as fresh as the last landing, refresh, or
check.

## Land from the CLI

```sh
mend land <session> [--branch <name>] [--no-pr] [--title <text>] [--project <p>]
mend land <session> --check [--project <p>]
```

`<session>` is a prefix of the session id or the worktree's name. Settled sessions count.

```sh
# push mend/fix-login and open its pull request
mend land fix-login

# push only, to another branch
mend land 3f2a --no-pr --branch wip/login

# set the pull request's title
mend land fix-login --title "Retry the login request once on a 502"
```

The command prints the landing, what it wrote, and every fact Mend observed:

```text
✓ pushed · mend/fix-login · 3f2a1c0 · pull request #412 · opened
  checkpoint 91bd2e4
  commit 3f2a1c0 · Mend's, for the work left uncommitted
  pull request https://github.com/acme/web/pull/412
  observed
    pushed · mend/fix-login · 3f2a1c0 · observed
    pull request #412 · open · observed 0 s ago
```

It exits 1 when the push was refused or a step failed.

## What Mend reports

Landing facts are observations, with where Mend saw them. The web, the CLI, the desktop app, and
Slack use the same lines:

```text
pushed · mend/fix-login · 3f2a1c0 · observed
pull request #412 · open · observed 2 min ago
pull request #412 · merged · observed 1 h ago
origin has moved · mend/fix-login has 2 commits Mend has not seen
changed since landing · 3 files
push refused · mend/fix-login · <the remote's words>
landing failed · <what stopped it>
pull request step failed · <gh's words>
pushed by the agent · refs/heads/wip · 91bd2e4
changes not landed · the request read as a question
intent not read
```

A pull request's state is `open`, `closed`, or `merged`, as `gh` last reported it. Pushes the agent
made itself, through the workspace's git transport, are shown beside Mend's landings and are not
landings. Failures do not retry. The next completed turn or a manual landing tries again.

## Automatic landing

With automatic landing on, Mend lands the change after each completed turn whose request asked for a
change. The first landing opens the pull request and later ones update it.

### When it is on

- A session started from the web, the CLI, or the desktop app follows its project's
  `Land when a turn completes` setting, which is `inherit`, `on`, or `off`. `inherit` follows the
  default in Settings, which is off unless an operator or organization owner turned it on.
- A session can override the project when it starts. The web composer's menu has
  `Land when a turn completes` with `As the project`, `Land`, and `Do not land`. The CLI has
  `--land` and `--no-land`:

  ```sh
  mend claude "fix the flaky login test" --land
  ```

- A session started from Slack lands automatically when the Slack app's `Land automatically` setting
  is on, which it is by default. `autopr=true` or `autopr=false` in the request decides for that
  request. See [Slack](/integrations/slack/).
- A project set to `off` wins over everything: the composer, `--land`, the Slack setting, and
  `autopr=true`.

Mend lands only after turns it runs itself. A terminal session, where `mend codex` or `mend claude`
attaches the agent to your terminal, has no turns Mend sees end, so it never lands by itself. It
does once the session is picked up as a conversation, on the phone for example. Until then, land it
with `mend land` or the Land panel.

### When a completed turn lands

Mend checks these in order, and all must hold:

1. The turn completed. A turn that failed, was interrupted, or was cancelled never lands.
2. The agent is not waiting on a question or an approval, and no later turn follows.
3. The change's owner sent the turn, in a session they own. A follow-up someone else sent under
   shared control does not land, and neither does a turn in a session a teammate started in the
   owner's worktree. Review comments sent back to a session count as sent by whoever sent them.
4. The change is not empty, and it is not what the last landing already pushed.
5. The request asked for a change.

### Questions do not open pull requests

Mend guards the last check twice. First, the opening turn of every Slack request and of any session
with automatic landing on carries these instructions after the request:

```text
--- How this work is published ---
Mend publishes the changes this session makes: it pushes the branch and opens or updates the pull request.
- If the request is a question, answer it and change no files.
- Change code only when the request asks for a change.
- Never push and never open a pull request. Committing is fine.
--- End of how this work is published ---
```

Second, Mend uses inference to read each request as a change or a question. For Slack this is the
same call that picks the thread's project. Web and CLI sessions with automatic landing on make one
small call per turn. `autopr=true` reads as a change and `autopr=false` as a question, without a
call. A later request that asks for a change lands, even if the first one was a question.

When a question still left files changed, Mend does not land it and says
`changes not landed · the request read as a question`. The Land panel then notes that a completed
turn left changes Mend did not land, and in Slack the reply carries a `Push and open pull request`
button that acts only for the change's owner.

When the request could not be read, because inference is off or over its budget, Mend treats it as a
change and reports `intent not read` beside the landing.

## Pull requests opened outside Mend

The agent may push a branch and open a pull request itself, despite the instructions, or a person
may open one by hand. Mend adopts that pull request instead of opening a second one. It asks GitHub,
as the change's owner, about the worktree's branch, every branch the agent pushed to origin, and any
pull request that holds the agent's head commit, including one from a fork.

Mend looks:

- 45 seconds after the agent pushes a branch through the workspace's git transport;
- when an agent ends while its workspace is still up;
- when the owner presses `Check GitHub` or runs `mend land <session> --check`.

The first two use only a live workspace of the owner's. An adopted pull request reads
`pull request #368 · open · observed 2 min ago · opened outside Mend`, and the next landing pushes
to its branch and updates it.

A pull request from a fork is shown and never updated, because Mend pushes to origin only:

```text
pull request #367 · open · observed 2 min ago · opened outside Mend · from anna's fork
```

While it is open, the Land button reads `Push to origin` and the landing skips its pull request
step, saying `pull request #367 is from anna's fork · Mend pushes to origin only`.

## Removing a landed worktree

Removing a worktree refuses when its change is not on origin, and names what is unlanded:

```text
This worktree holds a change that was never landed · 2 files · +32 −5 · src/login.ts +30 −5, test/login.test.ts +2 −0. Land it or discard it before removal, or pass force=true to remove it anyway.
```

A worktree that changed after its last landing is refused the same way, naming the files changed
since.

A worktree is removable without force when it holds nothing past its base, or when its latest
landing's checkpoint is what it holds and either the pull request was last reported merged or
origin's branch still has the landed commit. A merged pull request counts even after its branch was
deleted, because a squash merge leaves no ancestry to fetch. Mend fetches origin's branch with your
git access to check.

## Pull a change into your own clone

`mend pull` fetches a session's change into a local clone of the same repository, as a branch named
after the session's branch:

```sh
cd ~/src/web
mend pull fix-login
git switch mend/fix-login
```

```text
✓ fetched mend/fix-login · 3f2a1c0 · 2 commits on 9e11c4a · created
    3f2a1c0 Retry the login request once on a 502
    b71d02e Add a failing test for the 502 case
  switch to it git switch mend/fix-login
```

The CLI downloads a git bundle with the commits from the session's base to the latest checkpoint.
Uncommitted work is committed the way a landing commits it, without pushing. So pulling works before
landing, without origin, and for projects nobody can push to.

- Pulling moves nothing on the server and writes no branch there. When the change's owner pulls,
  Mend takes a checkpoint first. Anyone else gets the latest checkpoint that already exists.
- Your working tree, index, and current branch are not touched. An existing local branch of the same
  name only fast-forwards.
- The clone needs the session's base commit, so fetch from origin first when it is missing.
- One of the clone's remotes must be the project's origin, compared by host and path so SSH and
  HTTPS spellings match. `--force` skips that check.
- A bundle over the server's limit (`MEND_BUDGET_BUNDLE_BYTES`, 64 MiB by default) is refused with
  its size, and nothing is fetched.

## Where landing is not available

The mobile app and the VS Code extension show no landing facts and cannot land. A project whose
origin is not on GitHub gets the push and no pull request. GitLab and other hosts are not supported
for the pull request step.
