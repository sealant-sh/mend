---
"@sealant/mend": minor
---

A session that holds a conversation you imported, and has not started its agent yet, now reads
"waiting for a first message" instead of "starting": in the web app's inbox, on the project page, in
the session's own header, in `mend sessions` and in the dashboard. Its composer in the web app sends
that first message: the agent starts in conversation mode on the imported conversation, with your
message as its first turn. If the session was started somewhere else first, the composer shows the
server's reason and keeps your words.
