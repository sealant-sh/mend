# Experimental amd64 desktop base. Sealant overlays its supervisor and harnesses in real sessions.
FROM node:26-bookworm-slim
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ripgrep sudo ca-certificates tigervnc-standalone-server xfce4 dbus-x11 \
    x11-utils x11-xserver-utils xdotool ffmpeg imagemagick \
    novnc websockify chromium fonts-dejavu procps libgl1-mesa-dri \
    && rm -rf /var/lib/apt/lists/*
# The standalone acceptance fixture needs harnesses too. Keep versions reproducible.
RUN npm install -g @anthropic-ai/claude-code@2.1.292 @openai/codex@0.160.1 pnpm@10.32.1
COPY deploy/desktop /opt/mend-desktop
RUN chmod +x /opt/mend-desktop/start
ENV DISPLAY=:1 LIBGL_ALWAYS_SOFTWARE=1 DISABLE_AUTOUPDATER=1
# Sealant's custom-base builder installs its daemon and selected harness as root.
# The acceptance fixture explicitly starts this image as node instead.
USER root
WORKDIR /home/node
EXPOSE 6090
CMD ["/opt/mend-desktop/start"]
