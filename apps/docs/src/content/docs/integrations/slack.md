---
title: Slack
description:
  Start a session by mentioning Mend in a Slack thread. Mend picks the project, runs the session as
  you, and reports into the thread.
sidebar:
  order: 1
---

Write `@mend fix the flaky login test` in a Slack thread. Mend reads the thread, works out which
project it is about, and starts a session as you, with your provider logins and Git access. The
session reports into the thread, and a later `@mend` in the same thread is a follow-up to it.

Review stays in Mend. Slack gets the status, the agent's messages, a summary, links into Mend, and
the branch and pull request when the change [lands](/guides/land-a-change/).

## How the connection works

Each organization runs its own Slack app, created from a manifest Mend generates and installed in
its own Slack workspace. Mend ships no shared app and has no listing in the Slack Marketplace.

The app uses Socket Mode. Mend's worker opens an outbound WebSocket to Slack, one per organization
with Slack connected, and Slack never connects to Mend. The same setup works on a `loopback`,
`private` or `public` instance, and it adds nothing to the
[public exposure gate](/operate/exposure/).

A Slack workspace belongs to at most one organization on an instance.

## Connect the Slack app

An organization owner connects Slack in **Settings → Slack**. Under **Connect a Slack app** the page
shows the manifest (`manifest.json`, with **Copy**) and these steps:

1. Create an app in Slack from the manifest: api.slack.com/apps → **Create New App** → **From a
   manifest**.
2. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write`
   scope. It starts with `xapp-`.
3. Install the app to your workspace, then copy the **Bot User OAuth Token** from **OAuth &
   Permissions**. It starts with `xoxb-`.
4. Paste the first into **app-level token** and the second into **bot token**, then choose **Check
   and connect**.

Before it saves anything, Mend checks the bot token with `auth.test`, the app-level token with
`apps.connections.open`, and that both belong to the same app. Both tokens are sealed at rest and
never shown again.

The manifest turns on Socket Mode and interactivity, subscribes to the `app_mention` and
`message.im` bot events, and asks for ten bot scopes:

| Scope                                                              | Used for                              |
| ------------------------------------------------------------------ | ------------------------------------- |
| `app_mentions:read`                                                | Seeing mentions                       |
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | Reading the thread a mention sits in  |
| `chat:write`, `im:write`                                           | Posting status and replies            |
| `reactions:write`                                                  | Marking the request with ⏳, ✅ or ❌ |
| `files:read`                                                       | Reading screenshots in the thread     |
| `users:read`                                                       | Showing who wrote each message        |

It names no request, redirect or event URL.

Links Mend posts into Slack start with the web address the owner used when connecting. The connected
app's row shows it as `links open <address>`.

Once connected, the owner can **Replace tokens…** or **Remove…** the app. Tokens for the same Slack
workspace keep its links and channel defaults; tokens for another workspace delete them. Removing
the app deletes both tokens, every Slack link and every channel's default project. Sessions started
from Slack stay, with their record and their origin.

## Link your Slack account

Mend acts only for a Slack user who has linked their Mend account, and it never links by matching
email addresses. A linked account is one Mend spends credentials for, so the person has to show they
control it.

The first time you mention `@mend`, Mend answers with a message only you see and a **Link your Mend
account** button. The button opens `/slack/link/<code>` in Mend. Sign in if asked. The page names
the Slack user and the Slack workspace you are about to link, and shows the request you made. Choose
**Link &lt;you&gt; to my account**. Mend then runs that request, so you do not have to ask twice.

The link works once, for ten minutes, and only for members of the organization that connected that
Slack workspace. If the page says your request was not queued, mention `@mend` in the thread again.

Each person sees their own link under **Your Slack link** in **Settings → Slack**, with **Unlink**.
Owners see every link in the organization under **Links** and can remove any of them. Removing a
member from the organization deletes their link.

Mend ignores messages from bots, including its own. A mention from a user outside the connected
Slack workspace, in a Slack Connect channel, gets a private reply saying that only members of the
workspace can use Mend.

## Start a session

Mention Mend with a request. Options can be written inline (`key=value`, placed first) or in plain
words:

```text
@mend fix the flaky login test
@mend in billing-api with codex, make the retry limit configurable
@mend project=billing-api branch=release/2.3 harness=codex effort=high make the retry limit configurable
@mend project="billing api" add a --dry-run flag
```

| Option    | Plain form                     | Meaning                                                     |
| --------- | ------------------------------ | ----------------------------------------------------------- |
| `project` | `in <project>`                 | The project, by name or by repository (`acme/api`)          |
| `branch`  | `from <branch>`, `on <branch>` | The base branch; the project's default otherwise            |
| `harness` | `with claude`, `with codex`    | The harness; the app's **Default harness** otherwise        |
| `model`   | `with opus`                    | The harness's model                                         |
| `effort`  | `with high effort`             | The harness's effort                                        |
| `autopr`  | none                           | `autopr=true` or `autopr=false`: whether this request lands |

An inline option wins over a plain one, and a later duplicate wins over an earlier one. What is left
is the prompt. Slack sessions run the `claude` or `codex` harness in protocol mode. The owner sets
the app's **Default harness** in **Settings → Slack**; it starts as `claude`.

A direct message to the app works the same way without the `@mend`.

The session runs as you, on a new worktree from the base branch. If you have no working credential
for the harness, Mend says so in the thread and starts nothing. Slack sessions count against the
same session and launch budgets as any other session you start.

### What the session reads

The opening turn is your request, then the thread: every message before the mention, up to 50
messages or 20,000 characters, keeping the newest. Each message is labelled with its author and
marked as thread context, separate from your request. Messages from bots and from users outside the
Slack workspace are dropped.

Screenshots in the request and the thread are attached the way a pasted image is: each is saved as a
file in the session's workspace, and the turn names its path. PNG, JPEG, GIF and WebP images up to 8
MB each are attached, the request's own images first, then the thread's, newest first, up to ten
images and 24 MB per turn. Mend names every image it skipped and why, in the turn and in a reply
only you see.

A reply in the thread that does not mention `@mend` is conversation between people and never reaches
the agent.

## Which project a mention runs in

Mend takes the project from the first of these that answers:

1. The message: `project=` or `in <project>`, matched by name or against the repository the project
   was adopted from.
2. The thread: the project of a session already in the thread; otherwise a GitHub or GitLab link in
   the thread to a repository, pull request, issue, commit or file; otherwise Mend uses inference
   over the thread's text to pick one of the candidate projects.
3. The channel default, set with `@mend settings`.
4. Your own default, set under **Your default project** in **Settings → Slack**.

The candidates are the projects you can see. In a channel, only `shared` projects are candidates,
because everyone in the channel reads what Mend posts. In a direct message with the app, your
private projects are candidates too.

The inference step is given the thread's text and, for each candidate, its name, repository URL,
default branch and the names at the root of that branch. It sends no code. It runs once, when a
session starts, and each organization has a ceiling on how many it runs per hour
(`MEND_SLACK_INFERENCES_PER_HOUR`); past it, Mend goes on to the defaults without inference.

The status message says which one decided: `named in the request`, `the thread's session`,
`from a link in the thread`, `from the thread`, `channel default`, `personal default` or `picked`.
When nothing answers, or several projects match, Mend does not guess. It asks with buttons for the
likeliest projects and an **Other…** list, and only the person who made the request can pick.

Until the session's first turn completes, the status message offers **Switch project**. It restarts
the request in a project you pick and stops the session it replaces once the new one exists. Only
the person who made the request can switch.

## Follow-ups in a thread

