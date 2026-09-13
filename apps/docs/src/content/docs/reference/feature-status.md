---
title: Feature status
description: Separate implemented Mend behavior from planned product work.
sidebar:
  order: 1
---

Mend is under active development. This page describes the current repository, not a promise about a
published release. Run `mend version` and `mend doctor`, and check your installed versions before
following a guide.

## Implemented in the current repository

| Area                | Current behavior                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project store       | Clone network Git URLs into a bare repository owned by Mend; local paths and `file://` sources are rejected                                                                                                 |
| Worktrees           | Durable named checkouts; sessions join by name, several live at once                                                                                                                                        |
| Agents              | Launch Codex, Claude Code, OpenCode, and arbitrary commands                                                                                                                                                 |
| Session processes   | Run PTY agents, protocol agents, shells, and Services in one session workspace                                                                                                                              |
| Reattachment        | Detach and replay terminal output from CLI, web, desktop, and mobile clients                                                                                                                                |
| Workspace images    | Managed Arch, Ubuntu, Fedora, and Nix families plus custom OCI bases                                                                                                                                        |
| Project environment | Plaintext configuration, encrypted write-only secrets, `.env` import                                                                                                                                        |
| Cluster bindings    | Declared per project; resolved into workspace environment at each cluster launch                                                                                                                            |
| Identity            | Per-user Claude, Codex, and GitHub connected accounts                                                                                                                                                       |
| Dotfiles            | Repository-backed setup and home-file snapshots per user                                                                                                                                                    |
| Extra inputs        | Read-only references and per-project folder mounts; a mount path must exist on the Mend server's own filesystem, which in the Docker deployment means a path under the application container's store volume |
| Services            | Explicit supervision, raw TCP/UDP host forwards, authenticated client tunnels                                                                                                                               |
| Hot sessions        | Standby executors keyed by launch-input fingerprints, bound to a fresh worktree at claim                                                                                                                    |
| Install command     | Per-project dependency install, detected from the lockfile when unset; Mend runs it on a platform mismatch and to fill the shared cache                                                                     |
| Git access          | Ambient host auth, Mend deploy keys, SSH-agent bridge, workspace transport shim                                                                                                                             |
| Remote access       | Browser access, device pairing, bearer revocation; advertised and pairing URLs come only from the server's configured origins                                                                               |
| Change review       | Worktree-versus-base diffs, checkpoints, comments, tours, suggestions, follow-ups                                                                                                                           |
| Kubernetes          | Helm chart, network session channel, and cluster workspaces via the Sealant chart                                                                                                                           |
| Self-hosted server  | `mend server setup` runs the Mend application and Postgres containers on local Docker; status, logs, start, stop, restart, and explicit `upgrade --version` with a private pre-migration database dump      |

Some implemented paths still need release-level acceptance tests. The operational guides state known
boundaries where that matters.

## Planned or incomplete

| Area                        | Status                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context items and packs     | Planned; no public library or selection workflow                                                                                                                 |
| Immutable context snapshots | Schema exists, but session provisioning does not attach one                                                                                                      |
| Editable handoffs           | Planned                                                                                                                                                          |
| Published native mobile app | Source exists; no supported distribution path                                                                                                                    |
| Scoped device permissions   | Planned; current paired tokens have normal authenticated access                                                                                                  |
| Automatic listener exposure | Not planned; Services remain explicit                                                                                                                            |
| Public internet ingress     | Not a default goal; use a private network                                                                                                                        |
| Backup and restore          | `mend server upgrade` saves a private `pg_dumpall` dump before activating a target; restore is a manual operator procedure, and volume backups are yours to take |
| Rollback                    | Downgrades are refused; once a target's migrations may have run there is no automatic rollback or database restore                                               |
| macOS and installed VS Code | Not verified; Linux checks are not evidence for Docker Desktop, OrbStack, or Remote-SSH acceptance                                                               |
| Automatic merge decisions   | Explicitly outside the product model                                                                                                                             |

## Canonical sources

- [`MEND-AGENT-WORKBENCH-PLAN.md`](https://github.com/sealant-sh/mend/blob/main/MEND-AGENT-WORKBENCH-PLAN.md)
  owns product direction and decisions.
- [`PLATFORM-FEEDBACK.md`](https://github.com/sealant-sh/mend/blob/main/PLATFORM-FEEDBACK.md) owns
  gaps between Mend and the public Sealant SDK.
- The implementation and its tests determine whether a current command or UI path exists.

A plan milestone is not release status. A platform feature marked implemented at its source is not
available to Mend until a released SDK is installed and Mend adopts it.
