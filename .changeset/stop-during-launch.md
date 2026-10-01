---
"@sealant/mend": patch
---

A stop sent while a session is still starting now ends it. Before, a stop that arrived before the
agent's process existed found nothing to end, and the launch went on to start the agent: the session
read `running` with no machine behind it once the stop's drain ended the executor. A launch now
stands down just before it starts the agent when a stop came first, and one that started the agent
anyway is stopped again as it finishes.
