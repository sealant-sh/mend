---
"@sealant/mend": minor
---

The repository list asks GitHub's API itself, with no workspace. When someone connects GitHub with
`mend connect github`, Mend now keeps its own copy of that login, sealed with the server's secrets
key, beside the one it gives Sealant. `GET /api/github/status` answers from it, and
`GET /api/github/owners` and `GET /api/github/repos` call `https://api.github.com` as that person:
their account, every organization they belong to, and one owner's repositories, most recently pushed
first, or a search within that owner. No workspace starts for a list, an owner switch or a search.

Mend uses the copy only for that person's own list and never prints, logs or returns any part of it.
It removes the copy when the person disconnects GitHub, when their account is removed, and when
GitHub refuses it. A GitHub login connected before this version has no copy: the list says to
connect GitHub again with `mend connect github`, and `GET /api/github/status` answers
`connectAgain: true`. GitHub's rate limit and refusals come back as sentences that name the call.
`MEND_GITHUB_API_URL` points Mend at GitHub Enterprise Server's API. With no connected login, the
server's own `gh` still answers for the operator of a single-organization server.
