# Slack: start a session by mentioning Mend

Status: proposed 2026-09-22, amended 2026-09-24 by ADR 0007 (landing): a request that asks for a
change now ends in a pushed branch and a pull request, as Cursor's does. It commits Mend to working
in Slack the way Cursor's Slack integration does. A person writes `@mend fix the flaky login test`
in a thread. Mend reads the thread, works out which project the thread is about, and starts a
session for that person. The session reports into the thread, and a later `@mend` in the same thread
adds a follow-up to it. This ADR names the identity, transport, inference, storage and disclosure
rules this needs, and one refactor: Slack must start sessions through the same checks as the web
app, not a second, weaker path.

**What this ADR does not claim.** It does not make Slack a place to review a change. Review stays in
Mend. Slack gets a status, the agent's summary, a link, and (ADR 0007) the branch and pull request
the change landed as.

## The model: Cursor's Slack integration

Cursor's integration is the behaviour people already expect from `@cursor`, so Mend copies its shape
and changes it only where Mend's own model requires it:

| Cursor                                                                                                       | Mend                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Cursor <prompt>` starts a cloud agent                                                                      | `@mend <prompt>` starts a session                                                                                                                                                                                                                                                           |
| Natural options (`with opus`, `in acme/backend`) and inline ones (`model=opus`)                              | The same, with `project=`, `branch=`, `harness=`, `model=`, `effort=`                                                                                                                                                                                                                       |
| The repository is picked from the message, recent activity, routing rules, channel default, personal default | The project is picked from the message, **the thread**, the channel default and the personal default                                                                                                                                                                                        |
| It reads the whole thread as context                                                                         | The same                                                                                                                                                                                                                                                                                    |
| `@Cursor <prompt>` in a thread with an agent is a follow-up; `@Cursor agent …` starts a new one              | The same, with `@mend new …`                                                                                                                                                                                                                                                                |
| Reactions ⏳ ✅ ❌, status in the thread, an "Open in Cursor" button, a PR link                              | Reactions, one status message edited in place with the branch and the pull request, an "Open in Mend" button, the summary and a review link                                                                                                                                                 |
| `@Cursor help`, `@Cursor settings`, `@Cursor list my agents`                                                 | `@mend help`, `@mend settings`, `@mend list`                                                                                                                                                                                                                                                |
| A setting for whether summaries and diffs appear in Slack, and in external channels                          | The same setting, owned by an organization owner                                                                                                                                                                                                                                            |
| The Slack account is linked to a Cursor account                                                              | The same, by an explicit link                                                                                                                                                                                                                                                               |
| It opens a PR by default (`autopr`)                                                                          | The same, by default and as the requester: a request that asks for a change is pushed and its pull request opened or updated when a turn completes (ADR 0007). `autopr=false`, the app's "Land automatically" setting or the project's setting turns it off, and a question never opens one |

## Context

Mend today has one way to start a session: an authenticated HTTP caller. The web app, the CLI and
the phone all make the same two calls:

- `POST /projects/:id/sessions` provisions the worktree and session. It runs
  `ProjectAccess.project`, then `requireSessionRoom`, then
  `SessionEngine.provision({ …, ownerUserId: caller.user.id })`
  (`apps/api/src/routes/workbench.ts`).
- `POST /sessions/:id/launch` launches the harness. It runs `SessionSteering.session`, then
  `Budgets.withLaunchSlot` and the auto-name job, and submits the prompt as the opening turn in
  protocol mode.

Both handlers take identity from `CurrentUser`, which only the HTTP auth middleware provides. The
checks live in the handlers and not in a service.

The session always runs as its owner (ADR 0003, "Sessions and shared control"): the owner's Sealant
principal, provider logins, Git access and dotfiles. So a Slack message can only start a session
once Mend knows which account the Slack user is.

The pieces Slack can reuse already exist:

- `SecretCipher` (`packages/store/src/secret-cipher.ts`) seals a value with AES-256-GCM under
  `secrets.key`. `project_secrets` uses it. No organization-scoped secret table exists.
- `SessionNotifierLive` (`packages/jobs/src/session-notifier.ts`) listens on `mend_events`, folds
  session and turn state, and pushes to phones. A Slack reporter is the same shape with a different
  sink.
- `ProjectAccess.projectAs(userId, id)`, `visibleProjectsOf(userId)` and
  `SessionSteering.authorizeUser(session, userId)` already authorize a user id without an HTTP
  request.
- A project has a `name` that is unique within its organization (`ProjectsRepo.byName`) and an
  `originUrl`, the Git URL it was adopted from.
- `@mend/inference` already runs small inference jobs through `InferenceProvider`: session naming
  and comment routing.

Slack offers two ways to deliver events. With the HTTP Events API, Slack POSTs to a public URL. With
Socket Mode, the app opens an outbound WebSocket using an app-level token (`xapp-`,
`connections:write`). Up to ten connections may be open, and Slack sends each payload to one of
them. Socket Mode apps cannot be listed in the Slack Marketplace.

## Decision

### Socket Mode, outbound only

Mend connects to Slack and Slack never connects to Mend. That works the same on a `loopback`,
`private` or `public` instance, and it adds no route to the public exposure gate.

The Socket Mode client runs in the worker (`WorkerLive`, next to `SessionNotifierLive`), with one
connection per installed organization per worker process. Every envelope is acknowledged as soon as
it arrives, before any work. Slack may deliver an event twice, or to two workers, so the event is
claimed once in Postgres by its Slack `event_id` before anything acts on it. A claimed event is done
even if the work fails. The failure is reported in the thread, and the event is never replayed.

### One Slack app per organization, made from Mend's manifest

A Socket Mode app cannot be listed in the Marketplace, and an OAuth install flow needs a redirect
URL Slack can reach. So Mend does not ship a shared app, and here it differs from Cursor. An
organization owner creates their own app in Slack from a manifest that Mend generates, installs it
in their Slack workspace, and pastes two tokens into Settings → Slack:

- the app-level token (`xapp-…`, scope `connections:write`), which opens the socket;
- the bot token (`xoxb-…`), which reads mentions and writes replies.

The manifest asks for the bot scopes Cursor asks for, less what Mend does not use:

- `app_mentions:read` sees mentions.
- `channels:history`, `groups:history`, `im:history` and `mpim:history` read the thread a mention
  sits in.
- `chat:write` posts status and replies, and `im:write` opens a direct message.
- `reactions:write` marks the request with ⏳, ✅ or ❌.
- `files:read` reads screenshots in the thread.
- `users:read` shows who wrote each message.

The manifest subscribes to two bot events. `app_mention` carries a mention in a channel. Slack does
not send `app_mention` for a direct message with the bot, so direct messages arrive as `message.im`,
and a direct message is read as a mention without the `@mend`.

Mend checks the bot token with `auth.test` and the app-level token with `apps.connections.open`, and
that both belong to the same app, before it saves anything. It seals both with `SecretCipher` and
stores them in `slack_installs`, which is one row per organization. The Slack workspace id
(`team_id`) is unique across the instance, so a Slack workspace belongs to at most one organization.
That matters in `multi` mode, where two organizations might otherwise claim the same workspace.

When the owner connects Slack, the install also records the web origin they were using. Mend builds
every link it posts into Slack from that origin. Mend has no configured public URL today, and this
avoids adding one.

Only an organization owner installs, replaces or removes the app, or changes its settings. Removing
it deletes the tokens, the links and the channel defaults. Session records stay, including where the
sessions came from.

### A Slack user acts only once they have linked their account

A mention from a Slack user who has not linked their account starts nothing. Mend answers with an
ephemeral message (`chat.postEphemeral`, which only they can see) that has a "Link your Mend
account" button. The button opens `/slack/link/<code>`. The code is single-use and valid for ten
minutes, and Mend stores only its hash. The person opens the page while signed in to Mend, sees
which Slack user and which Slack workspace they are linking, and confirms. Mend then runs the
request they originally made, so linking does not mean asking twice.

The link joins one Slack user in one Slack workspace to one Mend account in the install's
organization. Mend does not link by email address. An address match proves nothing about who
controls the Mend account, and a linked account is one Mend will spend credentials for.

Mend ignores mentions from bots, including itself. A mention from a user outside the install's Slack
workspace, in a Slack Connect channel, gets an ephemeral reply saying that only members of the
workspace can use Mend.

Removing a member (ADR 0003) deletes their Slack link. A person can unlink from Settings, and an
owner can remove any link in their organization.

### Reading a mention

A mention is read as Cursor reads one. Options can be written in natural language or inline, and
inline options come first:

```
@mend fix the flaky login test
@mend in billing-api with codex, make the retry limit configurable
@mend project=billing-api branch=release/2.3 harness=codex effort=high make the retry limit configurable
@mend project="billing api" add a --dry-run flag
```

| Option    | Natural form                               | Meaning                                                   |
| --------- | ------------------------------------------ | --------------------------------------------------------- |
| `project` | `in <project>`                             | The project, by name or by repository (`acme/api`)        |
| `branch`  | `from <branch>`, `on <branch>`             | The base branch; the project's default otherwise          |
| `harness` | `with claude`, `with codex`                | The harness; the person's default otherwise               |
| `model`   | `with opus`                                | The harness's model                                       |
| `effort`  | `with high effort`                         | The harness's effort                                      |
| `autopr`  | none: `autopr=true` or `autopr=false` only | Whether the change lands when a turn completes (ADR 0007) |

Inline options are parsed exactly. Natural options are read by inference, together with the choice
of project below. An inline option always wins over a natural one, and a later duplicate wins over
an earlier one. What is left after the options is the prompt.

`help`, `settings`, `list` and `new` are commands when they are the first word.

### Which project a mention runs in

The project comes from the first of these that answers:

1. **The message.** `project=` or `in <project>`, matched by name or against a project's `originUrl`
   (`acme/api`, or a full Git or web URL).
2. **The thread.** If the thread already has a Mend session, its project. Otherwise, the repository
   URLs in the thread: a GitHub or GitLab link to a repository, pull request, issue, commit or file
   names a repository, and Mend matches it against `originUrl`. Otherwise, Mend uses inference over
   the thread's text and the candidate projects to pick the one the thread is about.
3. **The channel default**, set with `@mend settings`.
4. **The person's default**, set in Mend under Settings → Slack.

The candidates are the projects the linked user can see (`visibleProjectsOf`). In a channel, only
`shared` projects are candidates: everyone in the channel reads what Mend posts there, and a private
project must not appear in it. In a direct message with the bot, private projects are candidates
too.

The inference step is given each candidate's name, its `originUrl`, its default branch, and the
top-level entries of its default branch's tree. It returns one project, or none. It never returns a
project that is not a candidate, and the result is checked against the list. The step runs when a
session starts, never on every message in a channel. The same call reads the request as a `change`
or a `question` (ADR 0007, "Questions do not open pull requests"), and Mend records that reading on
the opening turn, so automatic landing asks for no reading of its own. When the project was chosen
without inference, and for follow-ups, automatic landing reads the turn's intent itself.
`autopr=true` and `autopr=false` are recorded as the turn's intent and win over any reading.

When the answer comes from inference or from a default, Mend says which project and why in the
status message (`billing-api · from the thread`, `billing-api · channel default`). When nothing
answers, or inference cannot choose between candidates, Mend asks with buttons for the likeliest
projects, plus "Other…" with the full list. It does not guess.

"Switch project" on the status message restarts the request in a project the person picks. It is
offered only until the session's first turn completes.

Every project is resolved through `ProjectAccess.projectAs(linkedUserId, …)`. A project the linked
user cannot see does not exist for them in Slack, just as it does not in the web app.

### What the session receives

The opening turn is the prompt, then the thread. Like Cursor, Mend reads the whole thread: every
message up to the mention, up to fifty messages or 20,000 characters, whichever limit it reaches
first, keeping the newest. Each message is quoted with its author's display name and marked as Slack
thread context, separate from the request. Screenshots and images in those messages are attached
through the same path as an image pasted into a session: each is stored as a file in the session's
harness home, and the turn text names its path. They are not sent as image content blocks. Each
image keeps the paste's rules (PNG, JPEG, GIF or WebP, up to 8 MB). A turn attaches the request's
own images first, then the thread's, newest first, up to ten images and 24 MB. The turn names each
image it skipped and why, and so does an ephemeral reply to the requester. A follow-up mention's
images go with its turn.

Thread text written by someone other than the requester is input from a third party, and it reaches
an agent that runs with the requester's Git access. Mend keeps those messages so the request makes
sense, and labels each one with who wrote it. It drops messages from bots, and from users outside
the Slack workspace.

The session is started like this:

- as the linked user, who owns it;
- in `protocol` mode, the one mode whose turns Mend can read back and submit to;
- with `autopr=` as the session's own automatic-landing override, when the request gives it;
- on a new worktree from the chosen base branch;
- with the chosen harness, model and effort;
- with the project's auto-naming settings.

If the owner has no working credential for that harness, Mend says so in the thread and starts
nothing.

### Follow-ups in a thread

Starting a session records the Slack thread (`team_id`, `channel_id`, `thread_ts`) against it in
`slack_threads`. A thread can hold several sessions. A session belongs to at most one thread.

- `@mend <prompt>` in a thread that has a session is a follow-up turn for the thread's most recent
  session, like Cursor. It goes through `SessionSteering.authorizeUser(session, linkedUserId)`: the
  owner can always send it, and anyone else only while the owner has shared control on. That is
  Mend's form of Cursor's team follow-up setting. A refusal is an ephemeral reply.
- `@mend new <prompt>` starts another session in the same thread and project. So does a mention that
  names a different project, harness or branch. Mend does not infer a request for a new session from
  the words of a mention: without one of those, a mention is a follow-up.
- `model=` and `effort=` on a follow-up are not applied. They apply when a session starts, and the
  requester gets an ephemeral reply saying so.
- If the agent asked a question (`user-input`), the owner's next mention answers it rather than
  starting a new turn.
- A mention in the thread of a session that is no longer live resumes it with that turn, if the
  engine can resume that session. Otherwise it starts a new session in the same thread with the
  thread as context, and says so.
- A reply in the thread that does not mention `@mend` is conversation between people and never
  reaches the agent.

### What Mend posts, and where

Mend posts only into the thread the request came from.

- **A reaction** on the request: ⏳ while the session runs, ✅ when it completes, ❌ when it fails
  or is refused.
- **One status message**, which Mend edits in place (`chat.update`). It shows the project and why it
  was chosen, the harness, the worktree branch and the observed state, with an "Open in Mend"
  button. For example: `billing-api · from the thread · claude · running · mend/flaky-login-test`,
  then `completed · observed · 4 files · +120 −30`. Once the change lands (ADR 0007), a line under
  it gives the branch and the pull request
  (`pushed · mend/flaky-login-test · pull request #412 · opened`), and each later landing edits that
  line (`… · updated`) instead of adding a message. A refused push or a failed pull request step
  reads in the remote's own words (`push refused · mend/flaky-login-test · …`), and nothing retries.
  A completed turn whose change did not land says why
  (`changes not landed · the request read as a question`).
