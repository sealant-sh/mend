---
"@sealant/mend": patch
---

When Run on a Service stops because a `[setup]` step did not finish, the server now answers with a
refusal of its own, `ServiceSetupFailed`. The status (422) and the words are the same as before. The
answer also carries the step, how it ended (its exit code, or that it ran past the step limit) and
the end of its output as data. `mend service run` prints the same reason as before.
