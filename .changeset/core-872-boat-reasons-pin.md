---
"@sealant/mend": patch
---

Update the bundled Sealant Core SDK and images to 0.40.0-next.872.

- **A Boat launch Boat refuses ends sooner.** When Boat refuses to start a session's VM for a reason
  no retry can change (the Boat key, its permissions, the account, billing, a plan limit), Core no
  longer retries the create for two minutes first. Rate limits, a busy Boat and no answer are still
  retried.
- **Image builds keep Boat's reason.** An image build Boat refuses now ends with Boat's reason
  instead of a generic one, and is rebuilt on a later launch only when a later try can pass.
- **A Boat key without every permission Mend needs is refused when it is connected.** Mend says
  which permissions are missing and points to the command on the Boat page that creates a key with
  all of them. Nothing is stored.
- **Whitespace around a pasted Boat key is trimmed by Sealant too.**
