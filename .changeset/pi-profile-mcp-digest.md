---
"@sealant/mend": patch
---

A pi profile is no longer reinstalled on every new executor. The platform stopped saving the
profile's `mcp.json`, which can hold keys, but Mend still counted it when checking whether the
profile in place was the one delivered. Every new executor read the restored profile as changed,
moved it aside and reinstalled its extensions, and pi did not start when an install failed. The
check now leaves `mcp.json` out, and each delivery writes it again.
