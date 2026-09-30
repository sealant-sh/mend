---
"@sealant/mend": patch
---

An agent on a new machine no longer shows a blank screen while it starts. Until its first output,
`mend attach`, the dashboard's `a`, and the web and desktop terminals say
`claude is starting on the new machine · 23s`. The line is erased the moment the agent draws, and
the agent's screen is not touched. A reattach to an agent that has already drawn shows its screen at
once and never shows the line. The session line reads `claude is starting on the new machine` until
the agent's record carries output. Each agent process now records when that happened
(`firstOutputAt` on the session's processes, null until then; migration 0095).

A launch now also reads the harness's files on the new machine in the background while the rest of
its setup runs: the binary, its interpreter, and `claude --version` (or `codex`, `opencode`). The
real start then finds them already read from the machine's lazily fetched disk. The warm-up runs
from `/` with a throwaway HOME and removes it afterwards, so it writes nothing to the worktree or
the harness home. It is abandoned after 60 seconds, and nothing it does can delay or fail the
launch. A capture-mode standby is warmed when it is claimed, never before.
