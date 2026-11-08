---
"@sealant/mend": minor
---

An API key for Claude or Codex can send its requests to a compatible endpoint, such as a company
gateway: `mend connect claude --api-key --endpoint <url>`, or **Endpoint (optional)** in the API key
form in Settings. Claude needs an Anthropic-compatible endpoint and Codex an OpenAI-compatible one.
If the endpoint takes no key, any value is accepted as the key. Every session on the login sends its
requests there and nowhere else: Claude Code gets the endpoint in the settings Mend already passes
it, and Codex gets a model provider of Mend's own on its command line, never in a file the worktree
keeps. The person who added the key sees its host after it
(`Claude · API key ····a1b2 · billed per token · endpoint gateway.example.com`) in Settings,
`mend accounts` and `mend doctor`; everyone else sees the login without it, and `--json` carries
only the host. When a turn cannot connect to the endpoint, the conversation says what Mend observed
and where from:
`Could not reach gateway.example.com from this session's workspace (connection refused) · observed 21:40`.
A Sealant that cannot keep an endpoint yet says so and saves nothing.
