---
"@sealant/mend": patch
---

The bundle runs Sealant 0.39 (0.35.1 ran 0.38.1): its API, worker and SSH gateway images, pinned by
digest. Its workspaces run sealantd 0.20.

- Every workspace image carries pi beside Claude Code, Codex and opencode, at fixed versions (Claude
  Code 2.1.292, Codex 0.160.1, opencode 1.18.34 and pi 1.0.4), so rebuilding an image no longer
  changes which version a session runs.
- Sessions start faster: Mend sees each command it runs in a workspace end within about 25 ms, where
  it could wait a few hundred, and a launch runs about twenty of them. A workspace's readiness is
  read back sooner too.
- Sealant no longer stores the arguments a process or terminal was started with, since they can
  carry secrets: a run's record shows the program and how many arguments it had. Upgrading runs a
  one-time purge of the arguments already stored, before Sealant starts. On a database the size of a
  small team's server it takes 15 to 45 seconds.
- A command's arguments may be any string: empty, starting with whitespace or spanning lines. Only
  the program must be trimmed. A request Sealant refuses says why without quoting what was sent. A
  registry URL's user and password are sent as Basic auth and never printed, and what Sealant's API
  observes is redacted unless it is known to be safe.
- Workspaces send each upload's SHA-256, pack indexes included, so a Stop on Garage can seal without
  waiting for its upload links to expire. No harness login is captured with the harness home, so the
  next session in the worktree never inherits one. A final save and a restore use every core, and
  the `socat` relay comes over HTTPS, checked against a pinned checksum.
- A Stop is recorded once the executor has ended, before its remains are removed, and a run's
  changes are read from a refreshed copy of the index. A run no longer fails when the same telemetry
  event reaches its record twice.
- A workspace's SSH sessions, VS Code Remote-SSH included, can run as its owner's own Linux user,
  the person their Sealant user is bound to. SFTP runs as that user too. The Fedora and Ubuntu
  images carry an `sftp-server`, with every sshd unit masked.
