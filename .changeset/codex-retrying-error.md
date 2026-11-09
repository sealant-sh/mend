---
"@sealant/mend": patch
---

A Codex conversation keeps going when Codex reports an error inside a turn. Before, the first
reconnect Codex announced ended the conversation and cancelled its turns, and a turn that could not
connect at all read "The turn was withdrawn". Now a reconnect is a warning, and a turn that fails
reads as failed, in Codex's own words. An error outside any turn still ends the conversation, now
with Codex's words instead of "Codex app-server reported an error."
