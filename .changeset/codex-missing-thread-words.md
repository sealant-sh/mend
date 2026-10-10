---
"@sealant/mend": patch
---

A resumed Codex conversation whose thread Codex cannot find (`no rollout found for thread id …`)
fails the turn with "Codex could not find this conversation's thread. Nothing was sent." Before,
Mend quietly started a new, empty thread under the same session, so the next turn went to a
conversation with no history. A resume that fails for another reason, such as an unknown model,
shows Codex's own message.
