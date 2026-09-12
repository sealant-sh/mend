# Slice 0 bench image for the Mend AWS MicroVM POC.
#
# Built by the Lambda MicroVM image service (CreateMicrovmImage) from this
# directory zipped with the Dockerfile at the root. Nothing session-specific is
# baked in: FSx coordinates arrive in the /run hook payload.
#
# Image contract:
#   :9000  lifecycle hooks (ready, validate, run, resume, suspend, terminate)
#   :8080  the VM endpoint (health, results, bench and transfer triggers)
#   mounts NFS, so the image must be created with --additional-os-capabilities ALL
ARG BASE_IMAGE=public.ecr.aws/lambda/microvms:al2023-minimal
FROM ${BASE_IMAGE}

RUN dnf install -y --setopt=install_weak_deps=0 \
      bash tar gzip zip unzip git nfs-utils util-linux procps-ng findutils which \
      curl-minimal \
      nodejs npm \
    && node --version && git --version \
    && npm install -g pnpm@10 \
    && dnf clean all

# Git identity for the benchmark commits; never a real person.
RUN git config --system user.name "mend-bench" \
    && git config --system user.email "bench@mend.invalid" \
    && git config --system safe.directory "*"

COPY hooks.mjs /opt/bench/hooks.mjs
COPY bench.sh /opt/bench/bench.sh
COPY bench-transfer.sh /opt/bench/bench-transfer.sh
RUN chmod 0755 /opt/bench/bench.sh /opt/bench/bench-transfer.sh && mkdir -p /mend /var/tmp/bench-local

WORKDIR /var/tmp/bench-local
ENV HOOK_PORT=9000 APP_PORT=8080
ENTRYPOINT ["node", "/opt/bench/hooks.mjs"]
