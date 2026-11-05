---
title: Executor
description: Give sessions service tools through your organization's own Executor.
---

[Executor](https://executor.sh) gives agents tools for services such as Linear. Mend relays those
tools through its `mend` MCP server, alongside screen and proof tools, for Claude, Codex, OpenCode
and pi. Grants stay sealed on Mend's server. A workspace receives neither an Executor token nor its
address.

## Set the organization's Executor

An organization owner opens **Settings → Organization → Executor** and saves the Executor's origin,
such as `https://executor.example.org`. Both Mend's server and the person's browser must reach it.
HTTPS is required except for loopback addresses. The Executor must support v2's dynamic client
registration and OAuth grants.

Members can read these settings. Only owners change the address or link **Mend's member**. Use an
Executor member made for Mend, not a person's account. Click **Link**, sign in at that Executor, and
consent twice. The two consents let Mend call tools and use Executor's service API as the same
member. Executor returns to Mend's configured `APP_URL` after each consent.

Changing or clearing the address revokes existing grants. Everyone links again at the new address.

**Mend runs Executor** is not set up by this step. An instance that does not supply it shows the
operator's installation instructions, `mend server setup --executor` or the chart's Executor
setting. Installation support ships separately.

## Link your account

Open **Settings → You → Workspace → Executor**, click **Link**, and complete both consents at
Executor. Manage the services and accounts your link can use in your own Executor.

From a terminal already signed in to Mend:

```sh
mend connect executor
mend connect executor --status
mend connect executor --remove
```

`--no-open` prints the consent link without opening a browser. An owner uses `--member` to link or
unlink Mend's member. No Executor grant is saved by the CLI.

A session call runs as the person its session channel names. Under shared control, Bob's turn uses
Bob's link or Mend's member. It never borrows the session owner's link. Calls without a personal
link use Mend's member and see only what is shared with everyone in Executor.

The link's status names an observation. **Executor issued this link · observed 12:04** reports the
last grant exchange. It does not claim that every service answers. When refresh is refused, the page
says **Executor refused this link** and offers **Link again**. Future calls use Mend's member when
available. Mend never retries an already dispatched mutation under another identity.

## Answer a held call

When Executor holds a call, the session's **Executor calls** notice shows its service, tool,
arguments, call identity and observation time. The person it runs as sees **Approve** and **Deny**.
For Mend's member, the person who sent the turn answers. Slack threads and registered phones use the
session's existing notification paths and their usual notification preferences.

Answer in Mend. The agent can poll the stored result with `executor_resume`, but cannot approve or
deny its own call. Mend sends the answer with the original link's tool grant. Calls expire after 15
minutes. An expired call has no approval buttons. Check the service before repeating a mutation
whose outcome was not observed.

Conversation and Record retain the service, tool, identity and outcome of calls. The session's facts
show the most recent Executor observation. Unlink revokes both grants in Executor and removes them
from Mend; if revocation cannot be observed, Mend keeps the sealed link so you can retry.
