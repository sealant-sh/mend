# Mend keeps its own copy of a person's GitHub login

Status: accepted 2026-11-19 (SLNT-1194). Amends [docs/SEALANT-IDENTITY.md](../SEALANT-IDENTITY.md),
item 4 ("Secrets pass through to Sealant and are never persisted or logged by Mend"), and the GitHub
row of [ADR 0003](0003-organizations-and-tenancy.md). Builds on [ADR 0010](0010-secret-files.md) and
[ADR 0014](0014-doppler.md) (a person's token sealed at rest with the machine's secrets key).

## Context

The First project step and Add project list a person's GitHub owners (their account and
organizations) and each owner's repositories, as that person. Until now Mend kept no copy of a
GitHub login: it passed the token to Sealant on `mend connect github` and, to list repositories,
started a short-lived workspace of the person's that carried the login and ran `gh` inside it. Every
first list, owner switch and search started a workspace. On his own server Yiannis asked: "There
must be a way to inject the gh login on the server directly instead of spinning up a whole
workspace?"

Sealant has no call that gives a credential back, by design, and its `github` group is about GitHub
App installations, not a person's login.

## Decision

When a person connects a GitHub login through Mend's API (`POST /me/sealant/accounts` with provider
`github`), Mend still forwards it to Sealant, for workspaces. Once Sealant has accepted it, Mend
also keeps one copy for that person:

- **Where:** `user_github_logins`, one row per person (`user_id` primary key), holding the Sealant
  connected account it came from, the GitHub login it names, and the token sealed with
  `SecretCipher` (AES-256-GCM, the machine's `secrets.key`), the same mechanism as Doppler tokens,
  secret files and MCP server secrets. A person who connects several GitHub logins has a copy of the
  last one they connected.
- **What uses it:** only that person's own requests to `github.status`, `github.owners` and
  `github.repos`. The server asks GitHub's REST API (`MEND_GITHUB_API_URL`, `https://api.github.com`
  by default) with `fetch`: `GET /user`, `/user/orgs` (every page), `/user/repos?affiliation=owner`
  or `/orgs/{org}/repos`, and `/search/repositories` with `user:` or `org:`. No workspace starts and
  no `gh` runs. The token is unsealed for the one request, held as `Redacted`, and sent only in the
  Authorization header to the configured API origin: a next-page link to anywhere else is refused,
  and redirects are not followed.
- **What never happens:** no part of the token is printed, logged, put in an error, returned to a
  client or shown. A failure becomes a sentence that names the call and what GitHub said (its
  `message` field only, with anything matching the token removed), or the rate limit and when it
  resets.
- **When it goes:** when the person disconnects that GitHub account (before Mend asks Sealant to),
  when their account is removed (the foreign key cascades), and when GitHub answers 401 for it. Then
  the person's open pages are told (the `accounts` event) and the list says to connect GitHub again.
- **A login connected before this:** Mend has no copy of it, so the list says "Connect GitHub again
  with mend connect github". There is no fallback to a workspace. With no connected login at all,
  the server's own `gh` still answers for the operator of a single-organization install, as before.

Pull request reads and `lookupProjectRepository` still run `gh` in a workspace of the person's.

## Considered options

- **A Sealant addition** that lets Mend's service principal use a person's credential, or proxies
  GitHub calls for it. Rejected for now: it needs a Sealant API change, a release and a version bump
  before Mend can use it, and it opens the "give the secret back" path Sealant was built without.
  Mend's copy is one change in one repository, on machinery Mend already trusts with the same kind
  of token.
- **Keep the workspace.** Rejected: a list waits for a workspace to start, and every owner switch
  and search starts another one.

## Consequences

- The server's `secrets.key` now also protects GitHub logins. Losing it makes every copy unreadable;
  the list then says to connect GitHub again.
- Two copies of the same login exist: Sealant's, for workspaces, and Mend's, for the list. They can
  drift: a login refused by GitHub is removed from Mend's copy only.
