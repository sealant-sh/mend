---
"@sealant/mend": patch
---

`mend server upgrade` reads a generation an older CLI wrote. 0.36.0-next.780 called a
0.36.0-next.773 install with the t3code gateway on corrupt ("server.env does not match the persisted
server config and identity"), because 780 renders three gateway lines 773 did not write.
`server.env` is now read line by line: a line added since the generation was written is missing from
it and comes in at what the config says when the upgrade renders the next generation, with the
secrets unchanged. A line no render of the config carries, a value other than the one the config and
identity give (a secret that is not the identity's, a changed address), and a missing line every
`server.env` has carried still refuse, and say which line. The packaged acceptance now ends with an
install written by the previous release's CLI from npm, which this CLI upgrades.
