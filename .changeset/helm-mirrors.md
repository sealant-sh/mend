---
"@sealant/mend": patch
---

The Helm chart runs the package and image mirrors as optional components: `mirrors.npm.enabled`
(nginx-unprivileged caching registry.npmjs.org, capped at `mirrors.npm.maxSize`) and
`mirrors.docker.enabled` (registry:3.1 caching Docker Hub under the packaged install's guard, capped
at `mirrors.docker.maxSize`, `mirrors.docker.ttl`). Both leave `mirrors.minFree` free on their
claims. An optional Docker Hub login comes from `mirrors.docker.upstreamCredentials.existingSecret`,
and only with `publicReadOnly: true`, the operator's statement that the token is scoped Public Repo
Read-only: every workspace can pull what it can read. Each mirror is one non-root replica on its own
claim behind a ClusterIP Service, admitted only from Sealant workspace Pods. The API tier gets
`MEND_NPM_MIRROR_URL`; NOTES.txt names the Sealant chart's `workspaces.docker.registryMirrors` value
that points workspace Docker daemons at the mirror.
