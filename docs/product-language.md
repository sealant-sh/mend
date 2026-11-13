# Product language by area

The nouns Mend uses for each area of the product, with the ADR that defines each. `AGENTS.md` holds
the core nouns every task needs. Read the section for an area before writing UI copy, API names,
docs, tickets or code for it. An ADR that adds an area adds its section here, and its name to the
list in `AGENTS.md`.

## Tenancy

`docs/adr/0003-organizations-and-tenancy.md`.

`organization` (the tenant; owns its members, projects, folders, reference repositories and audit
log; an account belongs to one or more, holds its role in each, and each sign-in acts in one at a
time, its `active organization`), `owner` and `member` (organization roles), `operator` (an instance
role that administers the machine and has no default read access to organization content),
`invitation` (a single-use link; registration is closed after the first account), `folder` (a
Mend-managed directory that replaces host mounts). A project's visibility is `private` (its creator
only) or `shared` (its organization). Only a session's owner steers it unless they turn on
`shared control`, which lets others steer: in a per-person workspace each turn spends its sender's
own login; only a workspace that shares one home spends the owner's (ADR 0016 decision 7a).
`MEND_TENANCY=single|multi` picks the posture; `single` is the default and `multi` stays refused
until the multi mode gate passes.

## Access

`docs/adr/0004-access-without-a-private-network.md`.

`exposure` is how an instance is reached, as its operator declares it: `loopback`, `private` (a
network they control admission to) or `public`. Mend reports what it **observed** beside what was
**declared**; an item neither covers is `open`. The `public exposure gate` is that report. An `edge`
terminates TLS in front of the web tier. An `upgrade ticket` is the single-use, thirty-second
credential a socket or the terminal embed carries in its URL. A `budget` bounds what a client, an
account or an organization may ask; it refuses new work and never stops running work. Never write
"tailnet · reachable", "safe to expose" or "gate passed": write what was declared and what was
observed.

## Access keys

`docs/adr/0023-access-keys.md`.

An `access key` is a named bearer credential a person creates so their own automation can call
Mend's HTTP API as them, in the one organization it was created in. It may expire, is shown once,
and cannot create or manage credentials. Never call it an "API key" (a provider login, ADR 0018) or
a "token" (what a paired device holds). The CLI command is `mend access-keys`; `mend keys` is the
person's SSH key.

## Slack

`docs/adr/0006-slack.md`.

A `Slack app` is an organization's own install, made from Mend's manifest and connected over Socket
Mode (outbound only). A `Slack link` joins one Slack user to one Mend account, explicitly, never by
email. A `Slack thread` is a thread sessions report to; `@mend <prompt>` there is a follow-up. Mend
picks a session's project from the message, then the thread, then the channel default, then the
person's default, and says which one decided.

## Landing

`docs/adr/0007-landing.md`.

`landing` is one push of a session's change to origin, plus its pull request, recorded against the
`landed checkpoint` whose tree Mend committed. Only the change's owner (the owner of the worktree's
first session) lands, and Mend never moves the session's branch. `automatic landing` lands after a
completed turn whose request asked for a change (on by default from Slack, as Cursor does), never
for a question. Mend never merges, never force-pushes, and never writes "ready to merge": a landing
reports what was pushed and what GitHub last said (`pull request #412 · open · observed`).

## Screens

`docs/adr/0020-guis-in-sessions.md`.

A `screen` is an X display in a session's workspace that the session's agent sees and drives with
`screen_look` and `screen_act`. Anyone who can see the session watches it; only the session's owner
can `take over` and `hand back`. Mend holds every input. The `screen log` records what the screen
showed and who acted on it, and its `frames` live in Mend's blob store for 30 days. "Desktop" stays
the Electron app: never call a screen a desktop, and never call a frame or the screen log a
recording run.

## Resources

`docs/adr/0019-shared-services.md`, amended 2026-11-01.

A `resource` is a long-running service a project declares in `.mend/mend.toml` (Postgres, Redis or
any image), written with its `@` (`@db`). A `project resource` runs one instance for the project; a
`worktree resource` is a copy for one worktree. Any definition can run at both levels at once; the
worktree resource wins locally. There is no session level. For Postgres, `shared`, `own` and `off`
choose the shared database, its own database on the same server, or no project database; shared is
the default. The `project network` is how a session reaches a resource by name. A `load` replaces a
database's data and saves the previous data as a dump first. A `Service` keeps its meaning: a
session's declared port.

## Setup sessions and proof artifacts

`docs/adr/0021-setup-session-and-proof-artifacts.md`, partly built.

A `setup session` is an ordinary, consented session running Mend's prompt to propose a feature map,
verification instructions and recipes under `.mend/`; its starter's own agent login pays, and its
result is a change. A `proof artifact` is a selected screenshot or short video of the user's web app
with the change on a session's screen, attached to a change with its capture checkpoint and
observation time, or an explicit unknown source. Anyone who can see the change can see it in Mend.
Copies posted to Slack, T3 Code or GitHub follow that service's access rules; public-repository
media is public. Artifacts stay as long as the change; ordinary screen-log frames still expire after
30 days. A frame is one screen observation, not an artifact. Captures describe what was observed,
never claim the change works.

## Executor

`docs/adr/0022-executor-per-organization.md`, being built.

`Executor` (capital E) is the integration gateway from executor.sh that gives agents tools for
services such as Linear; never write a bare lowercase "executor" for it, which already means the
machine a workspace runs on. An `organization's Executor` is `Mend-run` (one per organization, never
reached by a browser) or the organization's `own`. An `Executor link` is one person's consent
letting Mend call that Executor as them; `Mend's member` is who calls run as for someone without a
link, seeing only what is shared with everyone. Screens say `service` for what Executor calls an
app. Approvals happen in Mend, never by the agent.
