---
"@sealant/mend": minor
---

Runs on Sealant 0.34.0, which bakes sealantd 0.17.0 (sealant-sh/sealantd#86): the workspace daemon
dials the session channel and every presigned object URL over HTTPS with a verified certificate, and
refuses to boot otherwise, unless the launch states that the network between executor and channel is
private. Mend now sends that statement with every capture launch as `source.transport`, built from
`MEND_EXECUTOR_NETWORK=private`, and hands the daemon the roots of a private CA from
`MEND_SESSION_ENDPOINT_CA_FILE` (the channel) and `MEND_BLOB_STORE_CA_FILE` (the bucket). The
packaged bundle states `private` itself, since its Compose network never leaves the host. The Helm
chart refuses to render a plain-http session channel without `exposure.executorNetwork: private` or
`sessionChannel.tls.enabled`, and takes the channel's CA through `sessionChannel.tls.ca`.

Upgrade note for the chart: set one of those two values before `helm upgrade`, and roll this Mend
before or with Sealant 0.34; a Mend older than this release does not send the statement, and its
workspaces would refuse to boot under the new daemon.

`@sealant/sdk` and `@sealant/api-contracts` move to 0.34.0, and the bundled server image pins the
0.34.0 API, worker and ssh-gateway digests.
