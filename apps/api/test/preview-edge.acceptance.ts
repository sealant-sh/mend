import { execFile } from "node:child_process";
import * as https from "node:https";
import { promisify } from "node:util";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  type DigestAnswer,
  type RunningFixture,
  type SseEvent,
  spawnFixture,
} from "./fixtures/preview/apps.ts";
import { openInChromium } from "./support/preview-browser.ts";
import { uploadGenerated } from "./support/preview-bytes.ts";
import {
  type EdgeKind,
  edgeMemory,
  type RunningEdge,
  startEdge,
  sweepEdges,
} from "./support/preview-edge.ts";
import { startViteFixture } from "./support/preview-vite.ts";

const run = promisify(execFile);
const MiB = 1024 * 1024;
const DOMAIN = "preview.localhost";
const HOST = `app.${DOMAIN}`;

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
});
afterAll(sweepEdges);

const edgeIn = async (kind: EdgeKind, upstreamPort: number): Promise<RunningEdge> => {
  const edge = await startEdge(kind, { upstreamPort, domain: DOMAIN });
  disposers.push(edge.stop);
  process.stderr.write(`${kind}: ${edge.image} (${edge.version})\n`);
  return edge;
};

const upstream = async (): Promise<RunningFixture> => {
  const fixture = await spawnFixture("all");
  disposers.push(fixture.stop);
  return fixture;
};

const spooledFiles = async (container: string) =>
  Number(
    (
      await run("docker", [
        "exec",
        container,
        "sh",
        "-c",
        "find /tmp/nginx-client-body /tmp/nginx-proxy -type f 2>/dev/null | wc -l",
      ])
    ).stdout.trim(),
  );

describe.each<EdgeKind>(["caddy", "nginx"])("%s edge", (kind) => {
  it("streams a 512 MiB chunked upload to a slow sink whole, its own memory flat", async () => {
    const app = await upstream();
    const edge = await edgeIn(kind, app.port);
    const before = await edgeMemory(edge.container);
    const bytes = 512 * MiB;
    const state = { uploading: true };
    const started = Date.now();
    const upload = uploadGenerated(`https://${HOST}:${edge.httpsPort}/upload?rate=${32 * MiB}`, {
      bytes,
      chunked: true,
    }).finally(() => {
      state.uploading = false;
    });
    const during: number[] = [];
    const spooled: number[] = [];
    while (state.uploading) {
      during.push(await edgeMemory(edge.container));
      if (kind === "nginx") spooled.push(await spooledFiles(edge.container));
    }
    const result = await upload;
    const answer: DigestAnswer = JSON.parse(result.body);
    const peak = Math.max(...during);
    process.stderr.write(
      `${kind} 512 MiB upload in ${((Date.now() - started) / 1000).toFixed(1)} s: edge memory ${(before / MiB).toFixed(1)} MiB before, peak ${(peak / MiB).toFixed(1)} MiB over ${during.length} samples; nginx spooled files ${JSON.stringify(spooled)}\n`,
    );
    expect(answer.bytes, "every byte reached the sink").toBe(bytes);
    expect(answer.sha256, "the bytes the client sent").toBe(result.sentSha256);
    expect(answer.headers["transfer-encoding"], "the upstream saw it streamed").toBe("chunked");
    expect(during.length, "memory was sampled during the upload").toBeGreaterThanOrEqual(3);
    expect(peak - before, "the edge held no meaningful part of the body").toBeLessThan(32 * MiB);
    if (kind === "nginx") expect(Math.max(...spooled), "nginx wrote no body temp file").toBe(0);
  });

  it("delivers server-sent events spaced as sent", async () => {
    const app = await upstream();
    const edge = await edgeIn(kind, app.port);
    const arrivals = await new Promise<Array<{ event: SseEvent; at: number }>>(
      (resolve, reject) => {
        const seen: Array<{ event: SseEvent; at: number }> = [];
        https
          .get(
            {
              host: HOST,
              port: edge.httpsPort,
              path: "/events?every=1500&count=3",
              rejectUnauthorized: false,
            },
            (response) => {
              let pending = "";
              response.setEncoding("utf8");
              response.on("data", (text: string) => {
                pending += text;
                const frames = pending.split("\n\n");
                pending = frames.pop() ?? "";
                for (const frame of frames) {
                  const data = frame.split("\n").find((line) => line.startsWith("data: "));
                  if (data !== undefined)
                    seen.push({ event: JSON.parse(data.slice(6)), at: Date.now() });
                }
              });
              response.on("end", () => resolve(seen));
            },
          )
          .on("error", reject);
      },
    );
    const lags = arrivals.map((arrival) => arrival.at - arrival.event.sentAt);
    process.stderr.write(`${kind} SSE: arrival lag after send ${JSON.stringify(lags)} ms\n`);
    expect(
      arrivals.map((arrival) => arrival.event.i),
      "every event",
    ).toEqual([0, 1, 2]);
    for (const lag of lags)
      expect(lag, "each event arrives when sent, not batched").toBeLessThan(500);
  });

  it("carries a WebSocket echo", async () => {
    const app = await upstream();
    const edge = await edgeIn(kind, app.port);
    const client = new WebSocket(`wss://${HOST}:${edge.httpsPort}/socket`, {
      rejectUnauthorized: false,
    });
    disposers.push(async () => client.terminate());
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const reply = new Promise<string>((resolve) =>
      client.once("message", (data: Buffer) => resolve(data.toString("utf8"))),
    );
    client.send(`through ${kind}`);
    expect(await reply, "the echo came back through the edge").toBe(`through ${kind}`);
  });

  it("serves the Vite app to Chromium with HMR", async () => {
    const vite = await startViteFixture();
    disposers.push(vite.stop);
    const edge = await edgeIn(kind, vite.port);
    const { page, close } = await openInChromium(`https://${HOST}:${edge.httpsPort}/`);
    disposers.push(close);
    const message = page.locator("#message");
    await message.waitFor();
    expect(await message.textContent(), "the app rendered through the edge").toBe(
      "hello from the fixture",
    );
    await page.evaluate(() => {
      Reflect.set(window, "__firstLoad", true);
    });
    await vite.edit(`hot through ${kind}`);
    await page.waitForFunction(
      (text) => document.querySelector("#message")?.textContent === text,
      `hot through ${kind}`,
      { timeout: 15_000 },
    );
    expect(
      await page.evaluate(() => Reflect.get(window, "__firstLoad")),
      "HMR over the edge's WebSocket, no reload",
    ).toBe(true);
  });
});
