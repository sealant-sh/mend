---
"@sealant/mend": patch
---

Find in a T3 Code thread no longer risks taking the gateway down on a message nested thousands of
levels deep, such as a pasted run of `>` quotes. A message whose lines nest more than 100 quotes or
list markers is searched as written instead of being parsed.
