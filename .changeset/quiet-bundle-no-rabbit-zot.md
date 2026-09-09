---
"@sealant/mend": minor
---

The self-hosted server bundle no longer ships RabbitMQ or a workspace-image registry. It pins
Sealant 0.29.0, which runs its job queue in Postgres and keeps workspace images in the host Docker
Engine, so the Mend container now supervises only Mend and the Sealant API, worker and SSH gateway.
Idle memory drops accordingly. The bundle asset contract moves to v2 (`compose.v2.yaml`,
`setup-contract.v2.json`): no registry port is published, `--registry-port` is gone from
`mend server setup`, and setup, start, restart and upgrade no longer run the loopback registry
round-trip. Existing v1 installations upgrade in place with
`mend server upgrade --version <target>`; their volume-ownership identity is carried over unchanged.

The Mend API server and web front now run from esbuild bundles inside the images (no `node_modules`,
no type stripping at start), which also drops code the server never calls, such as the OpenAPI
viewers Effect re-exports.
