---
"@sealant/mend": patch
---

Reject workspace Git tunnel requests containing extra commands, shell expansions, redirects, options
or multiple repository arguments before looking up the account's signer. Standard Git quoting,
including paths with spaces, apostrophes and exclamation marks, continues to work. The tunnel
accepts literal unquoted paths or Git's single-quoted form; control characters and double-quoted or
otherwise escaped paths are refused.

After sign-in or registration, reject `next` paths whose backslashes or embedded tabs/newlines would
make the browser navigate to another host. Valid local paths, queries and fragments are preserved.