- **The agent's plan and closing message** for each turn, as replies, each cut at 3,000 characters
  with a link to the rest. Cursor posts a plan before it changes code. Mend posts the agent's first
  message when it is one, and does not write a plan of its own. A plan with no text of its own, such
  as Claude's `TodoWrite` list, is posted as a short checklist of its items.
- **A question the agent asks**, as a reply that names the owner.
- **Approvals** as a status line with a link. They are answered in Mend.
- **One end-of-session reply**, once Mend's passes over the change have run. It carries the summary
  and the approach from the change's review tour, then the count of draft comments and suggested
  edits, and a "Review in Mend" button. This is Mend's counterpart to Cursor's agent summary. The
  summary is not the agent's account of itself: Mend writes it using inference on the diff and the
  session record, and the reply says so. It describes what changed and how the session went about
  it, and gives no verdict. Mend has no proposed-check entity yet, so the count names none.
- **"Push and open pull request"**, when a completed turn left a change that did not land: the
  request read as a question, it said `autopr=false`, automatic landing is off, or someone other
  than the owner sent the follow-up (ADR 0007). The button rides the end-of-session reply when that
  reply goes out in the same look; otherwise it is a reply of its own, posted when the turn is
  decided, since the review tour can come much later or not at all. Everyone in the thread sees it.
  It lands only for the change's owner, as them and through the same landing as the web app's Land
  panel, and tells anyone else so in an ephemeral reply. It reads "Push and update pull request"
  once an open pull request is recorded. The thread is offered each turn once, and a landing since
  the turn ended answers it.

