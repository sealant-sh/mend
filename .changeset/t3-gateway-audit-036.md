---
"@sealant/mend": minor
---

The t3code gateway now keeps your read state, so a thread that finished while you were away shows as
done in t3code, and Mark unread works. It is yours alone, kept by the gateway across its restarts,
and every device you pair sees the same. A paired t3code client is granted only what the gateway can
do: settings, provider setup, diagnostics, the in-app browser, git writes, file edits and T3 Connect
now show inert in t3code instead of looking live and then failing, and a Files-tab edit is no longer
silently lost. Pairings made before are narrowed on their next request. A reasoning effort changed
on a started thread applies from the agent's next start, and the thread says so; a changed service
tier is refused rather than ignored. The scheduled tasks page and the device panel load instead of
waiting forever, and the device setup wizard no longer opens. The docs list everything t3code offers
that Mend refuses.
