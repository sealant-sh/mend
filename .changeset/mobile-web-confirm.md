---
"@sealant/mend": patch
---

The phone app in a browser asks before it acts. `Stop session`, `Replace this workspace now`, the
shell's `Stop` and `Attach an image` did nothing there: they asked through the native alert, which
React Native Web never shows. On the web build they ask in the app's own dialog, with the same words
and buttons, and so do the app's notices (`No image on the clipboard`). Cancel sends nothing. The
native apps keep their alerts.
