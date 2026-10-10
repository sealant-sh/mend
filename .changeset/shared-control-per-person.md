---
"@sealant/mend": minor
---

In a per-person workspace, the default, shared control runs each turn on its sender's own login. A
shared Claude or Codex conversation lives in a directory of its own in its owner's saved files, and
each agent process of it runs in that one conversation home as the person whose turn it runs.
Neither person's memory, instructions, settings or MCP servers reach the conversation, and scheduled
prompts are off in it; its transcripts, tool outputs, sub-agents and task list stay with the session
whoever sends the next turn. A resume continues the conversation's own file and never starts a new
one in its place: if the file is missing, the turn fails and says so. A terminal session with shared
control on runs as before: only its owner types there.

When Bob sends a turn to Alice's conversation, Mend waits until Alice's agent has finished its own
work (a running turn, background tasks, sub-agents, a goal, a background terminal, a monitor, a
wakeup), stops nothing, and then continues the same conversation in a process of Bob's, on Bob's
login, with the turn and any turn sent meanwhile; Bob is recorded as the turn's payer. While the
turn waits, both people can read why; the person whose agent runs the work, or the session's owner,
can end a task, a monitor, a terminal or a goal; a scheduled prompt is waited for at most 10 minutes
and then ends with Alice's agent, which the session line says. Alice's agent is never stopped on a
guess: if Codex will not say what it runs, Bob's turn fails after a minute and Alice's agent goes
on. Right before the stop Mend looks once more: if Alice's agent started something of its own, or
Bob withdrew the turn, nothing is stopped. If Bob's process cannot be started after Alice's stopped,
Alice's is started again on Alice's login, Bob's turn fails with the reason, and the next try waits
a minute. If Bob's logins cannot be written, Mend tries once more, then refuses the turn with the
reason; it never runs on another person's agent or login. Only the person an agent runs as answers
its questions; anyone else is asked to send a turn instead. A steerer who has not connected the
harness's provider is told to connect it before anything is sent, follow-ups and launches that open
with their words included. Taking a shared conversation over into a terminal continues it in the
same place. In a worktree that runs per person, only the person who made the worktree keeps Claude's
scheduled prompts. The Shared control switch asks before it turns on, in words true to the session's
workspace: in one that shares one home, each turn runs on the owner's logins and Git access, whoever
sends it.

Four rules hold in either layout: shared control cannot be turned on for an opencode session, which
is one person's, and another person's turn to one is refused; turning shared control off cancels the
turns other people queued instead of sending them; removing a person from the organization cancels
the turns they queued; and a queued turn is withdrawn only by the person who sent it or the
session's owner.
