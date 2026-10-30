---
"@sealant/mend": patch
---

The links Mend hands to a person now carry their secret after a `#`: an invitation is
`/join#<token>`, a password reset `/reset#<token>`, and the Slack link button opens
`/slack/link#<code>`. A browser never sends what follows the `#`, so the secret no longer reaches an
edge's or a proxy's access log, Mend's request log, or a `Referer`. Settings and `mend org` show the
new links. Expiry and single use are unchanged.

Links issued before this version keep working until 0.39, which removes the old forms.
`/join/<token>`, `/reset/<token>` and `/slack/link/<code>` open the same page, which moves the
secret after the `#` before it fetches anything. An edge in front of Mend still sees such a link's
path once, when it is opened. These pages, in both forms, answer `Referrer-Policy: no-referrer` and
`Cache-Control: no-store`.

Two more places kept a secret in a URL:

- The web app's reads (tRPC queries) are now POSTs, so their input travels in the body. Before, the
  invitation preview put the token in `?input=`.
- Signing in from a Slack link returns through `/login#next=…` and `/welcome#next=…`. Before, the
  code rode `?next=`. A `?next=` that Mend's API sends, such as the preview sign-in, still works.

The edge that `mend server setup --edge` writes no longer logs the `X-Mend-Invitation` header, in
which a sign-up from an invitation carries its token. `mend server setup` and `mend server upgrade`
from this version rewrite the edge's files.

Better Auth's `GET /api/auth/reset-password/<token>`, which no Mend client sends, now answers 404
and stays out of Mend's request log and traces. `POST /api/auth/reset-password` is unchanged.

Roll out the web tier before the API, which issues the new invitation and reset links and posts the
new Slack links: a web tier older than this version opens a new link on a page that does not exist.
A `mend server` install runs both in one container, so `mend server upgrade` updates them together.
The Helm chart rolls its `web` and `api` Deployments out at once: a link issued during the rollout
opens once the web pods are replaced.