- `@mend <request>` in a thread that has a session is a follow-up turn for the thread's most recent
  session. The session's owner can always send one; anyone else only while the owner has
  [shared control](/organizations/overview/#who-steers-a-session) on.
- When the agent has asked a question, the owner's next mention answers it instead of starting a
  turn.
- `@mend new <request>` starts another session in the same thread. So does a mention that names a
  different project, harness or base branch.
- `model=` and `effort=` on a follow-up are not applied; they apply when a session starts. Mend
  tells you so in a reply only you see.
- A mention in the thread of a session that is no longer live resumes it with that turn when the
  engine can. Otherwise Mend starts a new session in the thread, with the thread as context, and
  says so.

A follow-up in a channel is refused when the session's project has been made private since.

## What Mend posts

Mend posts only into the thread the request came from.

- A reaction on the request: ⏳ while the session runs, ✅ when it completes, ❌ when it fails or
  the request is refused.
- One status message, edited in place, with an **Open in Mend** button. It reads, for example,
  `billing-api · from the thread · claude · running · mend/flaky-login-test`, and later
  `billing-api · from the thread · claude · completed · observed · mend/flaky-login-test · 4 files · +120 −30`.
- The agent's plan when its first message is one, and each turn's closing message, as replies cut at
  3,000 characters with a link to the rest. A plan with no text of its own, such as Claude's todo
  list, is posted as a checklist.
- A question the agent asks, as a reply that names the owner. Approvals appear as a status line with
  a link and are answered in Mend.
- One end-of-session reply once Mend has read the change: the summary and approach from the change's
  review tour, the count of draft comments and suggested edits, and a **Review in Mend** button. The
  summary is labelled
  `summary · written by Mend using inference on the diff and the session record`. A session started
  from Slack always gets a review tour when it settles with a change, even where the project's
  automatic tour is off.

The status message states what was observed and gives no verdict. When a channel thread's project is
made private while its session runs, Mend edits the status message to
`not shown · the project is private` and posts nothing more there.

Replies meant for one person (the link prompt, most refusals, `help`, `list`, and notes about
skipped images) are ephemeral: only that person sees them. A refused session start is said in the
thread in words that name no server path, and the full reason goes only to the requester. For a
mention at the top of a channel they appear in the channel; for a mention inside a thread, in the
thread.

### Display settings

An owner sets how much reaches Slack in **Settings → Slack**:

| Setting                | Off                                                                   | On                                                                         |
| ---------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Agent messages         | Status, reactions and links only                                      | Also the plan, closing messages, questions and the summary. The default    |
| Diffs                  | Changed files and line counts only. The default                       | Also the diff of each changed file, up to 3,000 characters, once           |
| Slack Connect channels | Only status and links there. The default                              | The two settings above apply there too                                     |
| Land automatically     | A completed turn pushes nothing; the thread offers the owner a button | A request that asked for a change lands when a turn completes. The default |

## Automatic landing from Slack

A session started from Slack lands its change by default: after a completed turn whose request asked
for a change, Mend pushes the session's branch and opens or updates its pull request, as the
change's owner. The status message gains a line such as
`pushed · mend/flaky-login-test · pull request #412 · opened`, and each later landing edits that
line. A refused push or a failed pull request step reads in the remote's own words, and nothing
retries.

What decides, in order:

1. A project whose **Land when a turn completes** is off never lands, whatever the request says.
2. `autopr=true` or `autopr=false` on the request.
3. The Slack app's **Land automatically** setting, on by default.

A request that reads as a question does not land. Mend reads whether a request asks for a change or
a question in the same inference call that picks the project, and `autopr=` overrides that reading.
A follow-up sent by someone other than the owner under shared control does not land either.

When a completed turn left a change that did not land, the thread offers **Push and open pull
request** (**Push and update pull request** once a pull request is open). Everyone in the thread
sees it, and it lands only when the change's owner presses it. See
[Land a change](/guides/land-a-change/).

## Commands

These are commands when they are the first word after `@mend`:

| Command               | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `@mend help`          | Lists the options and commands, in a reply only you see                                   |
| `@mend settings`      | Shows the channel's default project, with buttons to set or clear it                      |
| `@mend list`          | Your sessions started from Slack in this workspace, newest first, in a reply only you see |
| `@mend new <request>` | Starts another session in the same thread                                                 |

Any member can set a channel's default, from the shared projects they can see. In a direct message,
`settings` points to **Your default project** in Mend instead.

## Audit and limits

The organization's [audit log](/organizations/overview/#audit-log) records the Slack app being
connected, replaced or removed, changes to its settings, Slack links created and removed, channel
defaults set and cleared, and each session started from Slack.

Two server variables bound the work one worker process takes from Slack. Both are per worker
process, and `0` turns a ceiling off.

| Variable                         | Default | Meaning                                                                              |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `MEND_SLACK_EVENTS_PER_MINUTE`   | `120`   | Events one install may deliver per minute; past it, Mend acknowledges and drops them |
| `MEND_SLACK_INFERENCES_PER_HOUR` | `60`    | Thread inferences one organization may run per hour                                  |
