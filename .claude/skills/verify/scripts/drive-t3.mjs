#!/usr/bin/env node
// The verify skill's T3 gateway driver: one call of t3code's RPC over the gateway's `/ws`, as a
// t3code client makes it, with no t3code client and no dependencies (Node 26's WebSocket and
// Effect RPC's JSON wire messages).
//
//   node .claude/skills/verify/scripts/drive-t3.mjs --gw <gateway url> --bearer-file <file> \
//     [--client-app-version <v>|none] [--chunks <n>] [--timeout <s>] <method> [<json payload>]
//
// It reads the gateway bearer from <bearer-file> (in the run's private directory; never printed),
// mints a single-use socket ticket with it (`POST /api/auth/websocket-ticket`), opens
// `/ws?wsTicket=…&orchestrationProtocol=2&clientAppVersion=<v>` (default 0.1.0, what t3code
// v0.1.1's web app sends; `none` leaves it out), sends one request for <method> with <json
// payload> (default `{}`), and prints one JSON line per answer: `{"chunk":…}` for each value a
// stream sends, then `{"exit":…}` when the call ends. A stream is interrupted after <n> chunks
// (default 1). Exit 0: the call succeeded, or the stream sent its chunks. Exit 1: the call failed
// (the `exit` line holds the typed error). Exit 2: no answer within <s> seconds (default 15), or
// the socket closed or was refused first.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const options = {};
const positional = [];
for (let at = 0; at < args.length; at += 1) {
  const word = args[at];
  if (word.startsWith("--")) options[word.slice(2)] = args[(at += 1)];
  else positional.push(word);
}
const fail = (message, code = 2) => {
  process.stderr.write(`drive-t3: ${message}\n`);
  process.exit(code);
};
const [method, payloadText = "{}"] = positional;
if (!options.gw || !options["bearer-file"] || !method) {
  fail("usage: drive-t3.mjs --gw <url> --bearer-file <file> <method> [<json payload>]");
}
const payload = JSON.parse(payloadText);
const chunks = Number(options.chunks ?? 1);
const clientAppVersion = options["client-app-version"] ?? "0.1.0";
const bearer = readFileSync(options["bearer-file"], "utf8").trim();

const ticketResponse = await fetch(new URL("/api/auth/websocket-ticket", options.gw), {
  method: "POST",
  headers: { authorization: `Bearer ${bearer}` },
});
if (!ticketResponse.ok)
  fail(`no socket ticket: ${ticketResponse.status} ${await ticketResponse.text()}`);
const { ticket } = await ticketResponse.json();

const url = new URL("/ws", options.gw);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.searchParams.set("wsTicket", ticket);
url.searchParams.set("orchestrationProtocol", "2");
if (clientAppVersion !== "none") url.searchParams.set("clientAppVersion", clientAppVersion);

const socket = new WebSocket(url);
const timer = setTimeout(
  () => fail(`no answer to ${method} within ${options.timeout ?? 15} s`),
  Number(options.timeout ?? 15) * 1000,
);
const send = (message) => socket.send(JSON.stringify(message));
// Never process.exit after printing: a piped stdout would lose what it has not flushed yet.
let finished = false;
const finish = (code) => {
  finished = true;
  clearTimeout(timer);
  process.exitCode = code;
  socket.close();
};
let received = 0;

socket.addEventListener("open", () =>
  send({ _tag: "Request", id: "1", tag: method, payload, headers: [] }),
);
socket.addEventListener("error", () => fail(`the socket to ${options.gw} failed`));
socket.addEventListener("close", (event) => {
  if (!finished) fail(`the socket closed first (${event.code} ${event.reason})`);
});
socket.addEventListener("message", (event) => {
  if (finished) return;
  const message = JSON.parse(String(event.data));
  if (message._tag === "Ping") return send({ _tag: "Pong" });
  if (message._tag === "Chunk") {
    for (const value of message.values) {
      console.log(JSON.stringify({ chunk: value }));
      received += 1;
    }
    send({ _tag: "Ack", requestId: message.requestId });
    if (received >= chunks) {
      send({ _tag: "Interrupt", requestId: message.requestId });
      finish(0);
    }
    return;
  }
  if (message._tag === "Exit") {
    console.log(JSON.stringify({ exit: message.exit }));
    return finish(message.exit._tag === "Success" ? 0 : 1);
  }
  if (message._tag === "Defect" || message._tag === "ClientProtocolError") {
    console.log(JSON.stringify({ exit: message }));
    finish(1);
  }
});
