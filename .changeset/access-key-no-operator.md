---
"@sealant/mend": patch
---

An access key never acts as the operator, even when its account is the operator's. Every operator
route answers it `403 AccessKeyRefused` ("An access key cannot perform operator actions"), and the
machine's settings, host-path mounts and other operator-only endpoints answer it `404`, as they
answer anyone who is not the operator. Before, an operator's key could create and rename
organizations and grant ownership.
