---
"@sealant/mend": patch
---

A session launches once at a time. A resume keeps the session's row settled until its agent runs, so
a second resume sent meanwhile (a phone still offering Resume) drained the first one's new machine
and started another; on alpha three taps started three machines and the session ended `failed`. The
second resume, launch, handoff or follow-up is now refused with
`starting · a launch of this session is already under way · nothing new started`, and the session
reads `starting` everywhere while its launch is under way.
