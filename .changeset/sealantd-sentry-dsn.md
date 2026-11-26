---
"@sealant/mend": patch
---

`mend server setup --sealantd-sentry-dsn <dsn>` sends the errors and traces of the sealantd in each
session's workspace to a Sentry project of its own, beside `--sentry-dsn` and
`--sealant-sentry-dsn`. Off unless set, kept across reruns and upgrades, and `default` turns it off;
`mend server status` says where it goes. Workspaces started after Mend restarts get it, and each
workspace's trace now continues from Mend through sealant into its sealantd.

The bundled sealant is 0.40.0-next.951, with sealantd 0.21.0-next.217. A workspace's build, launch
and boot are now one trace under its create, its spans are described in plain words, and setup's
host-vm self-test uses sealantd 0.21.0-next.217's vm-runner. Mend's calls into sealant keep their
own operation in Sentry (`mend.sealant`), not the one the new SDK names its own span with.
