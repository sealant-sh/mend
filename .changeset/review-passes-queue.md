---
"@sealant/mend": patch
---

Review passes no longer wait behind each other or run twice. Up to three tours, reads and suggestion
passes run at once instead of one per kind. A request for a pass that is already queued or running
for the change is absorbed: review prep, the review page and a landing share one key per change,
which pg-boss's standard queues never enforced, and a tour whose diff has not changed since it was
composed is not composed again. A pass reads "queued" from the moment it is requested, so the change
page shows it waiting instead of "Composing…". Naming a session that settled without a first prompt
stops there and leaves it unnamed, instead of retrying for an hour.