A session started from Slack always gets a review tour when it settles with a change, even where the
project's automatic tour is off, since the summary comes from it. The tour is the same
`compose-tour` job the review page queues. A session that settles with no change gets no tour and no
reply beyond its status line. If the tour fails, the thread keeps the agent's closing message as its
last word, and the reply carries only the count when a review pass ran. Each summary is posted once
for each tour Mend composes, so a pass that finishes after the reply does not repeat it.

An organization owner decides how much goes into Slack, as Cursor's admins do:

| Setting             | Off                                                                     | On                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Show agent messages | Status, reactions and links only                                        | Also the plan, closing messages, questions and the summary (default)                                                                                |
| Show diffs          | Changed files and line counts only (default)                            | Also the diff of each changed file, up to 3,000 characters, once, when the session first settles                                                    |
| External channels   | Only status and links in Slack Connect channels (default)               | The two settings above apply there too                                                                                                              |
| Land automatically  | A completed turn pushes nothing; the thread offers the owner the button | A request that asked for a change lands when a turn completes (default, ADR 0007); a project set to off wins, and `autopr=` decides for one request |

Status copy follows the product voice. It states what was observed and gives no verdict:
`completed · observed`, never "done", "looks good" or "safe to merge".

The reporter is a sibling of `SessionNotifierLive`. It listens on `mend_events`, re-reads the
sessions that have a Slack thread, and applies the same guards: a session first seen mid-flight is
recorded without posting, and state older than two minutes is not announced.

