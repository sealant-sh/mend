---
"@sealant/mend": patch
---

On captured workspaces (AWS MicroVM executors), a pasted image now reaches the agent: Mend writes it
into the live workspace's harness home, at the same path the terminal pastes. Before, it landed on
the Mend server, where no captured workspace could read it. A session with no live workspace now
answers that it is not live instead of returning a path nothing can read. The owner's skills reach
captured workspaces the same way, before the harness starts.
