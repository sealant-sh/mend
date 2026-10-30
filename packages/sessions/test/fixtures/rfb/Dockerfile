FROM debian:trixie-slim AS xvnc
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fonts-dejavu-core locales tigervnc-standalone-server tigervnc-tools x11-utils \
    x11-xserver-utils xdotool xinput xterm \
  && sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen && locale-gen \
  && rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8

FROM node:26-trixie-slim AS capture
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium fonts-dejavu-core tigervnc-standalone-server tigervnc-tools xterm \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /capture
RUN npm install --no-save --no-audit --no-fund @novnc/novnc@1.7.0 playwright-core@1.64.0 ws@8.22.0
