---
title: Connect provider accounts
description: Connect Claude, Codex, and GitHub credentials to the user who launches Mend sessions.
sidebar:
  order: 1
---

Signing in to Mend and connecting a provider are separate steps. `mend login` authenticates the CLI
to your Mend server. `mend connect` attaches Claude, Codex, or GitHub to your own platform identity.

Each Mend user connects their own provider accounts. A session launches with the accounts of the
user who started it. For Codex and GitHub, the CLI reads the credential on the current machine and
sends it to the connected-account API without keeping a copy. For Claude, the CLI by default keeps a
Claude login of Mend's own on this machine and sends that.

## See what is connected

```sh
mend accounts
```

The command lists Claude, Codex, and GitHub for the signed-in Mend user. It shows account metadata,
not credential values.

## Connect Codex

Sign in with the Codex CLI on the machine where you run `mend`:

```sh
codex login
mend connect codex
```

By default, Mend reads `auth.json` from `$CODEX_HOME` or `~/.codex/auth.json`.

To provide the file yourself:

```sh
mend connect codex --from-stdin < ~/.codex/auth.json
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

The Claude account is also what Mend's own reads of a change run on.

A live workspace keeps the credentials it started with. Reconnect or remove an account before the
next workspace launch when you need the change to apply to new work.

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
