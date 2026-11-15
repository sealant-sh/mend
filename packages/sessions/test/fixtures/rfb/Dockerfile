# Base images by digest from Docker's official-image mirror on ECR Public: Docker Hub limits
# anonymous pulls per runner address, and CI has no login.
FROM public.ecr.aws/docker/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS xvnc
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fonts-dejavu-core locales tigervnc-standalone-server tigervnc-tools x11-utils \
    x11-xserver-utils xdotool xinput xterm ffmpeg \
  && sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen && locale-gen \
  && rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8

FROM xvnc AS screen
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium procps socat xauth dbus-daemon adwaita-icon-theme \
    xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-settings xfconf thunar xfce4-terminal \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 40001 --create-home person \
  && install -d -o person -m 700 /run/user/40001
COPY screen-http-page.sh /usr/local/lib/screen-http-page.sh

FROM public.ecr.aws/docker/library/node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS capture
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium fonts-dejavu-core tigervnc-standalone-server tigervnc-tools xterm \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /capture
RUN npm install --no-save --no-audit --no-fund @novnc/novnc@1.7.0 playwright-core@1.64.0 ws@8.22.0
