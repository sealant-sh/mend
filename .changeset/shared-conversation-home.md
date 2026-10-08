---
"@sealant/mend": patch
---

Behind `MEND_HARNESS_LAYOUT=person`, which is off by default, a Claude or Codex conversation that
shared control is turned on for now lives in a directory of its own in its owner's saved files, and
each agent process of it runs in one fixed conversation home as the person whose turn it runs, on
that person's own login. Neither person's memory, instructions, settings or MCP servers reach the
conversation, and scheduled prompts are off in it; the conversation's transcripts, tool outputs,
sub-agents and task list stay with the session whoever sends the next turn. A resume continues the
conversation's own file and never starts a new one in its place: if the file is missing, the turn
fails and says so. A terminal session with shared control on runs as before. With the flag off,
sessions run exactly as before.
