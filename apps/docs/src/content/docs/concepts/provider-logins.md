---
title: How Mend handles your provider logins
description:
  Where your Claude and Codex logins are kept, who uses them, how they stay fresh, and what Mend
  never does with them.
sidebar:
  order: 3
---

Mend runs the official Claude Code and Codex CLIs on your own subscription. To do that it keeps a
copy of your login for each provider. This page says exactly what it keeps, who can use it, and how
it stays valid.

## The rule

**Only the official CLIs talk to a provider's login and token endpoints.** Mend and the Sealant
platform underneath it never call Anthropic's or OpenAI's OAuth endpoints, never mint or refresh a
token themselves, and never send your credential to a model API directly. Every sign-in happens in
the provider's own CLI and browser flow; every refresh is done by the provider's own CLI.

## What Mend keeps

When you run `mend connect claude` or `mend connect codex`, the CLI signs the provider in again,
through the provider's own flow, and sends that login to your Mend server. It is a login of its own,
not the one your laptop's Claude Code or Codex uses, so using Mend never signs your laptop out and
your laptop never signs Mend out.

- **Claude:** a browser login into a throwaway directory under `~/.config/mend`. Only the Claude
  part of the file (`claudeAiOauth`) is sent, and the directory is deleted (on macOS, with its
  Keychain item).
- **Codex:** a device-code login (`codex login --device-auth`) into a throwaway directory under
  `~/.config/mend`. Its `auth.json` is sent and the directory is deleted.

Your machine keeps no copy of either. The server refreshes the login from then on, so a kept copy
would soon hold a spent refresh token, and sending it again would replace a good login with a dead
one. Each `mend connect` is a fresh login. An older `mend` kept the Claude login in
`~/.config/mend/claude-grant`; `mend connect claude` removes it.

The server stores the login encrypted (AES-256-GCM) in its database.

## Who can use it

Your login belongs to your Mend account and is used for your work:

- **Your sessions.** A session runs on the logins of the person who started it.
- **Your requests to Mend.** A tour, "Read this change" or "Suggest fixes" runs on the login of the
  person who asked for it, whoever owns the change. The passes Mend queues when your session
  settles, and the tour a landing of yours asks for, run on yours.

Nobody else can read your credential, see its value, or choose it for their own sessions. Mend never
spends one person's login on another person's session or request.

