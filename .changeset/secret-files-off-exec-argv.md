---
"@sealant/mend": patch
---

Secret files, the pi profile, and every other file Mend places in a captured workspace (agent
memory, skills, carried Codex conversations, pasted images) no longer pass through the platform's
exec arguments. Sealant Core stores those arguments in plaintext and never deletes them.

- **The pickup ticket.** A launch puts a single-use pickup ticket in the exec instead of the bytes.
  The ticket is bound to the session, its owner and the executor's launch. It dies when its exec
  ends, with a ten-minute backstop. The same exec redeems it over the session channel and writes the
  bytes straight into place. Secret files and the pi profile's `mcp.json` are written 0600, and
  never through a link.
- **Fewer execs.** Each delivery is a single exec, where a large file or a skills library used to
  take several (a skills library took a hundred). Inside that exec there is one round trip from the
  workspace to Mend.
- **Node.** Secret files now need `node` on the image's `PATH`. Without it the session line says so.

A credential in an adopted HTTPS origin no longer reaches a workspace. That covers
`https://user:token@host/…` and a token held as the user name, such as `https://ghp_…@github.com/…`.
It applies everywhere Mend hands the origin to a workspace:

- the workspace's own `origin` remote, which before kept a user name and dropped only a password;
- the clone `mend repo add` makes, and its log line;
- what `mend repo projects` lists.

An SSH user name such as `git@` is kept. A private repository that only cloned or fetched because
its origin held a token will now fail to clone or fetch from inside a session. Switch its origin to
SSH (`git@github.com:owner/repo.git`), which goes through Mend's git transport.

**Rotate exposed credentials.** What was sent before this release is still in Core's database until
Core purges it (see PLATFORM-FEEDBACK.md). Treat these as exposed and rotate them:

- every credential kept as a secret file;
- every key in a pi profile's `mcp.json`;
- any secret written into agent memory (memory imported from people's machines often holds
  hostnames, account IDs and tokens);
- every token embedded in an adopted origin that was added to a session with `mend repo add`.
