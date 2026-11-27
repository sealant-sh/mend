---
"@sealant/mend": patch
---

The bundled sealant is 0.40.0-next.952. A Boat session no longer fails after two minutes of
`starting · booting` while Boat is still copying a large or newly built workspace image onto its VM:
the launch keeps waiting while that copy is moving, up to 6 minutes. A start that still stops says
why in words, with how far Boat had got and that starting again is safe.
