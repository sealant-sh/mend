---
"@sealant/mend": patch
---

Mend runs on Effect 4.0.5, Effect's first stable release line, up from the 4.0.0-beta.93 prerelease,
and bundles Sealant 0.39.0-next.751, the first Core built on it. One change reaches a client: a
request body that does not declare its length and grows past the body budget now ends the connection
at the budget, where it was answered `413`. A declared length over the budget is still answered
`413` before anything is read.
