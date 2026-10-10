---
"@sealant/mend": patch
---

Files Mend places in a captured workspace (secret files, the pi profile, agent memory, skills,
carried Codex conversations, pasted images) no longer pass through the platform's exec arguments,
which Sealant Core before 0.39 stored in plaintext.

- **The pickup ticket.** A launch puts a single-use pickup ticket in the exec instead of the bytes.
  The ticket is bound to the session, its owner and the executor's launch. It dies when its exec
  ends, with a ten-minute backstop. The same exec redeems it over the session channel and writes the
  bytes straight into place. Secret files and the pi profile's `mcp.json` are written 0600, and
  never through a link.
- **Node.** Secret files need `node` on the image's `PATH`. Without it the session line says so.

A credential in an adopted origin no longer reaches a workspace: not its `origin` remote, the
`mend repo add` clone, or what `mend repo projects` lists.

**If you ran a 0.36 prerelease.** Secret files, pi profiles, agent memory and `mend repo add` are
new in 0.36, and prereleases before this fix sent them as exec arguments, which Sealant stored. The
Sealant this release bundles purges stored arguments when it upgrades; a database backup taken
before then still holds them. If you used such a prerelease, rotate every credential kept as a
secret file, every key in a pi profile's `mcp.json`, any secret written into agent memory, and every
token in an origin added to a session with `mend repo add`. Upgrading from 0.35.1 needs none of
this.
