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

| Area                      | Current behavior                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project store             | Clone network Git URLs into a bare repository owned by Mend; local paths and `file://` sources are rejected                                                                                                                                                    |
| Worktrees                 | Durable named checkouts; sessions join by name, several live at once                                                                                                                                                                                           |
| Agents                    | Launch Codex, Claude Code, OpenCode, and arbitrary commands; an agent run by hand inside a session's shell or editor terminal is observed as its own process                                                                                                   |
| Session processes         | Run PTY agents, shells, and Services in one session workspace                                                                                                                                                                                                  |
| Captured session store    | The default store: workspaces work on their own disk and capture their work to an S3-compatible bucket (Garage in the Docker install), with Postgres holding the pointers; nothing from the host is bind-mounted into a workspace                              |
| Reattachment              | Detach and replay terminal output from CLI, web, desktop, and mobile clients                                                                                                                                                                                   |
| Workspace images          | Managed Arch, Ubuntu, Fedora, and Nix families plus custom OCI bases                                                                                                                                                                                           |
| Project environment       | Plaintext configuration, encrypted write-only secrets, `.env` import; projects inherit their organization's defaults, which inherit the instance's                                                                                                             |
| Cluster bindings          | Declared per project; resolved into workspace environment at each cluster launch                                                                                                                                                                               |
| Identity                  | Per-user Claude, Codex, and GitHub connected accounts; `mend connect claude` makes a Claude login of Mend's own, and `--use-my-login` shares the machine's instead                                                                                             |
| Dotfiles                  | Repository-backed setup and home-file snapshots per user                                                                                                                                                                                                       |
| Git author                | Per-user name and email for the agent's commits (`mend git-author`), defaulting to the registered name and email                                                                                                                                               |
| Skills                    | Per-user and per-project skill libraries, uploaded with `mend skills push` and delivered to sessions at launch                                                                                                                                                 |
| Extra inputs              | Organization references mounted read-only at `/workspace/ref/<name>`, and organization folders a project selects at `/workspace/home/<name>`; captured workspaces receive both as copies                                                                       |
| Services                  | Explicit supervision, raw TCP/UDP host forwards, authenticated client tunnels; attached terminals and the dashboard tunnel a remote session's `--http`/`--https` Services automatically                                                                        |
| Hot sessions              | Standby executors keyed by launch-input fingerprints, bound to a fresh worktree at claim                                                                                                                                                                       |
| Install command           | Per-project dependency install, detected from the lockfile when unset; Mend runs it on a platform mismatch and to fill the shared cache                                                                                                                        |
| Git access                | A Mend key per user, added to the user's Git account or as a deploy key; SSH-agent bridge; ambient host auth; workspace transport shim                                                                                                                         |
| Organizations and tenancy | One organization per instance (`MEND_TENANCY=single`); owners and members; single-use invitations, with registration closed after the first account; private and shared projects; shared control of a session; an audit log; an operator role for the instance |
| Exposure                  | `MEND_EXPOSURE` (`loopback`, `private` by default, `public`); the public exposure gate report (`mend operator exposure`), with `public` refused while an observable item is open; single-use upgrade tickets for sockets and the terminal embed                |
| Budgets                   | Limits on request bodies, request rates, live sessions, launches, bundles and open connections per client, account and organization; a budget refuses new work and never stops running work                                                                    |
| Remote access             | Browser access, device pairing, bearer revocation; advertised and pairing URLs come only from the server's configured origins                                                                                                                                  |
| Change review             | Worktree-versus-base diffs, checkpoints and slices between them, comments sent back to the session, descriptions, tours, and suggestions from Mend reading the change                                                                                          |
| Landing                   | `mend land` and the web push a change to origin and open or update its GitHub pull request; automatic landing after a completed turn; pull requests opened outside Mend are adopted; never merges, never force-pushes                                          |
| Slack                     | An organization's own Slack app over Socket Mode; explicit Slack links; `@mend` starts or follows up a session; thread text and screenshots reach the session; sessions report to their Slack thread                                                           |
| Kubernetes                | Helm chart 0.3.0: an API tier and a stateless web tier, the capture store in an S3-compatible bucket, an opt-in Ingress to the web tier with TLS, a network session channel, and cluster workspaces via the Sealant chart                                      |
| Self-hosted server        | `mend server setup` runs the Mend application, Postgres and Garage containers on local Docker; status, logs, start, stop, restart, explicit `upgrade --version` with a private pre-migration database dump, and `mend uninstall`                               |
| Diagnostics               | `mend doctor` checklist; `mend doctor --bundle` writes one redacted archive for a bug report                                                                                                                                                                   |
| Desktop app               | Source in `apps/desktop`; build it from source. There is no published release                                                                                                                                                                                  |

Some implemented paths still need release-level acceptance tests. The operational guides state known
boundaries where that matters.

## Planned or incomplete

| Area                        | Status                                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context items and packs     | Planned; no public library or selection workflow                                                                                                                                                                                                                                                  |
| Immutable context snapshots | Schema exists, but session provisioning does not attach one                                                                                                                                                                                                                                       |
| Editable handoffs           | Planned                                                                                                                                                                                                                                                                                           |
| Multi tenancy               | `MEND_TENANCY=multi` refuses to start until every item of the multi mode gate passes; `mend operator gate` lists them                                                                                                                                                                             |
| Public exposure             | `MEND_EXPOSURE=public` starts only when every item the server can observe is closed. The gate's last items (Sealant, its registry and the database answering nothing from the Internet; the edge's certificate; an independent security reassessment of the release) are the operator's to verify |
| TLS edge                    | A Caddy overlay (`deploy/docker/compose.edge.yaml`) for a Compose project you run yourself; `mend server setup` does not install it, and no certificate has been issued through it end to end in testing                                                                                          |
| Published native mobile app | Source exists; no supported distribution path                                                                                                                                                                                                                                                     |
| Scoped device permissions   | Planned; current paired tokens have normal authenticated access                                                                                                                                                                                                                                   |
| VS Code extension           | Source in `apps/vscode`; not published to the marketplace                                                                                                                                                                                                                                         |
| `agent-protocol` processes  | The process kind is reserved; nothing launches one yet                                                                                                                                                                                                                                            |
| Automatic listener exposure | Not planned; Services remain explicit                                                                                                                                                                                                                                                             |
| Backup and restore          | `mend server upgrade` saves a private `pg_dumpall` dump before activating a target; restore is a manual operator procedure, and volume backups are yours to take                                                                                                                                  |
| Rollback                    | Downgrades are refused; once a target's migrations may have run there is no automatic rollback or database restore                                                                                                                                                                                |
| macOS and installed VS Code | Not verified; Linux checks are not evidence for Docker Desktop, OrbStack, or Remote-SSH acceptance                                                                                                                                                                                                |
| Automatic merge decisions   | Explicitly outside the product model; Mend never merges                                                                                                                                                                                                                                           |

## Canonical sources

- [`MEND-AGENT-WORKBENCH-PLAN.md`](https://github.com/sealant-sh/mend/blob/main/MEND-AGENT-WORKBENCH-PLAN.md)
  owns product direction and decisions.
- [`PLATFORM-FEEDBACK.md`](https://github.com/sealant-sh/mend/blob/main/PLATFORM-FEEDBACK.md) owns
  gaps between Mend and the public Sealant SDK.
- The implementation and its tests determine whether a current command or UI path exists.

A plan milestone is not release status. A platform feature marked implemented at its source is not
available to Mend until a released SDK is installed and Mend adopts it.