The reporter checks disclosure again on every look, since a project's visibility can change while
its session runs. When a channel thread's project is no longer `shared`, Mend edits the status
message to `not shown · the project is private`, which does not name the project, and posts nothing
more into that thread. The reporter posts only through the install of the organization that owns the
session's project.

### Commands

- `@mend help` lists the options and commands, as an ephemeral reply.
- `@mend settings` shows the channel's default project and lets any member set or clear it. The
  choices are the shared projects that member can see.
- `@mend list` shows the person's sessions started from Slack, with their state and links, as an
  ephemeral reply.

### Slack starts sessions through the same path as everyone else

The create and launch checks move out of the HTTP handlers into one service,
`SessionStart.startAs(userId, input)`. It runs project access, the session budget, the launch slot,
provision, launch and the auto-name job, in that order. The HTTP handlers call it with
`caller.user.id`, and Slack calls it with the linked user's id. It is one implementation with one
set of checks, and the HTTP routes behave exactly as before.

Follow-ups and answers from Slack go through `SessionSteering.authorizeUser` and the engine methods
the HTTP handlers already call.

### Audit

These go to the organization's audit log:

- the Slack app being installed, replaced or removed, and its settings being changed;
- a link being created or removed;
- a channel default being set;
- a session being started from Slack, with the Slack user, channel, message timestamp and how its
  project was chosen.

