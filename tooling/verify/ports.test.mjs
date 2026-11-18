import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

import { choosePorts, stopDrive } from "./ports.mjs";

test("simultaneous drives choose distinct free ports and honour an explicit port", async () => {
  const pairs = await Promise.all([
    choosePorts([undefined, undefined]),
    choosePorts([undefined, undefined]),
  ]);
  assert.equal(new Set(pairs.flat()).size, 4);
  const [pinned] = pairs[0];
  assert.equal((await choosePorts([String(pinned), undefined]))[0], pinned);
});

test("a refused override releases the other reservation and leaves the occupied port alone", async (t) => {
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  t.after(() => occupied.close());
  const port = occupied.address().port;
  const [free] = await choosePorts([undefined]);
  await assert.rejects(choosePorts([String(free), String(port)]), { code: "EADDRINUSE" });
  assert.deepEqual(await choosePorts([String(free)]), [free]);
  assert.equal(occupied.listening, true);
  await assert.rejects(choosePorts(["invalid"]));
});

test("cleanup stops the drive's descendants, including a server that ignores SIGTERM", async (t) => {
  const [port] = await choosePorts([undefined]);
  const serverCode = `
    process.on('SIGTERM', () => {});
    require('node:net').createServer().listen(${port}, '127.0.0.1', () => process.send('ready'));
  `;
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const server = require('node:child_process').fork('-e', [${JSON.stringify(serverCode)}]);
    server.on('message', () => process.send('ready'));
  `,
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  t.after(() => stopDrive(child));
  await once(child, "message");
  await assert.rejects(choosePorts([String(port)]), { code: "EADDRINUSE" });
  await stopDrive(child, [port]);
  assert.deepEqual(await choosePorts([String(port)]), [port]);
});
