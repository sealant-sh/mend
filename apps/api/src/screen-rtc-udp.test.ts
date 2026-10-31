import { createHmac } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";

import { afterEach, expect, it } from "vitest";

import { ScreenRtcUdp } from "./screen-rtc-udp.ts";

const sockets: Array<Socket> = [];
const muxes: Array<ScreenRtcUdp> = [];
const openSocket = async () => {
  const socket = createSocket("udp4");
  sockets.push(socket);
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return socket;
};
afterEach(() => {
  for (const mux of muxes.splice(0)) mux.close();
  for (const socket of sockets.splice(0)) socket.close();
});
const attribute = (type: number, bytes: Buffer) => {
  const attr = Buffer.alloc(4 + ((bytes.length + 3) & ~3));
  attr.writeUInt16BE(type);
  attr.writeUInt16BE(bytes.length, 2);
  bytes.copy(attr, 4);
  return attr;
};
const stun = (ufrag: string, password: string) => {
  const username = attribute(6, Buffer.from(`${ufrag}:browser`));
  const header = Buffer.alloc(20);
  header.writeUInt16BE(1);
  header.writeUInt16BE(username.length + 24, 2);
  header.writeUInt32BE(0x2112a442, 4);
  const signed = Buffer.concat([header, username]);
  return Buffer.concat([
    signed,
    attribute(8, createHmac("sha1", password).update(signed).digest()),
  ]);
};
const sdp = (port: number, ufrag: string) =>
  `v=0\r\na=ice-ufrag:${ufrag}\r\na=ice-pwd:password-${ufrag}\r\na=candidate:1 1 udp 2130706431 127.0.0.1 ${port} typ host\r\n`;
const delay = () => new Promise((resolve) => setTimeout(resolve, 50));

it("announces one port for two peers and authenticates STUN before routing any bytes to either", async () => {
  const first = await openSocket();
  const second = await openSocket();
  const browser = await openSocket();
  const reserved = await openSocket();
  const port = reserved.address().port;
  reserved.close();
  sockets.splice(sockets.indexOf(reserved), 1);
  const mux = new ScreenRtcUdp(port, "localhost");
  muxes.push(mux);
  const a = await mux.register(sdp(first.address().port, "first"));
  const b = await mux.register(sdp(second.address().port, "second"));
  for (const answer of [a, b]) expect(answer.sdp).toContain(` 127.0.0.1 ${port} typ host`);
  const received: Array<string> = [];
  first.on("message", (data, from) => {
    received.push(`a:${data.toString("hex")}`);
    first.send(Buffer.from("a reply"), from.port, from.address);
  });
  second.on("message", (data, from) => {
    received.push(`b:${data.toString("hex")}`);
    second.send(Buffer.from("b reply"), from.port, from.address);
  });
  const replies: Array<string> = [];
  browser.on("message", (data) => replies.push(data.toString()));
  browser.send(stun("first", "wrong-password"), port, "127.0.0.1");
  browser.send(Buffer.from("unauthenticated DTLS"), port, "127.0.0.1");
  await delay();
  expect(received).toEqual([]);
  browser.send(stun("first", "password-first"), port, "127.0.0.1");
  await delay();
  expect(replies).toEqual(["a reply"]);
  browser.send(Buffer.from("DTLS"), port, "127.0.0.1");
  await delay();
  expect(received.at(-1)).toBe(`a:${Buffer.from("DTLS").toString("hex")}`);
  // A new authenticated username can route a separate peer on the same public port.
  browser.send(stun("second", "password-second"), port, "127.0.0.1");
  await delay();
  expect(replies.at(-1)).toBe("b reply");
  b.close();
  const count = received.length;
  browser.send(Buffer.from("after close"), port, "127.0.0.1");
  await delay();
  expect(received).toHaveLength(count);
  a.close();
});

it("answers nothing but an authenticated Binding request, even from a tuple it routes", async () => {
  const peerSocket = await openSocket();
  const browser = await openSocket();
  const reserved = await openSocket();
  const port = reserved.address().port;
  reserved.close();
  sockets.splice(sockets.indexOf(reserved), 1);
  const mux = new ScreenRtcUdp(port, "localhost");
  muxes.push(mux);
  const answer = await mux.register(sdp(peerSocket.address().port, "only"));
  const received: Array<string> = [];
  peerSocket.on("message", (data, from) => {
    received.push(data.toString("hex"));
    peerSocket.send(Buffer.alloc(72), from.port, from.address);
  });
  const replies: Array<number> = [];
  browser.on("message", (data) => replies.push(data.length));
  browser.send(stun("only", "password-only"), port, "127.0.0.1");
  await delay();
  expect(replies).toEqual([72]);
  // An unsigned non-Binding STUN request (Allocate, 0x0003) from the routed tuple.
  const allocate = Buffer.alloc(20);
  allocate.writeUInt16BE(0x0003);
  allocate.writeUInt32BE(0x2112a442, 4);
  // An unsigned Binding indication (0x0011) and a Binding response (0x0101) as well.
  const indication = Buffer.from(allocate);
  indication.writeUInt16BE(0x0011);
  const response = Buffer.from(allocate);
  response.writeUInt16BE(0x0101);
  const before = received.length;
  for (const message of [allocate, indication, response]) browser.send(message, port, "127.0.0.1");
  await delay();
  expect(received).toHaveLength(before);
  expect(replies).toEqual([72]);
  answer.close();
});
