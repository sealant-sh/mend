---
"@sealant/mend": patch
---

When a session's agent cannot continue in the other mode (a terminal or a conversation), Mend now
says "This session's agent cannot switch to that mode." in the terminal, on the phone, in VS Code
and on the web. The web previously said the session could not continue in that harness, which
described a different action. The request and its refusal are unchanged on the wire, so earlier
`mend` releases keep working against this server.
