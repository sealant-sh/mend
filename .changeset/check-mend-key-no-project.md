---
"@sealant/mend": patch
---

The server can check whether GitHub accepts your Mend key before you have a project:
`POST /api/keys/git/check` asks GitHub's SSH greeting with the key and answers `accepted` (with your
GitHub login, or the repository for a deploy key), `refused`, `unreachable` or `no-key`. It never
creates a key, and it checks the Mend key whichever Git access mode you use.
