---
title: Executor
description: Give sessions service tools through an Executor run for your organization.
---

[Executor](https://executor.sh) gives agents tools for services such as Linear. Mend relays those
tools through its `mend` MCP server, alongside screen and proof tools, for Claude, Codex, OpenCode
and pi. Grants stay sealed on Mend's server. A workspace receives neither an Executor token nor its
address.

## Set the organization's Executor

An organization owner opens the **Executor** row in **Settings → MCP servers** and saves the
Executor's origin, such as `https://executor.example.org`. Both Mend's server and the person's
browser must reach it. HTTPS is required except for loopback addresses. The Executor must support
v2's dynamic client registration and OAuth grants.

Members can read these settings. Only owners change the address or link **Mend's member**. Use an
Executor member made for Mend, not a person's account. Click **Link**, sign in at that Executor, and
consent twice. The two consents let Mend call tools and use Executor's service API as the same
member. Executor returns to Mend's configured `APP_URL` after each consent.

Changing or clearing the address revokes existing grants. Everyone links again at the new address.

## Let Mend run Executor

In a packaged Docker installation, an owner chooses **Mend runs Executor for this organization** in
the same settings. Sealant starts one private instance for that organization, with a 1.5 GiB memory
limit and retained data. No Executor address or page reaches a browser. Mend creates its own member
and obtains its two grants between servers. Mend adds no services for anyone.

The page reports the state Sealant observed and the observation time. **Stop Executor** keeps
service logins and data. When a Mend release includes a new Executor image, **Back up and upgrade
Executor** stops it, saves a complete volume backup in Mend's private store, and then starts the new
image over the retained data. A failed backup leaves Executor stopped and prevents replacement. Keep
Mend's secrets key and sealant's credentials key through upgrades.

**Remove Executor** asks you to confirm that the organization's service logins are deleted. Mend
stops the instance and asks Sealant to purge its retained volume, sealed environment and private
endpoint. It then deletes its saved upgrade backups, sealed first-start state and everyone's links.
If any step fails, the removal record stays so an owner can retry Remove. Starting is refused after
removal begins. Removing an Executor cannot be undone; a later start creates an empty one.

Kubernetes support is refused while sealant has only manifest verification for its caller-owned
services. Other unsupported runtimes and a Mend server running directly on the host also receive a
clear refusal. The organization's own Executor remains available in those deployments.

Operators configure sealant API and worker with the same `SEALANT_RESOURCE_CALLERS`. The packaged
Compose file names the `mend-mend-1` container, or `MEND_CONTAINER_NAME`, as caller `mend`, allowing
its private callback port 4401. The port is never published. A separate sealant installation must
name the actual Mend server container. Development requires this container topology too; the host's
`pnpm dev` server cannot serve a caller-only instance. Set `MEND_EXECUTOR_RUNTIME=docker` only in
that server container. sealant, rather than Mend, creates and guards each instance's networks.

## Link your account

Open **Settings → MCP servers**, open the **Executor** row and click **Link**. For a Mend-run
Executor, that one click signs you in and obtains both grants on Mend's server. Your browser stays
in Mend. Mend sends a verified synthetic address,
`<account id>@<organization id>.people.mend.invalid`, to this private provider. It keeps your real
sign-in email unchanged.

For your organization's own Executor, complete both consents at Executor. Manage the services and
accounts your link can use in that Executor.

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

## Add services and connect accounts

With a Mend-run Executor, owners add an MCP address under **Shared services** in the organization's
Executor settings. People add private services and connect their own accounts under their personal
Executor link in the same row. OAuth opens the service's own sign-in page and returns to Mend;
API-key methods show fields in Mend. See [Services through Executor](/guides/executor/) for sharing,
account selection and disconnecting a saved login.

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

## Private sign-in for operators

Mend-run Executors reach a separate HTTPS listener on port `4401` over Sealant's private caller
network. Do not publish that port. The packaged compose file maps the caller and callback hostname
to the Mend container; the development overlay uses `mend-dev-caller`. If you set
`MEND_CONTAINER_NAME`, use the actual running Mend container's name. The chart prepares the private
callback Service and caller-pod policy while continuing to refuse Mend-run Executor on Kubernetes.

Mend generates a private CA and seals its key in PostgreSQL using Mend's secrets key. Each Executor
trusts the public CA through `NODE_EXTRA_CA_CERTS`. Back up Mend's database and secrets key
together. Mend retains the CA across restarts and organization removal because other organizations
use it. The listener certificate renews on server startup when its hostname changes or fewer than 30
days remain. Restart Mend within each year to load a renewed listener certificate.

The provider has no browser sign-in or registration page. A Link click creates a ticket valid for 30
seconds, bound to that person, organization, client and exact authorization request. PostgreSQL
consumes it atomically, including a mismatched attempt. A provider cookie cannot replace a ticket.
Mend also checks membership again when consuming it. Removal deletes this organization's private
identities, stored sessions, client and unfinished tickets along with its Executor data and links.
