---
"@sealant/mend": patch
---

The Helm chart runs the package and image mirrors as optional components: `mirrors.npm.enabled`
(nginx-unprivileged caching registry.npmjs.org, capped at `mirrors.npm.maxSize`) and
`mirrors.docker.enabled` (registry:3.1 caching Docker Hub, `mirrors.docker.ttl`, an optional Docker
Hub login from `mirrors.docker.upstreamCredentials.existingSecret`). Each is one non-root replica on
its own claim behind a ClusterIP Service, admitted only from the API tier and workspace Pods. The
API tier gets `MEND_NPM_MIRROR_URL`; NOTES.txt names the Sealant chart's
`workspaces.docker.registryMirrors` value that points workspace Docker daemons at the mirror.
