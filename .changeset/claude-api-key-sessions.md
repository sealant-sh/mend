---
"@sealant/mend": minor
---

A Claude session runs on your Claude API key when that key is your default Claude login. This works
where each person has their own home in the workspace. Claude Code reads the key from the file
Sealant writes into your home, through an `apiKeyHelper` in the settings Mend passes inline. The key
never goes into a command line, an environment variable or anything Mend records. This holds in a
terminal, in a conversation and in a shared conversation's home.

A session that starts its workspace on your key asks Sealant to put the key into your home once the
workspace exists, since Sealant never writes a Claude key at create. Where everyone's logins share
one home, a Claude session on a key is refused with words that say the login is a key and how to
choose a subscription instead. Before, Claude started signed out.

When pi or opencode cannot use your Codex login because it is an API key, the session line now names
that key.