Sessions gain an `origin` column (`agent_sessions.origin`), `mend` or `slack`. The web app shows
`slack` beside the owner.

### Budgets

A Slack-started session counts against the same session and launch budgets as any other, under the
linked user. Refusals are posted in the thread as the budget worded them. Mend has no organization
inference budget yet, so thread inference has its own ceiling: inferences per organization per hour,
per worker process (`MEND_SLACK_INFERENCES_PER_HOUR`). Past it, the choice goes on to the defaults
and the buttons without inference. An install also has a ceiling on events per minute, per worker
process (`MEND_SLACK_EVENTS_PER_MINUTE`), and above it Mend acknowledges each event and drops it, so
a busy or hostile channel cannot queue unbounded work. Both move to an organization budget once one
exists.

## Consequences

- Product language gains `Slack app` (an organization's install), `Slack link` (a Slack user joined
  to a Mend account) and `Slack thread` (a thread sessions report to). `AGENTS.md` and plan §5 need
  amending.
- An organization owner has to create a Slack app from a pasted manifest, which Cursor's users do
  not. That is what outbound-only transport costs, and it is paid once per organization.
- Mend holds a bot token that can read the history of every channel the bot is invited to. It reads
  that history only for the thread of a mention. The token is sealed at rest like a project secret,
  and removing the install deletes it.
- Picking a project from a thread sends the thread's text and the candidate projects' names and
  top-level file names to the inference provider. It does not send code.
- A worker process holds one WebSocket per installed organization. In `multi` mode that is one
  socket per organization with Slack connected, on every worker.
- `apps/api` gains an outbound WebSocket client, and Mend gains a dependency on Slack's SDK.

## Delivery

One ready-for-review PR per step, stacked:

