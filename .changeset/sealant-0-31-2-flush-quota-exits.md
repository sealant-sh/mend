---
"@sealant/mend": patch
---

The bundle pins Sealant platform 0.31.2 by digest and the SDK moves to 0.31.2; the workspace image
carries sealantd 0.15.2. A capture-mode session's flush survives load: the daemon's orphan reaper
was reaping the capture engine's own `git` children, so `capture.flush` was refused with
`No child process` for 4% of flushes on a quiet machine and a third of them under an orphan storm —
the failure that took down Mend's own v0.27.3 packaged acceptance on amd64. A capture the control
plane refuses on the byte quota is now terminal: the shipper acks the 413 and stages over it, where
it used to re-attempt the same register every five seconds for the life of the session. On
Kubernetes a workspace pod's exit is observed from the runtime, so a dead executor is seen in
seconds instead of reading `ready`, and `stop` on a pod that is already gone returns at once — the
cluster proof spent most of its 122 s to declare an executor lost inside that wait. MicroVM launch
material is published whole.
