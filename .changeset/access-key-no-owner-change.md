---
"@sealant/mend": patch
---

An access key never changes who owns an organization. An owner's key that tries to make a member an
owner, change an owner's role or remove an owner gets `403 AccessKeyRefused` ("An access key cannot
change who owns this organization"), and nothing changes. Before, an owner's key could promote a
member to owner, and the promotion stayed after the key was revoked. Signed in, an owner still makes
these changes, and a key can still remove a member.
