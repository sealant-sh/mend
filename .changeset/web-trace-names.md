---
"@sealant/mend": patch
---

When the web app reports to Sentry, its traces read more clearly. Every request to Mend's server is
named `POST /trpc/:procedures`, however many calls it carries, with one span per call under it
(`trpc sessions.inbox_row`). Clicks and layout shifts are named for the part of the page they
happened in (`SessionRow`, `Composer`), never a list of style classes, and no button's label is
sent. Pages under an address no page owns read `/settings/*` or `/*`. A poll, a refetch or a click
after a page has loaded now starts a short trace of its own, so a tab left open no longer grows one
trace for as long as it stays open.
