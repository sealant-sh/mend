# Temporary ARM64 candidate for the public-image packaging fix.
# The only addition is sealantctl built from sealantd v0.15.2, source
# 5173e4920d44d5663b6a4fec4606ab58e7607ca1, with the build-sealantctl-pod.json recipe.
# No daemon/runtime implementation is changed. Replace with the public fixed release later.
FROM ghcr.io/sealant-sh/sealantd@sha256:d3a393e138a96a1a1aed9c3be003aa1956a3745c61fe542d32f47f9527cb9e51
COPY --chmod=755 sealantctl /usr/local/bin/sealantctl
LABEL org.opencontainers.image.revision="5173e4920d44d5663b6a4fec4606ab58e7607ca1" \
      org.opencontainers.image.description="AWS POC candidate: public sealantd 0.15.2 plus matching sealantctl"
