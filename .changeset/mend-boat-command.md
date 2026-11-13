---
"@sealant/mend": minor
---

`mend boat` manages the organization's Boat key from the CLI. `mend boat status` says whether the
organization has its own key, and owners also see who connected it and when. `mend boat connect`
connects or replaces it, reading the key from a hidden prompt or standard input and never from the
command line. `mend boat check` asks Sealant what it holds and says when that was observed, and
`mend boat disconnect` sends new Boat sessions back to the server's key. Each takes `--json`.
