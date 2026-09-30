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
Claude's own browser login once against a directory Mend keeps, `~/.config/mend/claude-grant`, and
sends that grant. Your own Claude login under `$CLAUDE_CONFIG_DIR` or `~/.claude` stays as it is,
and the command checks that it still works afterwards. Claude Code must be installed on this
machine; `MEND_CLAUDE_BIN` points at another binary.

Run it again when Mend says the grant expired. When the grant on this machine has no refresh token
or is past its expiry, the command logs in again once and says which it was.

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
tools can authenticate without placing the token in the worktree. Repository clone, fetch, and push
authentication are separate. Read [Configure Git access](/guides/git-access/).

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

Connected accounts belong to your Mend user, not the machine-wide settings document. Mend resolves
them when it creates a workspace for a session you own. Other users must connect their own accounts.
When you turn on shared control for a session, others who can see the project steer it with your
provider logins and Git access; every act is recorded with who did it. Read
[Organizations](/organizations/overview/).

Mend's own reads of a change (a tour, "Read this change", "Suggest fixes") run on the change owner's
Claude account, or Codex when there is no Claude account, whoever asks for them.

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
