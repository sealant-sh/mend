---
"@sealant/mend": minor
---

Connect an Anthropic or OpenAI API key for Claude or Codex, beside a subscription or instead of one.
`mend connect claude --api-key` and `mend connect codex --api-key` read the key from stdin only and
never print it; `--default` makes it the login your sessions spend, and `--api-key --remove`
disconnects it. Settings → Connected accounts takes one as **API key**, and offers to make it your
default when you already have a login. One login per provider is the default, and Mend never moves
your sessions to the other on its own. Wherever a key is involved, Mend names it by its last four
characters: `Claude · API key ····a1b2 · billed per token` in Settings, `mend accounts`,
`mend doctor` and T3 Code. A key is billed per token with no plan limit, so the forms recommend a
spend limit on the Anthropic Console workspace or OpenAI project. Disconnecting a key does not
revoke it: it stays valid at the provider until you revoke it there. When you disconnect your
default login and one other login for that provider is left, that one becomes your default, so your
sessions keep starting. A Sealant that cannot run sessions on a key yet says so and saves nothing.
