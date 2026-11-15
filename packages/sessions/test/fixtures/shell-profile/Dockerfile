# Test-only shell: no optional prompt programs or plugins, and no runtime package downloads.
# Docker's official-image mirror on ECR Public, by digest: Docker Hub limits anonymous pulls per
# runner address, and CI has no login.
FROM public.ecr.aws/docker/library/alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache zsh
LABEL sh.sealant.mend.test="shell-profile"
