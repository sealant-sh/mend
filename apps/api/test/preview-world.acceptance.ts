import { afterEach, expect, it } from "vitest";

import { type DigestAnswer, spawnFixture } from "./fixtures/preview/apps.ts";
import {
  type AcceptanceGatewayOptions,
  grantCookieAt,
  previewSignIn,
  spawnGateway,
  startGateway,
} from "./support/preview-acceptance-world.ts";
import { createPreviewDatabase, exitAttempts } from "./support/preview-database.ts";
import { freePort, send } from "./support/preview-gateway-world.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
});

const world = async (tag: string) => {
  const database = await createPreviewDatabase(tag);
  disposers.push(database.drop);
  const port = await freePort();
  const options: AcceptanceGatewayOptions = {
    databaseUrl: database.url,
    routing: { mode: "loopback-http", port },
    port,
    localPorts: { web: await freePort(), docs: await freePort() },
    starts: { web: { _tag: "Fixture", fixture: "all", delayMs: 500 } },
  };
  const signIn = previewSignIn(database.url, options.routing, database.previews);
  disposers.push(signIn.dispose);
  return { database, options, signIn };
};

it("signs a person in through a minted ticket and relays to the running Service, in this process", async () => {
  const { options, signIn } = await world("preview_world_in");
  const app = await spawnFixture("all", options.localPorts.web);
  disposers.push(app.stop);
  const gateway = await startGateway(options);
  disposers.push(gateway.close);
  const cookie = await grantCookieAt(gateway.port, await signIn.authUrl("carol", "web"));
  expect(cookie, "a real grant from the exchange").toMatch(/^mend-preview=mpg_/);
  const host = new URL(await signIn.authUrl("carol", "web")).host;
  const reply = await send(gateway.port, { host, path: "/first?x=1", headers: { cookie } });
  expect(reply.status, "the running Service answered").toBe(200);
  const answer: DigestAnswer = JSON.parse(reply.body);
  expect(answer.path, "the path and query as the browser sent them").toBe("/first?x=1");
  expect(answer.headers.host, "Host rewritten to the workspace port").toBe("localhost:3000");
  expect(gateway.starts, "a running Service is never started").toEqual([]);
});

it("starts a stopped Service for a request and delivers it, in a child process", async () => {
  const { options, signIn } = await world("preview_world_child");
  await signIn.run(exitAttempts("web"));
  const child = await spawnGateway(options);
  disposers.push(child.sampled.stop);
  const authUrl = await signIn.authUrl("carol", "web");
  const cookie = await grantCookieAt(options.port, authUrl);
  const started = Date.now();
  const reply = await send(options.port, {
    host: new URL(authUrl).host,
    path: "/after-start",
    method: "POST",
    headers: { cookie, origin: new URL(authUrl).origin },
    body: "field=1",
  });
  const heldMs = Date.now() - started;
  expect(reply.status, "the held request was delivered once the Service started").toBe(200);
  const answer: DigestAnswer = JSON.parse(reply.body);
  expect(answer.bytes, "with its whole body").toBe(7);
  expect(heldMs, "after the stand-in's start delay").toBeGreaterThanOrEqual(500);
  expect(child.starts().length, "one start, asked by the child's gateway").toBe(1);
  expect(child.sampled.nodeVersion(), "the child runs this Node").toBe(process.version);
});
