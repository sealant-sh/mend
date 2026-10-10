---
"@sealant/mend": patch
---

Secret files, the pi profile, and every other file Mend places in a captured workspace (agent
memory, skills, carried Codex conversations, pasted images) no longer pass through the platform's
exec arguments. Sealant Core before 0.39 stored those arguments in plaintext and never deleted them;
the Sealant this release runs records only the program and how many arguments it had.

- **The pickup ticket.** A launch puts a single-use pickup ticket in the exec instead of the bytes.
  The ticket is bound to the session, its owner and the executor's launch. It dies when its exec
  ends, with a ten-minute backstop. The same exec redeems it over the session channel and writes the
  bytes straight into place. Secret files and the pi profile's `mcp.json` are written 0600, and
  never through a link.
- **Node.** Secret files now need `node` on the image's `PATH`. Without it the session line says so.

A credential in an adopted origin no longer reaches a workspace: not its `origin` remote, the
`mend repo add` clone, or what `mend repo projects` lists.

**Rotate exposed credentials.** The upgrade's Sealant migration purges what Core stored, but a copy
made before it, such as a database backup or a replica, still holds it. Treat these as exposed and
rotate them:

- every credential kept as a secret file;
- every key in a pi profile's `mcp.json`;
- any secret written into agent memory (memory imported from people's machines often holds
  hostnames, account IDs and tokens);
- every token embedded in an adopted origin that was added to a session with `mend repo add`.
