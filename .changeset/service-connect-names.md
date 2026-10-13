---
"@sealant/mend": patch
---

Keep the first requested name in `mend service connect` when `--port` is absent. Explicit names now
open only matching TCP service tunnels; omitting names continues to connect every live TCP service.
