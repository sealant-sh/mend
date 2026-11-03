---
"@sealant/mend": minor
---

A session's screen now runs for as long as the session does. In a project whose Environment has a
screen, it starts beside the agent on every launch, so the display is up before the agent's first
look. It no longer stops after 15 idle minutes, and it stops with the session and starts again when
the session resumes or Mend restarts. The screen starts no browser: the agent opens Chromium when it
needs one. A screen that fails to start leaves the agent running, and the session's Screen tab
offers Retry.
