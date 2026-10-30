FROM node:26-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium fonts-dejavu-core tigervnc-standalone-server tigervnc-tools xterm \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /capture
RUN npm install --no-save --no-audit --no-fund @novnc/novnc@1.7.0 playwright-core@1.64.0 ws@8.22.0
