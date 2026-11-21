---
"@sealant/mend": patch
---

A session whose agent ends while someone is removing its project now ends its workspace as usual.
Before, a project's automatic install that finished at that moment kept its workspace up for good,
and every later removal of the project was refused as `executor not ended`, from the web and from
`mend projects rm`, with no session left to stop. When a project removal is held only by a workspace
that is still saving or ending, the refusal now says to wait for it, not to stop a session.
