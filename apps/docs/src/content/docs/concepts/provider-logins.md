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

- **Claude:** a browser login into a directory of Mend's own on your machine
  (`~/.config/mend/claude-grant`). Only the Claude part of the file (`claudeAiOauth`) is sent;
  tokens for MCP servers you have authorized stay on your machine.
- **Codex:** a device-code login (`codex login --device-auth`) into a throwaway directory. Its
  `auth.json` is sent and the directory is deleted: your machine keeps no copy.

The server stores the login encrypted (AES-256-GCM) in its database.

## Who can use it

Your login belongs to your Mend account and is used for your work:

- **Your sessions.** A session runs on the logins of the person who started it.
- **Review passes over your changes.** A tour, "Read this change" or "Suggest fixes" runs on the
  change owner's login, whoever asks for it.

Nobody else can read your credential, see its value, or choose it for their own sessions. Mend never
uses one person's login for another person's session.

One setting spends your subscription on someone else's action, and only when you turn it on:
**shared control** lets other members of your organization steer a session you own. The session
keeps running on your login, and the setting says so where you turn it on.

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

- [Connect provider accounts](../guides/provider-accounts/) for the commands.
- [Organizations and members](../organizations/overview/) for shared control.
