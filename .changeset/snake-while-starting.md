---
"@sealant/mend": patch
---

The dashboard says what a `starting` session is doing, and gives you snake for the wait. A first
session on a new project setup builds its image before it boots, about seven minutes on some
families, and the detail pane used to read "no conversation recorded yet" the whole time. It now
says the image builds, then the session boots, and how long a first build takes, and the arrows
steer a snake on the pane below while the detail pane is focused (`h j k l` and tab still move the
dashboard). The game stops the moment the session reads `running`.
