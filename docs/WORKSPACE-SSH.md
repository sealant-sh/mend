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
