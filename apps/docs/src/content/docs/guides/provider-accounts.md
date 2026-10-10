---
title: Connect provider accounts
description: Connect Claude, Codex, and GitHub credentials to the user who launches Mend sessions.
sidebar:
  order: 1
---

Signing in to Mend and connecting a provider are separate steps. `mend login` authenticates the CLI
to your Mend server. `mend connect` attaches Claude, Codex, or GitHub to your own platform identity.

Each Mend user connects their own provider accounts. A session launches with the accounts of the
user who started it. For Claude and Codex, the CLI signs the provider in again, as a login of Mend's
own, so your own Claude Code and Codex logins are never shared with Mend. For GitHub, it sends
`gh`'s token. [How Mend handles your logins](../../concepts/provider-logins/) explains what is kept,
who uses it, and how it stays fresh.

## See what is connected

```sh
mend accounts
```

The command lists Claude, Codex, and GitHub for the signed-in Mend user. It shows account metadata,
not credential values.

## Connect Codex

You need the Codex CLI installed on the machine where you run `mend`:

```sh
mend connect codex
```

The CLI runs `codex login --device-auth` in a throwaway directory: open the link it prints, enter
the code, and approve. That login is sent to your Mend server and deleted here, so the laptop keeps
no copy of it and your own `~/.codex` login is untouched. Run the command again whenever Mend says
Codex needs reconnecting.

To send the login this machine already uses instead (`$CODEX_HOME` or `~/.codex/auth.json`):

```sh
mend connect codex --use-my-login
```

The laptop and Mend then hold one login between them, and whichever refreshes second is signed out.
To provide a file yourself:

```sh
mend connect codex --from-stdin < auth.json
```

## Connect Claude

```sh
mend connect claude
```

Claude Code rotates its refresh token on every refresh, so two copies of one login race and the one
that refreshes second is signed out. Mend refreshes on a schedule. So `mend connect claude` runs
Claude's own browser login against a throwaway directory, sends that grant and deletes the
directory: this machine keeps no copy, because the server refreshes the login from then on. Your own
Claude login under `$CLAUDE_CONFIG_DIR` or `~/.claude` stays as it is, and the command checks that
it still works afterwards. Claude Code must be installed on this machine; `MEND_CLAUDE_BIN` points
at another binary.

Run it again when Mend says the login needs reconnecting. Every run is a fresh login.

To send the login this machine already uses instead:

```sh
mend connect claude --use-my-login
```

Mend and this machine then share one grant, and whichever refreshes second is signed out. Either
way, only the `claudeAiOauth` part of the credential file is sent; MCP tokens in the same file stay
on this machine.

Claude can also create a setup token for another machine. Pipe or paste it through standard input:

```sh
claude setup-token
mend connect claude --from-stdin
```

`--from-stdin` reads until end of file. When pasting interactively, finish with your terminal's EOF
key.

## Connect GitHub

The normal path uses the GitHub CLI:

```sh
gh auth login
mend connect github
```

Mend runs `gh auth token` and forwards the returned token. You can also pipe it explicitly:

```sh
gh auth token | mend connect github --from-stdin
```

The GitHub account supplies `GH_TOKEN` and `GITHUB_TOKEN` to the workspace so `gh` and compatible
tools can authenticate without placing the token in the worktree. In a
[per-person workspace](/operate/per-person-workspaces/) there is no token in the environment: your
login is written as `~/.config/gh/hosts.yml` in your own home, which `gh` reads, and Git over HTTPS
to GitHub uses Mend's credential helper, which reads the same file. A command that needs the token
gets it with `GH_TOKEN=$(/run/mend/bin/mend-git-credential token) <command>`. Repository clone,
fetch, and push authentication over SSH are separate. Read
[Configure Git access](/guides/git-access/).

Landing a change opens its pull request with the GitHub account of the change's owner. Without a
connected GitHub account, the push can still happen and the pull request step fails with that
reason. Read [Land a change](/guides/land-a-change/).

## Connect from the web

Settings on the web has a Connected accounts panel that takes a pasted credential: for Claude, a
setup token from `claude setup-token` or the contents of `~/.claude/.credentials.json`; for Codex,
the contents of `~/.codex/auth.json`; for GitHub, the output of `gh auth token`.

## Replace or remove an account

Running `mend connect <provider>` again updates that provider's connected account.

Remove one with:

```sh
mend connect codex --remove
```

Use `claude`, `codex`, or `github` as the provider. The command fails rather than pretending to
remove an account that is not connected.

## Where the account is used

Connected accounts belong to your Mend user, not the machine-wide settings document. Other users
must connect their own accounts.

In a workspace that shares one home (the operator opted out, or the workspace
[cannot run per person](/operate/per-person-workspaces/#what-a-workspace-needs)), Mend resolves them
when it creates a workspace for a session you own, and every process in that workspace runs on them,
including the processes of someone who joins your worktree. When you turn on shared control there,
others who can see the project steer the session with your provider logins and Git access.

In a [per-person workspace](/operate/per-person-workspaces/) each person's processes run on their
own logins, written into their own home in the workspace:

- **Your sessions, and your joins.** A session you start in a worktree where someone else's session
  runs gets your logins, in your home, never theirs.
- **Your steered turns.** Under shared control each turn runs on its sender's login: when you send a
  turn to someone else's session, Mend runs it in an agent process of your user, on your login.
- **Refused, not borrowed.** When the harness's provider is not connected, the start is refused
  before anything runs, with `Connect Claude to start a session here.` (or Codex). A login that
  needs reconnecting says
  `Your Claude login needs reconnecting. Reconnect Claude to start a session here.` A steered turn
  says `Connect Claude to steer this session.` Nobody else's login is used instead.

Every act is recorded with who did it. Read [Organizations](/organizations/overview/).

Mend's own reads of a change (a tour, "Read this change", "Suggest fixes") run on the Claude account
of the person who asked for them, or their Codex account when they have no Claude account, never on
the change owner's.

A running workspace gets each refreshed copy of your login as it is made, without a restart. A
reconnect applies to new sessions at once; a session already running picks the new login up at its
next scheduled refresh, so restart it if it is failing on the old one.

## When an account is missing

A missing connected account does not block every launch. Mend first requests the harness account and
GitHub together, then retries with useful subsets when the platform reports that an account is
missing. The harness may open its own login flow when no connected provider credential is available.

`mend doctor` reports missing provider accounts as setup tasks rather than machine failures. Connect
the account explicitly when sessions must start non-interactively.

While Mend keeps a Claude grant of its own on this machine, `mend doctor` adds a `grant` line read
from that copy: `Mend's own · expires <day>` while it is good, `expired <day>`, `signed out` for a
cleared grant, or `unreadable`, each with `mend connect claude` beside it. After `--use-my-login`
there is no such line. The web app does not report grant freshness, and a launch does not refuse a
session whose grant is dead.
