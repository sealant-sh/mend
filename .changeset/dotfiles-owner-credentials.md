---
"@sealant/mend": patch
---

The server's clone of a dotfiles repository, at launch and when it is saved, now runs as the account
whose dotfiles they are, never with the server's own Git and SSH setup. An SSH URL signs with that
account's Git access: its Mend key, or its connected signer when its Git access is the bridge. An
HTTPS URL clones without a credential, so only a public repository clones that way; a refused HTTPS
clone says so and points to the SSH URL. These clones read none of the server's credential helpers,
`.netrc`, SSH agent, SSH config or key files. On a single-tenant install (`MEND_TENANCY=single`) the
operator's own dotfiles still clone with the server's setup, as before.
