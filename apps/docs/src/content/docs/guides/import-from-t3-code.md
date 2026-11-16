---
title: Import from T3 Code
description:
  Bring your T3 Code threads into Mend with mend import t3. Each Claude or Codex thread becomes a
  session holding its own conversation, ready for your next message.
sidebar:
  order: 7
---

`mend import t3` turns the T3 Code threads on your machine into Mend sessions. Each Claude Code or
Codex thread whose conversation is on the machine becomes a session that holds that conversation,
with its history shown. Your next message starts the agent on that conversation.

Run it on the machine that holds your T3 Code data, signed in to your Mend server with the CLI. The
server can be on another machine. Nothing is pushed to origin, and T3 Code's data, the harnesses'
files and your checkouts are not written to.

## T3 Code's words in Mend

| In T3 Code    | In Mend                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| environment   | your Mend server                                                               |
| project       | a project: a repository Mend adopted into its own store, found by its `origin` |
| thread        | a session: one agent conversation in a worktree                                |
| worktree      | a worktree in Mend's store; several sessions can share one                     |
| provider      | the session's harness: `claude` (Claude Code) or `codex` (Codex)               |
| runtime mode  | permission mode: full access is `bypass`, approval required is `ask`           |
| checkpoint    | a checkpoint Mend takes at each turn's end                                     |
| changes panel | the change: the worktree against its base, one per worktree                    |

A handoff is how Mend copies a checkout from your machine into a new worktree, the way
[`mend handoff`](/guides/hand-off-local-work/) does it. The import hands off each checkout your
threads ran in.

## Before you start

- A Mend server and a `mend` CLI that both have `mend import t3`. A server without it is named with
  its version:
  `this Mend server (…) takes no imported conversations · upgrade it, then import again · nothing was imported`.
- A server on the capture store, which is what `mend server setup` installs. A server set to the
  co-located store takes no handoffs, so it takes no imports either, and the CLI says so.
- Your own Claude or Codex login connected in Mend
  ([Connect provider accounts](/guides/provider-accounts/)). Each session's first message runs on
  it.
- For each thread, its checkout with an `origin` Mend can clone, as for any handoff. When no project
  matches the origin, the import adopts it.

## See the plan first

```sh
mend import t3 --dry-run
```

The command reads T3 Code's data (`T3CODE_HOME`, else `~/.t3`) and the conversations in your Claude
and Codex homes (`~/.claude` and `~/.codex`, or `CLAUDE_CONFIG_DIR` and `CODEX_HOME`). It asks the
server what it takes, then prints its plan per T3 Code project. With `--dry-run` it stops there and
sends nothing.

```text
6 threads in T3 Code · conversations up to 64 MiB on this server
1 archived thread is left out · --archived brings them

newsroom-api
  ~/src/newsroom-api · handed off once, your checkout unchanged · adopts github.com/dana/newsroom-api as newsroom-api
    ✓ Fix the login redirect · claude · 3.1 MiB
    ✓ Add a health check · codex · 1.4 MiB
  ~/.t3/worktrees/newsroom-api/rate-limits is gone · a new worktree from origin on t3code/rate-limits if origin has it, else the default branch · adopts github.com/dana/newsroom-api as newsroom-api
    ✓ Rate limits · claude · 12 MiB
    ! Migrate the jobs table · claude · 212 MiB · over the server's 64 MiB limit, so it stays here; the server's operator can raise it with MEND_BUDGET_CONVERSATION_BYTES
  stays in T3 Code
    · First spike · its claude conversation is not on this machine (looked in ~/.claude)

dry run · 3 threads to import · 1 checkout to hand off · 1 project to adopt · nothing was sent
```

Under each project, a line names a checkout and what happens to it: handed off once, or gone and
started again from origin. It also says which Mend project the threads go into, or which repository
the import adopts. Each thread under it reads:

- `✓` it will be imported, with its harness and size;
- `·` it was imported before, with its session, and is passed over;
- `!` it stays behind, and the line says why.

"stays in T3 Code" lists the threads the import cannot bring, each with its reason. They are not
failures. The last line counts what a real run would send.

Choose what to import with `--project`, by T3 Code's project id, title or folder, and `--thread`, by
T3 Code's thread id. Both repeat. Archived threads are left out unless you pass `--archived`; a
thread you name with `--thread` is always included.

## Import

```sh
mend import t3
```

The command prints the same plan and asks once before it sends anything. `--yes` skips the question,
and without a terminal the command refuses unless `--yes` is given. Then, in order:

1. It adopts each repository that no project of yours has yet.
2. It hands off each checkout once: its branch as it is, with commits ahead, staged, unstaged and
   untracked files, without holding a workspace or starting an agent. Threads that ran in the same
   checkout land in the same worktree, each as its own session, whatever their harness.
3. It sends each thread's conversation to its session, one at a time. A conversation travels as the
   harness's own files: for Claude Code, the transcript, its tool results, subagents, tasks, todo
   list and the plan files it names; for Codex, the rollout and the rollouts it continues. The
   session takes the thread's title as its label, and its model, reasoning effort and permission
   mode.

The session shows the conversation's history straight away, before any agent runs. The end of the
run prints one line per session to carry it on:

