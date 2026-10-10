---
"@sealant/mend": patch
---

A Claude session's terminal now says which plugins it is installing as soon as the install starts
(`mend: installing Claude plugins · pstack@pstack-claude …`), instead of staying blank for the few
seconds a new workspace takes to install them. The line that names what was installed still follows
before Claude starts. A launch whose plugins are all installed already prints only that last line.
