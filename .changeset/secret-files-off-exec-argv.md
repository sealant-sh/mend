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
- **Fewer execs.** Each delivery takes one exec, or fewer than before: a skills library that took a
  hundred execs takes one. Inside that exec there is one round trip from the workspace to Mend.
- **Node.** Secret files now need `node` on the image's `PATH`. Without it the session line says so.

Adding a repository to a session no longer puts a credential from an adopted HTTPS origin into the
clone's arguments or the log. That covers `https://user:token@host/…` and a token held as the user
name, such as `https://ghp_…@github.com/…`. The clone asks without it, as the workspace's remotes
already do. A private repository that only cloned because its origin held a token now fails to clone
in a session. Switch its origin to SSH (`git@github.com:owner/repo.git`), which goes through Mend's
git transport.

**Rotate exposed credentials.** What was sent before this release is still in Core's database until
Core purges it (see PLATFORM-FEEDBACK.md). Treat these as exposed and rotate them:

- every credential kept as a secret file;
- every key in a pi profile's `mcp.json`;
- every token embedded in an adopted origin that was added to a session with `mend repo add`.