In a workspace that shares one home (the operator opted out, or the workspace
[cannot run per person](/operate/per-person-workspaces/#what-a-workspace-needs)), one setting spends
your subscription on someone else's action, and only when you turn it on: **shared control** lets
other members of your organization steer a session you own, and the session keeps running on your
login. Someone who joins your worktree there runs on your logins too: see
[Known issues](/reference/known-issues/#a-session-that-joins-someone-elses-executor-runs-on-their-logins).

In a [per-person workspace](/operate/per-person-workspaces/) no person runs on anyone else's login.
Each person's logins are written into their own home in the workspace, owned by their own Linux
user, and kept fresh there. A joiner's processes run on the joiner's logins, and under shared
control each turn runs on its sender's login. A start whose provider is not connected is refused
(`Connect Claude to start a session here.`). With `sudo`, anyone working in the workspace can still
read those files: see [What sudo means here](/operate/per-person-workspaces/#what-sudo-means-here).

## Where copies go, and why they cannot break your login

A session's machine and a review pass each need the login to run the CLI. They get a copy that
**cannot refresh**:

- a Claude copy has no refresh token;
- a Codex copy has a placeholder refresh token that no provider accepts.

A copy works until its access token expires, and it cannot spend, rotate or revoke your login. The
refresh token stays in one place: your Mend server's store.

## How it stays fresh

Your Mend server refreshes each login on a schedule, well before it expires, by running the official
CLI in a private directory:

- **Claude** about an hour before its access token expires (it lives about eight hours);
- **Codex** a day before (its token lives about ten days).

One refresh runs per login at a time. When it is done, the server writes the new copy into every
session that is running on that login. Claude Code and Codex both pick up a replaced login file on
their own, so a running session carries on without a restart.

Keeping Claude fresh spends a trivial slice of your subscription: the CLI refreshes on use, so each
refresh is one tiny exchange. Codex refreshes without a model request.

## pi and opencode

pi and opencode run on your ChatGPT subscription through the Codex login you connected: there is no
separate login to connect. When either starts, Mend writes that login into the tool's own
`auth.json` in its own format, as the same copy that cannot refresh. In a per-person workspace the
platform writes them into your home and refreshes them as it does the others. A login you make
inside the session with `/login` is yours and is never replaced, and neither tool's login file is
kept with the session.

A Claude subscription cannot be used this way: Anthropic does not allow a Claude Pro or Max login in
third-party agents. Use an Anthropic API key with pi or opencode instead.

## What a session never saves

A session's agent keeps its state in its home directory, and Mend saves that state so a resumed
session finds its conversation again. In a remote workspace the state is saved with the worktree,
and whoever starts the next session there gets it. Logins and tokens are never part of it: none of
the files below is saved, and none is brought back from a session saved before it was on this list.
A path ending in `/` is a directory and everything in it; a file's siblings named after it with a
suffix (`auth.json.lock`, a write's temporary) are left out with it. The Sealant runtime Mend 0.36
bundles (with sealantd#136) applies this list. An older runtime leaves out only
`.claude/.credentials.json`, `.codex/auth.json`, and pi's and opencode's `auth.json`.

| Path                                   | Agent       | Holds                                                                                       |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `.claude/.credentials.json`            | Claude Code | the Claude login, MCP server OAuth tokens and client secrets, plugin secrets                |
| `.claude/.device-keys.json`            | Claude Code | device private keys (Remote Control, trusted devices)                                       |
| `.claude/backups/`                     | Claude Code | copies of `~/.claude.json`: a Console API key, MCP server headers and env                   |
| `.claude/shell-snapshots/`             | Claude Code | the shell's functions and aliases, any secret written in them included                      |
| `.claude/session-env/`                 | Claude Code | what hooks export for the session                                                           |
| `.claude/ide/`                         | Claude Code | IDE connection tokens                                                                       |
| `.claude/sessions/`                    | Claude Code | each running process's local messaging token                                                |
| `.claude/file-history/`                | Claude Code | a copy of every file Claude Code edits, a secret file included                              |
| `.claude/remote-settings.json`         | Claude Code | an organization's managed settings, `env` included                                          |
| `.codex/auth.json`                     | Codex       | the ChatGPT login or API key                                                                |
| `.codex/.credentials.json`             | Codex       | MCP server OAuth tokens, where no OS keyring is available (every workspace)                 |
| `.codex/secrets/`                      | Codex       | encrypted logins and MCP tokens (the key is in the OS keyring)                              |
| `.codex/shell_snapshots/`              | Codex       | every exported environment variable with its value (a token, a dotfile's export)            |
| `.local/share/opencode/auth.json`      | opencode    | provider logins and API keys                                                                |
| `.local/share/opencode/mcp-auth.json`  | opencode    | MCP server OAuth tokens and client secrets                                                  |
| `.local/share/opencode/repos/`         | opencode    | reference repositories, a clone URL's credentials in their git config                       |
| `.local/share/opencode/log/`           | opencode    | logs, a failed clone's URL with its credentials included                                    |
| `.pi/agent/auth.json`                  | pi          | provider logins and API keys                                                                |
| `.pi/agent/mcp-auth.json`              | pi          | MCP server OAuth tokens and client secrets                                                  |
| `.pi/agent/oauth.json`                 | pi          | provider OAuth tokens from before pi moved them to `auth.json`, and its `.migrated` copy    |
| `.pi/agent/mcp-oauth/`                 | pi          | MCP OAuth tokens of the pi-mcp-adapter extension                                            |
| `.pi/agent/mcp-oauth-encrypted/`       | pi          | the same, encrypted with a person's key                                                     |
| `.pi/agent/mcp.json`                   | pi          | MCP servers, with the headers, env and client secrets typed into them                       |
| `.pi/agent/tmp/`                       | pi          | packages a launch loads for itself from git, a source URL's credentials in their git config |
| `.pi/agent/crashes.json`               | pi          | error messages and stacks as they were, a secret in one included                            |
| `.pi/agent/mend/profile/root/mcp.json` | pi          | the same, as Mend delivered it from a person's pi profile                                   |
| `.mend/pi-profile-kept/`               | pi          | pi profiles Mend set aside, their `mcp.json` included                                       |

pi's `mcp.json` is on the list because it can carry the keys typed into its servers' headers and
environment. The copy from your [pi profile](/guides/pi/) is written again at every launch, so yours
is never lost. What a session changes in it, a server added with `pi mcp add`, one turned on or off
with `/mcp`, or an edit to the delivered copy, lasts as long as that session's machine; put it in
your pi profile to keep it. Claude Code's `file-history/` holds a copy of every file it edits, a
secret file included, so a file edit made before a session moved to a new machine cannot be rewound
there.

Some settings files can hold a secret you type into them, and they are saved, because they also hold
your settings: Codex's `config.toml`, Claude Code's `settings.json` (`env`), and pi's `models.json`
and `settings.json` (a key, or a package installed from a URL with a token in it). Name a variable
or a command there instead of the value (Codex: `bearer_token_env_var`, `env_http_headers`,
`env_key`; pi: `$NAME` or `!command`). Keep a value that is yours in a
[secret file](/guides/secret-files/), which is never saved, and one the project shares in a
[project secret](/guides/environment-variables/). opencode keeps an opencode console login and its
integration logins in its database, beside the conversations, and the database is saved: make those
logins only in a worktree nobody else uses.

### Never saved, and not logins

These are not logins either, but they belong to the machine a session ran on rather than to its
work, and are never saved for the same reasons. A `codex` you type in a session's terminal unpacks
its own copy of Codex and starts a background server; Codex makes them again when it next needs
them.

| Path                         | Agent | Holds                                                       |
| ---------------------------- | ----- | ----------------------------------------------------------- |
| `.codex/packages/`           | Codex | the Codex runtime a hand-run `codex` unpacks (about 427 MB) |
| `.codex/app-server-daemon/`  | Codex | the state of an app-server daemon running on that machine   |
| `.codex/app-server-control/` | Codex | that daemon's control socket                                |

## When a login stops working

A provider can end a login on its own: you signed out of that session elsewhere, changed your
password, or the login was revoked. The next refresh is then refused, and Mend says so:

- `mend doctor` and the web and phone apps show the account as **reconnect needed**, with the
  provider's words;
- a new session with it is refused before a machine starts;
- a tour or suggestion says `reconnect Claude` or `reconnect Codex`.

Run `mend connect claude` or `mend connect codex` again. A new login replaces the old one, and the
next session uses it.

## Using your laptop's own login instead

`mend connect claude --use-my-login` and `mend connect codex --use-my-login` send the login your
laptop already uses. It works, but the laptop and Mend then hold one login between them: whichever
refreshes second is signed out, and your laptop refreshes whenever you use it. Prefer the default.

## See also

- [Connect provider accounts](/guides/provider-accounts/) for the commands.
- [Organizations and members](/organizations/overview/) for shared control.
