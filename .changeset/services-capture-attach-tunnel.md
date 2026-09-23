---
"@sealant/mend": minor
---

Session Services work in capture-mode (MicroVM) sessions, where Mend is not beside the worktree.
`mend.toml` recipes are read from the session's live workspace, so `mend service run <name>`, the
web's recipe list, and the agent's own `mend service run <name>` find them there; a session with no
live workspace says so instead of answering 500. The agent's Mend Services instructions are written
into capture-mode workspaces too, and the in-workspace `mend service run` and `mend service add`
take `--http`/`--https`, so a Service the agent starts gets a browser URL.

`mend attach`, `mend codex|claude|opencode`, and `mend rejoin`, attached to a session on a server
that is not this machine, tunnel that session's live Services declared `--http` or `--https` to this
machine's loopback: on the Service's own port when it is free, else on a free one, one line each
(`web → http://localhost:5173`). A Service that stops closes its tunnel, detaching closes them all,
and the Services keep running. The dashboard does the same for the selected session and shows where
each opens in the session pane. `--no-tunnel` opts out; `mend service connect` is unchanged.

The web's and the desktop's Services show `mend service connect <name>` in place of a dead Open link
when a Service answers only on a remote Mend host's loopback.