```text
3 threads imported

Each session starts its agent on the imported conversation with your next message:
  mend message 3f2a1c0d --resume "…"  # Fix the login redirect · claude
  mend message 8b41e7a2 --resume "…"  # Add a health check · codex
  mend message c90d5f13 --resume "…"  # Rate limits · claude
```

A refusal, a conversation over the limit or a failed handoff is recorded against its thread or
checkout, and the run goes on. The end of the run names each one in the server's words, and the
command then exits with code 1.

A conversation over the limit counts as a failure only in a run that sends something. When nothing
is left to send, the command prints `nothing to import` and exits with code 0, even when its plan
shows threads over the limit. So a second run whose only threads left are over the limit exits with
code 0, though the first run, which sent the other threads, exited with code 1.

## What comes across and what stays

| In T3 Code                                                                               | In Mend                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Claude Code or Codex thread with its conversation on this machine                      | A session holding the conversation, its history shown                                                                                                                             |
| Its checkout, with commits ahead and uncommitted files                                   | A worktree, by [handoff](/guides/hand-off-local-work/#what-travels-and-what-stays). Gitignored files and `.env*` files stay in your checkout, and the CLI names the `.env*` files |
| A thread whose checkout T3 Code removed                                                  | A session in a new worktree from origin, on the thread's branch when origin has it, else the default branch. Its uncommitted work went with the checkout                          |
| A thread with no conversation file on this machine                                       | Stays. T3 Code keeps its own record of the messages, but an agent cannot resume from it                                                                                           |
| A conversation over the server's limit, 64 MiB by default                                | Stays, named with its size. The server's operator can raise the limit                                                                                                             |
| A conversation in a Claude or Codex home whose folder is not named `.claude` or `.codex` | Stays. Mend cannot rewrite its paths yet. A `CLAUDE_CONFIG_DIR` of `/srv/dana/.claude` imports; one of `~/.config/claude-work` does not                                           |
| A thread whose project has no `origin`                                                   | Stays. Mend adopts a repository from its origin                                                                                                                                   |
| A thread that ran another agent, or switched agents and kept two conversations           | Stays, with the reason                                                                                                                                                            |
| Subagent threads and threads started from another thread's agent                         | Not listed. A subagent's conversation travels inside its parent's; a thread another agent started is left out                                                                     |
| Claude Code's file history                                                               | Stays. The import does not read it                                                                                                                                                |
| Lock files and compressed transcripts in a conversation's folders                        | Stay. The plan counts them as files Mend does not take                                                                                                                            |
| T3 Code's checkpoints, queued messages, pins and snoozes                                 | Stay in T3 Code. Mend takes its own checkpoints from the session's first turn                                                                                                     |

When T3 Code has removed a thread's worktree, its uncommitted work is gone with it, and the thread
can only start again from origin. Mend then needs the T3 Code project's own folder to be a checkout
with an origin. When it is not, the thread stays, and the plan says so.

## Paths in an imported conversation

The conversation is written as if it had run in the session's workspace. When the session's agent
first starts, Mend rewrites the conversation's paths: your checkout becomes the worktree's
directory, and references to your Claude or Codex home become the session's own. The agent then
resumes the conversation by its own id.

Two kinds of path keep their old form:

- Paths inside Claude's signed thinking and Codex's encrypted reasoning. Mend keeps those blocks
  byte for byte, because the provider refuses a changed one on resume.
- Paths outside the checkout, such as a sibling repository or another worktree. Mend leaves them as
  written.

## Carry on a thread

Send the session its first message from the CLI:

```sh
mend message 3f2a1c0d --resume "Carry on with the tests."
```

`--resume` starts the session's agent in conversation mode on the imported conversation, with your
message as its first turn, on your own login. After that the session is like any other: send to it,
review its change, stop it and resume it.

Opening an imported session in a terminal before its first message is refused:
`Send a message to this imported conversation before opening it in a terminal.` Send the first
message, then open it in a terminal if you want one.

In the web app the session shows its imported history and reads "waiting for a first message" in the
inbox, on the project page and in its own header. Its composer sends that message. Write it and
press Send, and the agent starts in conversation mode on the imported conversation, with your
message as its first turn. If someone started the session first, from another tab or the CLI, the
composer shows the server's reason and keeps your words.

## In T3 Code, paired with Mend

You can keep using T3 Code's client by pairing it with your Mend server
([t3code](/integrations/t3code/)). An imported session does not show as a thread there until its
agent has started: the gateway shows a session as a thread once it has run its agent in conversation
mode, and an imported session has not yet. Send its first message with `mend message --resume`, and
it appears as a thread with its history. From then on you can send to it from T3 Code, and T3 Code
starts its agent again when it has stopped.

T3 Code's own import, the "Import your projects" step when you set up its client, finds nothing on a
Mend server and reads "No existing Claude Code or Codex projects found." That importer reads files
on the server's machine, and your history is on yours. Use `mend import t3` there instead.

## Run it again

Running `mend import t3` again imports only what is new. Before it sends anything, it passes over
each thread imported before (`already imported as session 3f2a1c0d`), and it hands off only the
checkouts that have new threads.

A checkout that changed between two runs is handed off again as it is now, for its new threads,
which land in a new worktree. The threads imported before stay where they are. So a new thread gets
the checkout as it is now, not the copy the first run handed off.

## Remove an imported thread

Mend keeps an imported conversation with its session, and deleting the session deletes it from the
server. Your T3 Code thread and its files on your machine stay as they were.
