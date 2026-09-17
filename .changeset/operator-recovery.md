---
"@sealant/mend": minor
---

Recovery without email. Owners hand a member a one-time password reset link from Settings; the
operator lists organizations, renames them, invites or grants an owner, and issues reset links from
`mend operator`. A reset link works once for a day, and setting a password with it signs the account
out everywhere. Every operator act is recorded in the affected organization's audit log.
