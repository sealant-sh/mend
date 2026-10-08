---
"@sealant/mend": patch
---

Behind `MEND_HARNESS_LAYOUT=person`, which is off by default, every client says the same thing about
people sharing a workspace. Starting a session in a worktree where someone else's session runs says
that everything you run runs as you, on your own logins, but either of you can read the other's
files, logins included. A session whose workspace has another person's process live in it says
"Shared workspace with Anna · each of you runs as yourself · either of you can read the other's
files." The Shared control switch says that each turn runs on its sender's login and that the agent
uses no one's personal memory or instructions from then on, and asks before it turns on. A turn that
waits for another person's agent says what it waits for. A workspace waiting to be replaced says so,
with what would stop, and its change's owner can replace it. The API's session list and session view
list the people live in each workspace. The docs cover the known issues, including that everyone in
a per-person workspace has sudo and can read the others' files.
