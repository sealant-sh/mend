# Workspace SSH

An editor reaches a session's worktree through the Sealant workspace SSH gateway. Mend discovers the
gateway and registers the client's public key through the public SDK. The client talks to Mend, not
a separate Sealant installation.

This page records the design behind it: what setup relies on, and how removing a key and removing a
member take effect. How to use it is elsewhere:

- setup, identity selection, configuration conflicts, removing a key and gateway host-key rotation:
  the [CLI's Workspace SSH section](../apps/cli/README.md#workspace-ssh);
- publishing the gateway beyond loopback and the `workspace-ssh` gate item:
  [exposure](../apps/docs/src/content/docs/operate/exposure.md) and
  [deploy on a VPS](../apps/docs/src/content/docs/operate/deploy-vps.md);
- the gateway's limits before login:
  [Mac mini with VS Code](../apps/docs/src/content/docs/operate/mac-mini-vscode.md#behind-an-https-edge).

## Setup

- The CLI and VS Code share address and OpenSSH configuration code. The normalized Mend server URL
  determines its alias. Settings for one Mend server do not overwrite another server's settings.
- The configured Mend URL supplies the client-reachable hostname. Gateway metadata supplies the SSH
  port and username prefix. Mend does not discover interfaces or fall back to a path on the client's
  filesystem.
- The workspace ID travels in the SSH username. The editor opens `/workspace/repo` through the
  server's alias; it does not need a new SSH configuration block for each session.
- A settled session needs a running workspace. The editor flow offers shell resume without launching
  an agent.
- Setup reports configuration and client-key registration, not a successful connection or host
  trust. The public SDK reports gateway coordinates, not its host-key fingerprint, so OpenSSH's
  `accept-new` decides first contact, and Mend never removes or replaces `known_hosts` entries.

## Removing a key

```sh
mend ssh keys                          # every key your account registered, this machine's marked
mend ssh keys remove SHA256:Vn6v0P2d…  # the SHA256: prefix is optional
```

Settings → Workspace SSH lists the same keys with a Remove action. A person sees and removes only
their own keys: Mend asks the platform for the caller's Sealant user's keys, and archiving a key id
that is not theirs answers 404, as an unknown id does, for an organization owner and the operator
too. The audit log records each key registered (`ssh_key.added`) and removed (`ssh_key.removed`).

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
connections, so the next connection offering a removed key is refused. Connections already open with
it end too. The gateway names the key on every new shell, command, file transfer and port forward,
and once the key is removed the platform refuses it (`WorkspaceSshKeyNoLongerRegisteredError`); the
gateway then ends the connection. A connection that opens nothing new is asked again every minute,
so every connection opened with the key ends within a minute of its removal (sealant#359). The
removal says so (`openConnections: "end"` on `DELETE /api/workspace-ssh/keys/:id`, read from the
platform's `sshKeyRemovalEndsConnections`).

On a platform from before that, the removal answers `openConnections: "stay"`: connections already
open stay open until the workspaces they reach stop. The answer then lists the caller's running
sessions (`runningSessions`). The CLI prints `mend stop` for each, and Settings → Workspace SSH
offers to stop them all, agent and Services, after a confirmation. Mend's own packaged server always
runs the platform it pins, so this applies only to a server pointed at an older Sealant.

The platform does not record when a key was last used. `mend uninstall --home` removes the key this
machine registered, and only that key, before it revokes the terminal's device token.

## The gateway

The gateway authenticates the key's principal, authorizes access to the named workspace, and bridges
channels onto its `sealantd` connection. Its shell, exec, environment, SFTP, and TCP forwarding
support are the protocol requirements for Remote-SSH. Protocol support alone does not establish
acceptance in an installed editor.

The application container includes the gateway. Its host key persists in a Docker-managed volume,
separate from each workspace, so ordinary server restarts and upgrades preserve it.
