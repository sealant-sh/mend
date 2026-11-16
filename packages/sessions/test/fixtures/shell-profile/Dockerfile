# Test-only shell: no optional prompt programs or plugins, and no runtime package downloads.
# The base by digest from Docker's official-image mirror on ECR Public: Docker Hub limits anonymous
# pulls per runner address. CI pulls it through scripts/ci-images.mjs (its GHCR copy, then the
# public mirrors, with retries) and passes the local tag as BASE (SLNT-1071).
ARG BASE=public.ecr.aws/docker/library/alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
FROM ${BASE}
RUN apk add --no-cache zsh
LABEL sh.sealant.mend.test="shell-profile"
