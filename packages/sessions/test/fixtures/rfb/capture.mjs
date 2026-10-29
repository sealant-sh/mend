// Runs inside the capture image (see capture.sh): TigerVNC Xvnc with VncAuth, an xterm on it, and
// noVNC with its default options in headless Chromium, through a WebSocket-to-TCP proxy that
// records both directions. Session "defaults" relays every byte untouched; session "relayed"
// sends the viewer's messages through Mend's codec, as Screens.relay and the hand will.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";

import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";

import { clientCutText, encodeInput } from "../../../src/screen/rfb-client.ts";
import { ByteQueue } from "../../../src/screen/rfb-queue.ts";
import { readViewer, viewerVerdict } from "../../../src/screen/rfb-viewer.ts";

const out = process.argv[2];
const PASSWORD = "mendcap1";
const RFB_PORT = 5901;
const HTTP_PORT = 8080;
const CLIENT_HANDSHAKE = 12 + 1 + 16 + 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.writeFileSync("/tmp/passwd", execFileSync("vncpasswd", ["-f"], { input: `${PASSWORD}\n` }));
const xvnc = spawn(
  "Xvnc",
  [
    ":1",
    "-geometry",
    "1280x800",
    "-depth",
    "24",
    "-SecurityTypes",
    "VncAuth",
    "-PasswordFile",
    "/tmp/passwd",
    "-rfbport",
    String(RFB_PORT),
    "-localhost",
    "-SendCutText=0",
    "-nolisten",
    "tcp",
  ],
  { stdio: "inherit" },
);
await sleep(1500);
const xterm = spawn(
  "xterm",
  ["-geometry", "100x30+40+40", "-fa", "DejaVu Sans Mono", "-fs", "11"],
  {
    env: { ...process.env, DISPLAY: ":1" },
    stdio: "inherit",
  },
);
await sleep(1500);

const page = `<!doctype html><body style="margin:0"><div id="screen"></div><script type="module">
import RFB from "/novnc/core/rfb.js";
const mode = new URLSearchParams(location.search).get("mode");
const rfb = new RFB(document.getElementById("screen"), "ws://" + location.host + "/ws/" + mode, {
  credentials: { password: ${JSON.stringify(PASSWORD)} },
});
rfb.addEventListener("connect", () => (window.connected = true));
rfb.addEventListener("disconnect", () => (window.disconnected = true));
window.rfb = rfb;
</script></body>`;

const novnc = "/capture/node_modules/@novnc/novnc";
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://capture");
  if (url.pathname === "/") return response.end(page);
  const file = path.join(novnc, path.normalize(url.pathname.replace(/^\/novnc\//, "")));
  if (!file.startsWith(novnc) || !fs.existsSync(file)) return response.writeHead(404).end();
  response.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(file));
});
const sockets = new WebSocketServer({ server });
let lastServerByte = Date.now();
const streams = {};

sockets.on("connection", (socket, request) => {
  const mode = request.url.split("/").pop();
  const viewer = [];
  const serverBytes = [];
  streams[mode] = { viewer, server: serverBytes };
  const tcp = net.connect(RFB_PORT, "127.0.0.1");
  tcp.on("data", (chunk) => {
    lastServerByte = Date.now();
    serverBytes.push(chunk);
    socket.send(chunk);
  });
  tcp.on("close", () => socket.close());
  socket.on("close", () => tcp.destroy());
  let handshake = CLIENT_HANDSHAKE;
  const queue = new ByteQueue();
  socket.on("message", (data) => {
    const chunk = Buffer.from(data);
    viewer.push(chunk);
    if (mode === "defaults") return void tcp.write(chunk);
    const head = chunk.subarray(0, Math.max(0, handshake));
    handshake -= head.length;
    if (head.length > 0) tcp.write(head);
    queue.push(chunk.subarray(head.length));
    for (const message of readViewer(queue)) {
      const verdict = viewerVerdict(message, true);
      if (verdict._tag === "Pass") tcp.write(verdict.bytes);
      if (verdict._tag === "Reissue") tcp.write(encodeInput(verdict.input));
      if (verdict._tag === "Paste") tcp.write(clientCutText(verdict.text));
      if (verdict._tag === "Close") throw new Error(`relayed viewer closed: ${verdict.reason}`);
    }
  });
});
await new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));

const quiet = async () => {
  while (Date.now() - lastServerByte < 1500) await sleep(250);
};

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
for (const mode of ["defaults", "relayed"]) {
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`http://127.0.0.1:${HTTP_PORT}/?mode=${mode}`);
  await tab.waitForFunction(() => window.connected === true);
  await quiet();
  await tab.mouse.move(400, 300);
  await tab.mouse.click(400, 300);
  await tab.keyboard.type("echo Mend");
  await tab.keyboard.press("Enter");
  await tab.keyboard.press("Control+l");
  await tab.mouse.wheel(0, 120);
  await tab.mouse.move(200, 200, { steps: 4 });
  await tab.evaluate(() => window.rfb.clipboardPasteFrom("pasted from the holder"));
  await quiet();
  if (mode === "relayed") {
    const pixels = await tab.evaluate(() => {
      const canvas = document.querySelector("#screen canvas");
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let binary = "";
      for (let at = 0; at < data.length; at += 0x8000) {
        binary += String.fromCharCode(...data.subarray(at, at + 0x8000));
      }
      return btoa(binary);
    });
    fs.writeFileSync(
      path.join(out, "relayed.canvas.rgba.gz"),
      zlib.gzipSync(Buffer.from(pixels, "base64"), { level: 9 }),
    );
  }
  await tab.evaluate(() => window.rfb.disconnect());
  await tab.waitForFunction(() => window.disconnected === true);
  await tab.close();
  await sleep(500);
  fs.writeFileSync(path.join(out, `${mode}.viewer.bin`), Buffer.concat(streams[mode].viewer));
  if (mode === "relayed") {
    fs.writeFileSync(path.join(out, `${mode}.server.bin`), Buffer.concat(streams[mode].server));
  }
}

const version = (pkg) =>
  JSON.parse(fs.readFileSync(`/capture/node_modules/${pkg}/package.json`, "utf8")).version;
fs.writeFileSync(
  path.join(out, "capture.json"),
  `${JSON.stringify(
    {
      password: PASSWORD,
      clientHandshake: CLIENT_HANDSHAKE,
      xvnc: execFileSync("dpkg-query", [
        "-W",
        "-f",
        "${Version}",
        "tigervnc-standalone-server",
      ]).toString(),
      novnc: version("@novnc/novnc"),
      chromium: browser.version(),
    },
    null,
    2,
  )}\n`,
);
await browser.close();
server.close();
xterm.kill();
xvnc.kill();
process.exit(0);