| PR  | What it delivers                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | This ADR, and the product-language amendments.                                                                                                                                                |
| 2   | `SessionStart.startAs`, extracted from the create and launch handlers. No change in behaviour, and the existing route tests pass unchanged.                                                   |
| 3   | Schema and repositories: `slack_installs`, `slack_links`, `slack_link_codes`, `slack_channel_defaults`, `slack_threads`, `slack_event_claims`, and `agent_sessions.origin`.                   |
| 4   | `@mend/slack`: the manifest, the mention and option parser, repository-URL matching against `originUrl`, thread-context assembly and message formatting, as pure functions with tests.        |
| 5   | Install and link: owner-only API routes, Settings → Slack (manifest, tokens, `auth.test` and `apps.connections.open`, the display settings), the `/slack/link/<code>` page, and audit events. |
| 6   | The Socket Mode runner in the worker: connect per install, acknowledge, claim, pick the project without inference (message, thread URL, defaults, buttons), and start the session.            |
| 7   | The thread reporter: reactions, the status message, agent messages, questions, the review count, and the display settings.                                                                    |
| 8   | Project inference from the thread, in `@mend/inference`, with "Switch project".                                                                                                               |
| 9   | Follow-ups, `new`, answers and resume in a thread, and `help`, `settings` and `list`.                                                                                                         |
| 10  | Screenshots from the thread.                                                                                                                                                                  |
| 11  | The session summary in the thread, from the review tour, and Claude's plans as a checklist.                                                                                                   |

PRs 2 and 4 depend on nothing else. PR 6 needs 2, 3 and 5. After PR 7, `@mend <prompt>` in a thread
that links a repository, or in a channel with a default, starts a session and reports back. That is
the first slice worth using. PR 8 makes a thread that names no repository work too.

## Decision log

1. **Copy Cursor's shape.** People who use `@cursor` already know how it reads a thread, picks a
   repository and takes follow-ups. Mend departs from it only for its own model: sessions, owners
   and shared control, private projects. It first departed on PRs too; ADR 0007 made landing
   Cursor's `autopr` default, with a question guard.
2. **Socket Mode, not the Events API.** Most Mend instances are `loopback` or `private`, and Slack
   cannot reach them. A public events route would also have to pass the public exposure gate.
3. **An app per organization, not a shared app.** A shared app needs a Marketplace listing or an
   OAuth redirect. Socket Mode rules out the first, and a private instance rules out the second.
4. **The thread picks the project.** A thread about a bug usually links the repository or names the
   code, and asking which project each time is the step people skip. Repository links are matched
   exactly before inference is used, so the common case costs nothing and cannot be wrong in an
   inference-shaped way.
5. **Ask rather than guess.** Starting a session in the wrong project costs a worktree, a workspace
   and the requester's credentials. When nothing answers, a button is cheaper.
6. **An explicit link, not an email match.** Mend spends the linked account's credentials, so
   control of that account has to be shown. Matching email addresses does not show it.
7. **Only shared projects in channels.** A channel is read by people who cannot see a private
   project, and Mend's posts would tell them it exists.
8. **Only a mention reaches the agent.** People talk in threads, and treating every reply as a turn
   would send half-formed chat to an agent with Git access.
9. **Diffs off by default.** Slack is outside the instance, and plan §15 says no code leaves without
   explicit configuration. The owner's diff setting is that configuration.
10. **One start path.** A second implementation of session start would drift from the first, and the
    drift would land in authorization.

## Open questions

1. **Resume with a prompt.** Whether a protocol resume takes an opening turn needs checking in
   `engine.ts` before PR 9. If it does not, a mention on a settled session starts a new one.
   Answered in PR 9: `SessionEngine.launchProtocol` on a session whose latest agent was a protocol
   process of the same harness resumes the provider's session by its id and submits the prompt as
   the opening turn. Slack resumes through `SessionStart.launchAs`, the web app's launch. A session
   with no such agent (none launched, or no provider session id recorded) starts a new one.
2. **Approvals as buttons.** Slack's interactive buttons arrive over the same socket. Answering an
   approval from Slack is a steering action, so it needs the same authorization as a turn. It also
   puts a one-tap "allow" in a channel.
3. **Routing rules.** Cursor lets admins map keywords to repositories. Thread inference may make
   them unnecessary. Add them if inference picks wrongly often enough to matter.
4. **Publishing from Slack.** Cursor's `autopr` opens a PR. Mend could offer "Open a pull request"
   on a completed session, since landing is the person's decision and a button is an explicit one.
   Answered by ADR 0007: a Slack request lands automatically, as Cursor's does, unless it read as a
   question, said `autopr=false`, or the app or the project turns it off. When it does not land, the
   thread offers "Push and open pull request", which acts only for the owner.
5. **Enterprise Grid.** One app installed across several workspaces in an Enterprise Grid org has
   several `team_id`s under one `enterprise_id`. This ADR assumes one workspace per install.
6. **Shared control from a channel.** ADR 0005 already leaves open whether one person steering on
   another person's Claude grant is permitted by Anthropic's terms, and a channel makes that easier
   to do.
