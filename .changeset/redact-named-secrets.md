---
"@sealant/mend": patch
---

Error messages from the server hide more of the credentials an upstream error can echo. A password,
token, secret, passphrase, private key, API or access key, or credentials value is now removed
however it is written: with a prefix on its name (`DB_PASSWORD=…`, `client_secret=…`), after `: ` or
`=`, as a JSON or Python field (`"password": "…"`), or in quotes. An `Authorization` header's value
goes in any case, GitHub's `token` scheme included. Its name stays, so the message still says what
was refused, and ordinary text such as `exit code: 128` is left as it was.
