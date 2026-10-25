---
"@sealant/mend": minor
---

Project secrets refuse the names of provider logins, in any case: `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` for Claude, `OPENAI_API_KEY` and
`CODEX_API_KEY` for Codex. A new secret, a rename to one of these names and a `.env` entry are
refused with words that point to Settings → Connected accounts, and `mend env load` and the web
app's Add variables load the rest of the file. A secret stored under one of these names before is
kept and still reaches sessions as it did. Its row in the web app and in `mend env show` asks you to
rename or remove it, and it cannot take a new value.
