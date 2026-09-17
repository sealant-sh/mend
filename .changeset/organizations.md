---
"@sealant/mend": minor
---

Add organizations. Upgrading creates one organization that every existing account joins; the oldest
account becomes its owner and the instance operator, and every existing project stays visible to
everyone as a shared project. New projects are private to their creator unless adopted as shared,
and project names are unique within an organization. Registration now closes after the first
account: owners mint single-use invitation links instead. `MEND_TENANCY` defaults to `single`;
`multi` is refused at start until the isolation work lands.
