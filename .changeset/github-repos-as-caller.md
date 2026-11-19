---
"@sealant/mend": minor
---

Mend lists a person's GitHub repositories with their own GitHub login. Once someone has run
`mend connect github`, `GET /api/github/status` answers with that login, and `GET /api/github/repos`
runs `gh` in a short-lived workspace of theirs that carries it, the way pull request reads already
do. Mend never reads the token. Someone with no connected GitHub login keeps today's answer: the
server's own `gh` for the operator of a single-organization server, and nothing for anyone else. The
old project pull request list still reads only the server's `gh`.
