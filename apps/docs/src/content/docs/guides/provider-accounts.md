---
title: Connect provider accounts
description:
  Connect Claude, Codex, and GitHub credentials, subscriptions or API keys, to the user who launches
  Mend sessions.
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

## Connect an API key

You can connect an Anthropic API key for Claude or an OpenAI API key for Codex, beside a
subscription or instead of one. The key is billed per token by the provider and has no plan limit,
so set a spend limit first: on the key's workspace in the Anthropic Console, or a budget on its
project in the OpenAI platform.

The CLI reads the key from standard input only, so it never shows on screen. Pipe it in from a
password manager or the clipboard:

```sh
pbpaste | mend connect claude --api-key
```

Use `codex` for an OpenAI key. The command refuses to read from a terminal. It prints the login it
saved, by its last four characters: `Claude · API key ····a1b2 · billed per token`.

Your first login for a provider is your default. When you already hold one, the key is kept beside
it and your sessions keep spending the default. To make the key your default, add `--default`:

```sh
pbpaste | mend connect claude --api-key --default
```

Mend never moves your sessions from one login to the other on its own. A subscription that reached
its limit stays your login until you choose another, and so does a key the provider refused.

In the web app, open Settings → Connected accounts. Choose **Add a Claude API key** under the list,
or **API key** in the Connect dialog, and paste the key. **Use it as my default Claude login** makes
it the default.

To disconnect the key and keep the subscription:

```sh
mend connect claude --api-key --remove
```

Disconnecting does not revoke the key. It stays valid at the provider until you revoke it in the
Anthropic Console or the OpenAI platform.

## Send a key's requests to a compatible endpoint

An API key login can send its requests to a compatible endpoint, such as a company gateway, instead
of Anthropic's or OpenAI's API. Claude needs an Anthropic-compatible endpoint and Codex an
OpenAI-compatible one.

Add `--endpoint` with the endpoint's base URL when you connect the key:

```sh
pbpaste | mend connect claude --api-key --endpoint https://gateway.example.com
```

Give Claude the base URL without `/v1`, because Claude Code adds `/v1/messages`. Give Codex the base
URL its OpenAI-compatible API answers on, which often ends in `/v1`, because Codex adds
`/responses`. If the endpoint takes no key, pipe in any value without spaces:

```sh
echo unused | mend connect codex --api-key --endpoint https://gateway.example.com/v1
```

The endpoint must be an absolute `http` or `https` URL with a host, and no user name, password,
query string or fragment. Mend drops a trailing slash. `http` is accepted because an endpoint on a
private network often has no TLS.

In the web app, choose **API key** in the Connect dialog and fill in **Endpoint (optional)**. With
an endpoint, the key field accepts any value.

Mend shows you the endpoint's host after the key, in Settings, `mend accounts` and `mend doctor`:
`Claude · API key ····a1b2 · billed per token · endpoint gateway.example.com`. Other people see the
login without the host. `mend connect --json` carries the host, never the full URL.

Every session on the login sends its requests to the endpoint and nowhere else. Mend's own reads
that run on your login go there too. Those reads ask for fixed models, so they are skipped on an
endpoint that does not serve them. The model you choose for a session is sent as it is, and the
endpoint must serve it.

The endpoint must be reachable from the session's workspace, not only from your computer. A service
bound to `127.0.0.1` on your own machine cannot be reached from a session. When a turn cannot
connect, the conversation says what Mend observed and where from:

```text
Could not reach gateway.example.com from this session's workspace (connection refused) · observed 21:40
```

To remove the endpoint, connect the key again without `--endpoint`, or with the field empty.

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
setup token from `claude setup-token`, the contents of `~/.claude/.credentials.json` or an Anthropic
API key; for Codex, the contents of `~/.codex/auth.json` or an OpenAI API key; for GitHub, the
output of `gh auth token`. Once you hold a key, the panel lists each of your logins for the
provider, with the default marked. The same panel holds **Give my sessions only the selected agent's
login**.

## Replace or remove an account

Running `mend connect <provider>` again updates that provider's connected account.

Remove one with:

```sh
mend connect codex --remove
```

Use `claude`, `codex`, or `github` as the provider. It removes your default login. Add `--api-key`
to remove your key instead. The command fails rather than pretending to remove an account that is
not connected.

Removing an account stops Mend refreshing it and giving it to new workspaces. A copy already in a
running workspace (your own session's, or your other agent's login in it) works until its access
token expires, its home there is released, or the workspace ends. In a workspace you started, your
copies stay until the workspace ends: stopping your own sessions there may leave them in place while
someone else's session keeps it running.

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
  turn to someone else's conversation session, Mend runs it in an agent process of your user, on
  your login. When that agent runs the other CLI, it reads your own Codex or Claude login, in your
  home. A terminal session stays its owner's: only they type in it.
- **Refused, not borrowed.** When a Claude or Codex session's provider is not connected, the start
  is refused before anything runs, a worktree's first launch as much as a join:
  `Connect Claude to start a session here. Connect it in Settings → Connected accounts, or run mend connect claude.`
  (or Codex). The session line reads `launch refused · …`. A login that needs reconnecting says
  `Your Claude login needs reconnecting. Reconnect Claude to start a session here.`, and a steered
  turn `Connect Claude to steer this session.`, each with the same way to connect. Nobody else's
  login is used instead. pi and opencode need no connected login to start.

Every act is recorded with who did it. Read [Organizations](/organizations/overview/).

Mend's own reads of a change (a tour, "Read this change", "Suggest fixes") run on the Claude account
of the person who asked for them, or their Codex account when they have no Claude account, never on
the change owner's.

A running workspace gets each refreshed copy of your login as it is made, without a restart. A
reconnect applies to new sessions at once; a session already running picks the new login up at its
next scheduled refresh, so restart it if it is failing on the old one.

## Your other agent's login

A Claude session also gets your Codex login, and a Codex session your Claude login, when you have
connected it, so the agent can run `codex` or `claude` on your own login. In a per-person workspace
only your own logins are ever given: a session never gets anyone else's. In a workspace that shares
one home, a join or a steered turn runs on the logins of whoever started it, these included. To give
each session its own agent's login only, turn on **Give my sessions only the selected agent's
login** in Settings → Connected accounts, or run `mend agent-logins selected`. Read
[Only the selected agent's login](../../concepts/provider-logins/#only-the-selected-agents-login).

## When an account is missing

A missing GitHub account does not block a launch: Mend requests the harness account, your other
agent's account and GitHub together, then without an account the platform reports missing. Your
other agent's account is left out the same way when it is missing or needs reconnecting, so a Codex
login that needs reconnecting never stops a Claude session. A missing Claude or Codex account for
the session's own agent does block, in a [per-person workspace](/operate/per-person-workspaces/)
(the default): `mend claude` or `mend codex` is refused before anything starts, as above. In a
workspace that shares one home, Mend steps down to what is connected, and the harness may open its
own login flow when no connected provider credential is available. A shell, pi or opencode session
starts with whatever is connected.

`mend doctor` reports missing provider accounts as setup tasks rather than machine failures. Connect
the account explicitly when sessions must start non-interactively.

While Mend keeps a Claude grant of its own on this machine, `mend doctor` adds a `grant` line read
from that copy: `Mend's own · expires <day>` while it is good, `expired <day>`, `signed out` for a
cleared grant, or `unreadable`, each with `mend connect claude` beside it. After `--use-my-login`
there is no such line. The web app does not report grant freshness, and a launch does not refuse a
session whose grant is dead.
