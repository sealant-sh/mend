# Workspace SSH

An editor reaches a session's worktree through the Sealant workspace SSH gateway. Mend discovers the
gateway and registers the client's public key through the public SDK. The client talks to Mend, not
a separate Sealant installation.

The original plan was recorded on 2026-08-29. Manual configuration shipped in mend#151. Self-service
setup is implemented; certificates and attachment leases below remain proposals. The packaging stack
(#210 to #217) shipped persistent gateway keys, per-server client configuration, and explicit remote
addressing. Installed VS Code and physical MacBook-to-Mac-Mini acceptance remain separate checks,
not conclusions from the Linux process tests.

## Current setup

```sh
mend login --url http://mend-server.example:3105
mend ssh setup
mend ssh
```

The last command reports configuration and client-key registration. It does not prove a successful
SSH connection or establish host trust. See the [CLI SSH guide](../apps/cli/README.md#workspace-ssh)
for identity selection, encrypted keys, configuration conflicts, and verified host-key rotation.

- The CLI and VS Code share address and OpenSSH configuration code. The normalized Mend server URL
  determines its alias. Settings for one Mend server do not overwrite another server's settings.
- The configured Mend URL supplies the client-reachable hostname. Gateway metadata supplies the SSH
  port and username prefix. Explicit overrides support unusual network layouts. Mend does not
  discover interfaces or fall back to a path on the client's filesystem.
- Managed settings precede wildcard defaults because OpenSSH uses the first matching value. Setup
  preserves unrelated Host/Match rules and refuses a rewrite when it cannot preserve their scope.
- The selected public identity must have a matching usable private key or be available through an
  unlocked SSH agent. Setup preserves an existing selection rather than silently replacing it.
- The workspace ID travels in the SSH username. The editor opens `/workspace/repo` through the
  server's alias; it does not need a new SSH configuration block for each session.
- A settled session needs a running workspace. The editor flow offers shell resume without launching
  an agent. Agents started in that terminal can be observed through the mounted harness home, as
  implemented by the observed-agents work in mend#147 and mend#148.

## Removing a key

```sh
mend ssh keys                          # every key your account registered, this machine's marked
mend ssh keys remove SHA256:Vn6v0P2d…  # the SHA256: prefix is optional
```

Settings → Workspace SSH lists the same keys with a Remove action. A person sees and removes only
their own keys: Mend asks the platform for the caller's Sealant user's keys, and archiving a key id
that is not theirs answers 404, as an unknown id does, for an organization owner and the operator
too. An owner removing one key of a member they keep is not built. The audit log records each key
registered (`ssh_key.added`) and removed (`ssh_key.removed`).

Removing a member from the organization removes all of their keys. The membership's deletion and a
row in `ssh_key_revocations` commit in one transaction, so a removal is never recorded without the
keys it owes. Mend's own revocation follows at once and never waits on the platform: the account is
deactivated, its sign-ins, devices and Slack links revoked, its connections closed on every process,
and its sessions set stopping. Only then does the removal ask the platform, archiving every key it
lists for them, each on its own, so one refused archive does not stop the rest. It waits at most 15
seconds for that; past it, or if the removal is interrupted, what was archived stays archived and
the rest is the worker's.

Whatever is still active, unread, or unconfirmed when the removal answers stays owed: the answer
says how many (`sshKeysOutstanding`, null when Mend could not tell), the audit log records
`ssh_key.revocation_pending`, and the worker retries every minute it is due (30 seconds after a
failure, doubling to at most 30 minutes) until the platform holds none of theirs active. There is no
upper bound on that window while the platform keeps failing; the keys stay owed and the worker keeps
trying. Each key archived later is its own `ssh_key.removed`, with its attempt number. The retries
need no membership: they act on the removed account's own Sealant identity, which Mend keeps. Each
obligation has its own id, so an attempt at an earlier removal of the same account can neither
settle nor defer a later one. A removal refused for the last owner owes and touches no key.

The gateway looks a key up through the platform on every new connection and caches nothing across
connections, so the next connection offering a removed key is refused. What happens to a connection
authenticated before the removal depends on the platform, and the removal says which
(`openConnections` on `DELETE /api/workspace-ssh/keys/:id`, read from the platform's
`sshKeyRemovalEndsConnections`):

- `end`: the gateway names the key on every new channel and port forward, refuses all of them once
  the key is removed, and ends the connection. It asks again every minute about a connection that
  opens nothing new. Connections opened with the key end within a minute (sealant#359).
- `stay`: on a platform from before that, a connection authenticated before the removal stays open
  until the workspace it reaches stops. An editor left connected on a lost laptop keeps its session.
  The removal lists the caller's running sessions (`runningSessions`). The CLI prints `mend stop`
  for each, and Settings → Workspace SSH offers to stop them all, agent and Services, so their
  workspaces close and the connections end. A workspace someone else is still working in stays up.

The platform does not record when a key was last used (PLATFORM-FEEDBACK.md, 2026-10-10).

### Limits before login

Workspace SSH may be published to the internet (`mend server setup --ssh-bind`, the `workspace-ssh`
item of the exposure gate). The platform's gateway in this release sets no limits before login. It
has no login timeout and no cap on connections or attempts per address. Every key it does not know
costs one lookup from the single budget all its requests share (Core's
`SEALANT_BUDGET_PRINCIPAL_REQUESTS_PER_MINUTE`, 12000 a minute). Anyone who reaches the port can
spend that budget. The gateway then refuses every login, and every new channel on connections
already open, until the budget refills. Nobody reaches a workspace that way. sealant#359 adds sshd's
limits: a 30 s login grace time, 10 connections not yet logged in per address (100 in all), 6
attempts per connection, 60 key lookups a minute per address, and a lookup budget kept apart from
the one connections already in use.

`mend uninstall --home` removes the key this machine registered, and only that key, before it
revokes the terminal's device token and deletes the key file. It identifies the key by its public
half (the managed block's identity and the public keys under the Mend config directory), so an
encrypted key or a stopped agent still names it. A key it cannot remove, or cannot read well enough
to name, fails the uninstall with the fingerprint still registered and the command that removes it
from another signed-in machine. It never revokes the account's other keys or devices.

The gateway authenticates the key's principal, authorizes access to the named workspace, and bridges
channels onto its `sealantd` connection. Its shell, exec, environment, SFTP, and TCP forwarding
support are the protocol requirements for Remote-SSH. Protocol support alone does not establish
acceptance in an installed editor.

## Server identity and trust

The application container includes the gateway. Its host key persists in a Docker-managed volume,
separate from each workspace. Ordinary server restarts and upgrades preserve it. See
[self-hosting](SELF-HOSTING.md) for server configuration and data ownership.

The public SDK reports gateway coordinates, not its host-key fingerprint. OpenSSH's `accept-new`
policy accepts an unknown key on first connection and rejects a changed key. Mend never removes or
replaces `known_hosts` entries during setup. Verify a changed fingerprint through a trusted server
console or administrative connection before removing only the affected alias entry. `ssh-keyscan`
alone is not verification.

## Proposed follow-up: certificates

Short-lived OpenSSH user certificates could replace public-key registration. A future SDK operation
would return a certificate binding the authenticated principal to one workspace. The gateway would
trust the issuing CA; ordinary registered keys could remain available for plain SSH clients.

This needs a platform contract and implementation. The packaging stack did not include it. A
WebSocket SSH tunnel could separately support networks where the gateway port is unreachable; there
is no such fallback in the current client.

## Proposed follow-up: attachment leases

A future gateway API could report active editor attachments. Mend could then use those attachments
for TTL renewal and reap deferral, and display an observed editor connection. Today an open editor
is not itself a session process row or a guaranteed lease. Keep the session's workspace running; do
not infer editor-presence tracking from SSH configuration or key-registration status.
