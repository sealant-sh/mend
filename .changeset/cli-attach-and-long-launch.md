---
"@sealant/mend": patch
---

`mend attach`, the dashboard's `a`, and every command that attaches put the terminal in raw mode
before they wait on the server. A slow server no longer leaves the terminal cooked, echoing every
key locally under `attached · …`: the attach says `connecting to <id> · 12s`, Ctrl+] or Ctrl+C gives
the terminal back, and after 30 seconds without an open terminal it says so and that the session
keeps running. On connect the size goes up twice, one row short and then the real one, so Claude and
other full-screen agents repaint at once instead of on the first key. When raw mode cannot be set,
the attach says why.

A long launch (a first launch building a workspace image for minutes) no longer ends in
`cannot reach the Mend server`. `mend claude`, `mend codex`, `mend run`, `mend resume` and
`mend rejoin` follow the session until its agent runs, showing the server's own words for what it is
doing (`starting · building the workspace image`), whether the server answers the launch early or
holds it, and whether that request times out or an edge cuts it. `cannot reach` is said only when no
connection opened. `mend attach` on a session still starting follows it, then attaches. The
dashboard keeps a launch whose request got no answer as a starting row.
