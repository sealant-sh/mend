---
"@sealant/mend": patch
---

A session that joined a worktree where someone else's session was live no longer writes its owner's
secret files into that person's workspace when it resumes or takes a follow-up there. Before, such a
run counted the other person's workspace as its own: its owner's files landed where the other
person's agent could read them, replaced that person's own file at the same path (for example
`~/.aws/credentials`), and that person's other secret files were removed as no longer kept. Mend now
decides from whose launch made the workspace, writes nothing when it cannot say, and the session
line names the files not written:
`secret files · 1 not written · this workspace is another person's · ~/.aws/credentials`.
