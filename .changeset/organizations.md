---
"@sealant/mend": minor
---

Add organizations. Upgrading creates one organization that every existing account joins; the oldest
account becomes its owner and the instance operator, and every existing project stays visible to
everyone as a shared project. New projects are shared unless adopted as private, and project names
are unique within an organization. Registration now closes after the first account: owners mint
single-use invitation links instead, and an account that could not join an organization is
deactivated. `MEND_TENANCY` defaults to `single`; `multi` is refused at start until the isolation
work lands.
