import * as http from "node:http";

import type { Page } from "playwright-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { type DigestAnswer, type RunningFixture, spawnFixture } from "./fixtures/preview/apps.ts";
import {
  type AcceptanceGatewayOptions,
  grantCookieAt,
  type PreviewSignIn,
  previewSignIn,
  spawnGateway,
  startGateway,
} from "./support/preview-acceptance-world.ts";
import { openInChromium } from "./support/preview-browser.ts";
import { uploadGenerated, type UploadResult } from "./support/preview-bytes.ts";
import {
  createPreviewDatabase,
  exitAttempts,
  PEOPLE,
  type PreviewDatabase,
  type ServiceKey,
} from "./support/preview-database.ts";
import { type EdgeKind, startEdge, sweepEdges } from "./support/preview-edge.ts";
import { freePort } from "./support/preview-gateway-world.ts";
import type { MemorySample, SampledChild } from "./support/preview-memory.ts";
import { startViteFixture } from "./support/preview-vite.ts";

/** Every line this file prints to stderr is a measurement the PR records. */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const DOMAIN = "preview.localhost";
type Front = "direct" | EdgeKind;
const FRONTS: ReadonlyArray<Front> = ["direct", "caddy", "nginx"];

const disposers: Array<() => Promise<void>> = [];
const dispose = async () => {
  for (const next of disposers.splice(0).toReversed()) await next();
};
afterEach(dispose);
afterAll(sweepEdges);

const report = (line: string) => process.stderr.write(`${line}\n`);
const mib = (bytes: number) => `${(bytes / MiB).toFixed(1)} MiB`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Stage {
  readonly front: Front;
  readonly database: PreviewDatabase;
  readonly signIn: PreviewSignIn;
  readonly options: AcceptanceGatewayOptions;
  readonly loopbackHosts: ReadonlyArray<string>;
  readonly originOf: (key: ServiceKey) => string;
  readonly urlOf: (
    key: ServiceKey,
    path: string,
  ) => { readonly url: string; readonly host: string };
  readonly cookieOf: (userId: string, key: ServiceKey) => Promise<string>;
}

const stage = async (
  tag: string,
  front: Front,
  shape: (ports: { web: number; docs: number }) => Partial<AcceptanceGatewayOptions>,
): Promise<Stage> => {
  const database = await createPreviewDatabase(`${tag}_${front}`);
  disposers.push(database.drop);
  const port = await freePort();
  const localPorts = { web: await freePort(), docs: await freePort() };
  const edge =
    front === "direct" ? null : await startEdge(front, { upstreamPort: port, domain: DOMAIN });
  if (edge !== null) {
    disposers.push(edge.stop);
    report(`${front}: ${edge.image} (${edge.version})`);
  }
  const options: AcceptanceGatewayOptions = {
    databaseUrl: database.url,
    routing:
      edge === null
        ? { mode: "loopback-http", port }
        : { mode: "domain-https", domain: DOMAIN, port: edge.httpsPort },
    port,
    localPorts,
    ...shape(localPorts),
  };
  const signIn = previewSignIn(database.url, options.routing, database.previews);
  disposers.push(signIn.dispose);
  const originOf = (key: ServiceKey) => signIn.originOf(database.previews[key].id);
  return {
    front,
    database,
    signIn,
    options,
    loopbackHosts: edge === null ? ["*.localhost"] : [`*.${DOMAIN}`],
    originOf,
    urlOf: (key, path) => {
      const origin = new URL(originOf(key));
      return {
        url: edge === null ? `http://127.0.0.1:${port}${path}` : `${origin.origin}${path}`,
        host: origin.host,
      };
    },
    cookieOf: async (userId, key) => grantCookieAt(port, await signIn.authUrl(userId, key, "/")),
  };
};

const inProcess = async (at: Stage) => {
  const gateway = await startGateway(at.options);
  disposers.push(gateway.close);
  return gateway;
};

const inChild = async (at: Stage, sampling: Parameters<typeof spawnGateway>[1] = {}) => {
  const child = await spawnGateway(at.options, sampling);
  disposers.push(child.sampled.stop);
  return child;
};

const running = async (port: number) => {
  const fixture: RunningFixture = await spawnFixture("all", port);
  disposers.push(fixture.stop);
  return fixture;
};

const chromium = async (at: Stage, url: string) => {
  const opened = await openInChromium(url, { loopbackHosts: at.loopbackHosts });
  disposers.push(opened.close);
  return opened.page;
};

/**
 * Docker on this machine adds and removes network interfaces, and Chromium fails a request in
 * flight across that with ERR_NETWORK_CHANGED; the retry goes to `again`, since the sign-in ticket
 * in `url` is single use and already spent.
 */
const heldNavigation = async (page: Page, url: string, again: string) => {
  for (let tries = 1; ; tries += 1) {
    try {
      return await page.goto(tries === 1 ? url : again);
    } catch (error) {
      if (tries >= 3 || !String(error).includes("ERR_NETWORK_CHANGED")) throw error;
      report(`retrying a held navigation after ERR_NETWORK_CHANGED (${tries})`);
    }
  }
};

const upload = (
  at: Stage,
  key: ServiceKey,
  path: string,
  cookie: string,
  options: { readonly bytes: number; readonly chunked?: boolean; readonly contentType?: string },
): Promise<UploadResult> => {
  const { url, host } = at.urlOf(key, path);
  return uploadGenerated(url, {
    bytes: options.bytes,
    chunked: options.chunked ?? false,
    headers: {
      host,
      cookie,
      origin: at.originOf(key),
      ...(options.contentType === undefined ? {} : { "content-type": options.contentType }),
    },
  });
};

const peakDuring = async <A>(child: SampledChild, work: () => Promise<A>) => {
  const baseline = await child.baseline();
  const result = await work();
  await sleep(300);
  const peak = child.peak();
  return { result, baseline, peak, growth: peak.rss - baseline.rss };
};

/** The app reads each upload at this rate, so a queue anywhere in the relay would grow. */
const SINK_RATE = 64 * MiB;
const START_DELAY_MS = 3_000;
/** What holding may cost: nothing of a held body is read, so only heads and socket buffers. */
const HELD_RSS = 8 * MiB;
/**
 * Live buffers after a full collection while three requests relay (ADR 0017 base design: 16 MiB
 * fixed and 2 MiB of Node and SDK queues per active forward). 2.1 GiB pass under it.
 */
const RELAY_BUFFERS = 16 * MiB + 3 * 2 * MiB;

const peakOf = (samples: ReadonlyArray<MemorySample>, field: "rss" | "arrayBuffers") =>
  Math.max(...samples.map((sample) => sample[field]));

describe.each(FRONTS)("through the preview gateway, %s", (front) => {
  it("serves a real Vite app's page, its assets and hot reload to Chromium", async () => {
    const vite = await startViteFixture();
    disposers.push(vite.stop);
    const at = await stage("vite", front, () => ({}));
    const options = { ...at.options, localPorts: { ...at.options.localPorts, web: vite.port } };
    const gateway = await inProcess({ ...at, options });
    const page = await chromium(at, await at.signIn.authUrl("carol", "web", "/"));
    const message = page.locator("#message");
    await message.waitFor();
    expect(new URL(page.url()).origin, "the page is the preview's own origin").toBe(
      at.originOf("web"),
    );
    expect(await message.textContent(), "the module graph rendered").toBe("hello from the fixture");
    expect(
      await message.evaluate((element) => getComputedStyle(element).color),
      "the imported CSS applied",
    ).toBe("rgb(1, 2, 3)");
    expect(
      await page
        .locator("#logo")
        .evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth),
      "the absolute /logo.svg asset loaded",
    ).toBe(32);
    await page.evaluate(() => Reflect.set(window, "__firstLoad", true));
    await vite.edit(`hot through the gateway, ${front}`);
    await page.waitForFunction(
      (text) => document.querySelector("#message")?.textContent === text,
      `hot through the gateway, ${front}`,
      { timeout: 15_000 },
    );
    expect(
      await page.evaluate(() => Reflect.get(window, "__firstLoad")),
      "the edit arrived over Vite's WebSocket, without a reload",
    ).toBe(true);
    expect(gateway.starts, "a running Service is never started").toEqual([]);
    report(`${front} Vite: page, CSS, /logo.svg and HMR through the gateway in Chromium`);
  });

  it("lets no page on another preview post to this one or open its socket", async () => {
    const seen: Array<string> = [];
    const target = http.createServer((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      request.resume();
      request.on("end", () => response.end("<!doctype html><p id=ok>web</p>"));
    });
    target.on("upgrade", (request, socket) => {
      seen.push(`UPGRADE ${request.url}`);
      socket.destroy();
    });
    const at = await stage("origin", front, () => ({}));
    await new Promise<void>((resolve) =>
      target.listen(at.options.localPorts.web, "127.0.0.1", resolve),
    );
    disposers.push(
      () =>
        new Promise((resolve) => {
          target.closeAllConnections();
          target.close(() => resolve());
        }),
    );
    await running(at.options.localPorts.docs);
    await inProcess(at);
    const page = await chromium(at, await at.signIn.authUrl("carol", "web", "/"));
    await page.goto(await at.signIn.authUrl("carol", "docs", "/"));
    const before = seen.length;
    const web = at.originOf("web");
    const outcome = await page.evaluate(async (origin) => {
      const posted = await fetch(`${origin}/fetch-post`, {
        method: "POST",
        mode: "no-cors",
        credentials: "include",
        body: "field=1",
      }).then(
        () => "settled",
        () => "failed",
      );
      const frame = document.createElement("iframe");
      frame.name = "sink";
      document.body.append(frame);
      const form = document.createElement("form");
      form.method = "POST";
      form.action = `${origin}/form-post`;
      form.target = "sink";
      const field = document.createElement("input");
      field.name = "field";
      field.value = "1";
      form.append(field);
      document.body.append(form);
      const loaded = new Promise((resolve) => frame.addEventListener("load", resolve));
      form.submit();
      await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      const socket = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/socket`);
        ws.addEventListener("open", () => resolve("opened"));
        ws.addEventListener("error", () => resolve("refused"));
        setTimeout(() => resolve("timed out"), 3_000);
      });
      return { posted, socket };
    }, web);
    expect(outcome.socket, "the socket never opened").toBe("refused");
    expect(seen.slice(before), "nothing from the other preview's page reached the app").toEqual([]);
    await page.goto(`${web}/`);
    const own = await page.evaluate(async () => {
      const reply = await fetch("/own-post", { method: "POST", body: "field=1" });
      return reply.status;
    });
    expect(own, "the preview's own page may post to it").toBe(200);
    expect(seen.at(-1), "and that post reached the app").toBe("POST /own-post");
    report(
      `${front} Origin: cross-preview fetch ${outcome.posted}, form, socket ${outcome.socket}; 0 bytes reached the app`,
    );
  });

  it("starts a stopped preview for a form post and a >1 GiB upload, delivers both whole, memory flat", async () => {
    const at = await stage("held", front, () => ({
      starts: { web: { _tag: "Fixture", fixture: "all", delayMs: START_DELAY_MS } },
    }));
    await at.signIn.run(exitAttempts("web"));
    const child = await inChild(at, { intervalMs: 250, collect: true });
    const cookie = await at.cookieOf("carol", "web");
    const bytes = GiB + 64 * MiB;
    const measured = await peakDuring(child.sampled, () =>
      Promise.all([
        upload(at, "web", "/form", cookie, {
          bytes: 64,
          contentType: "application/x-www-form-urlencoded",
        }),
        upload(at, "web", `/upload?rate=${SINK_RATE}`, cookie, { bytes }),
        upload(at, "web", `/upload-chunked?rate=${SINK_RATE}`, cookie, { bytes, chunked: true }),
      ]),
    );
    const [form, sized, chunked] = measured.result;
    for (const [what, sent] of [
      ["the form post", form],
      ["the sized upload", sized],
      ["the chunked upload", chunked],
    ] as const) {
      expect(sent.status, `${what} was delivered once the Service started`).toBe(200);
      const answer: DigestAnswer = JSON.parse(sent.body);
      expect(answer.bytes, `${what} arrived whole`).toBe(sent.sentBytes);
      expect(answer.sha256, `${what}: the bytes the client sent`).toBe(sent.sentSha256);
    }
    expect(child.starts().length, "three held requests, one start").toBe(1);
    const { baseline } = measured;
    const samples = child.sampled.samples().filter((sample) => sample.t >= baseline.t);
    const held = samples.filter((sample) => sample.t < baseline.t + START_DELAY_MS - 500);
    const relayed = samples.filter((sample) => sample.t > baseline.t + START_DELAY_MS + 1_000);
    const heldGrowth = peakOf(held, "rss") - baseline.rss;
    const liveBuffers = peakOf(relayed, "arrayBuffers") - baseline.arrayBuffers;
    report(
      `${front} held: form + 2 × ${mib(bytes)} to a ${mib(SINK_RATE)}/s sink, one start, ${relayed.length} collected samples while relaying; RSS baseline ${mib(baseline.rss)}, while held +${mib(heldGrowth)}, peak +${mib(measured.growth)}; live arrayBuffers baseline ${mib(baseline.arrayBuffers)}, relay peak +${mib(liveBuffers)} (ceiling ${mib(RELAY_BUFFERS)})`,
    );
    expect(relayed.length, "the relay was sampled throughout").toBeGreaterThan(20);
    expect(heldGrowth, "holding the three read none of their bodies").toBeLessThan(HELD_RSS);
    expect(liveBuffers, "what the relay holds stays bounded while 2.1 GiB pass").toBeLessThan(
      RELAY_BUFFERS,
    );
  }, 900_000);

  it("answers a start that times out with its 503 page, in the browser and before an upload ends", async () => {
    const at = await stage("timeout", front, () => ({
      startHoldMs: 3_000,
      starts: { web: { _tag: "Never" } },
    }));
    await at.signIn.run(exitAttempts("web"));
    const gateway = await inProcess(at);
    const page = await chromium(at, "about:blank");
    const started = Date.now();
    const navigated = await heldNavigation(
      page,
      await at.signIn.authUrl("carol", "web", "/held"),
      `${at.originOf("web")}/held`,
    );
    expect(navigated?.status(), "the browser received the gateway's 503").toBe(503);
    expect(await page.locator("p").textContent(), "and its one line").toBe(
      "preview · web · did not start in 3 s · start timed out · your request was not delivered",
    );
    expect(Date.now() - started, "after the hold").toBeGreaterThanOrEqual(3_000);

    const cookie = await at.cookieOf("dave", "web");
    const bytes = 256 * MiB;
    const sent = await upload(at, "web", "/upload", cookie, { bytes });
    expect(sent.status, "an upload held past the hold gets the 503 too").toBe(503);
    expect(sent.body, "with the same line").toContain(
      "start timed out · your request was not delivered",
    );
    expect(sent.sentBytes, "before the client finished sending its body").toBeLessThan(bytes);
    expect(gateway.starts.length, "one start each, both given up").toBeGreaterThanOrEqual(1);
    report(
      `${front} timeout: browser saw 503 and the page; a ${mib(bytes)} upload got 503 after sending ${mib(sent.sentBytes)}`,
    );
  });

  it("answers a preview a person stopped with a page naming them, and starts nothing", async () => {
    const at = await stage("stopped", front, () => ({
      starts: { web: { _tag: "Fixture", fixture: "all", delayMs: 0 } },
    }));
    await at.signIn.run(exitAttempts("web"));
    await at.signIn.stop("web", "carol");
    const gateway = await inProcess(at);
    const page = await chromium(at, "about:blank");
    const navigated = await page.goto(await at.signIn.authUrl("dave", "web", "/"));
    expect(navigated?.status(), "the browser received 503").toBe(503);
    expect(await page.locator("p").textContent(), "naming who stopped it").toBe(
      "preview · web · carol stopped the preview · your request was not delivered",
    );
    expect(gateway.starts, "and nothing started it").toEqual([]);
    report(`${front} stopped: browser saw "carol stopped the preview", no start`);
  });
});

describe("the gateway's memory under slow readers, direct", () => {
  const READERS = 16;
  const PAYLOAD = 64 * MiB;
  /** ADR 0017 base design: 32 MiB fixed, 8 MiB per active forward (2 MiB logical, ×4). */
  const CEILING = 32 * MiB + READERS * 8 * MiB;

  const stalledReaders = async (unbounded: boolean) => {
    const at = await stage(unbounded ? "slow_unbounded" : "slow_bounded", "direct", () => ({
      unbounded,
    }));
    const app = await spawnFixture("download", at.options.localPorts.web);
    disposers.push(app.stop);
    const child = await inChild(at);
    const cookies = await Promise.all(PEOPLE.map((person) => at.cookieOf(person, "web")));
    const { url, host } = at.urlOf("web", `/bytes?n=${PAYLOAD}`);
    const baseline = await child.sampled.baseline();
    const readers = Array.from({ length: READERS }, (_, index) => {
      const reader = Promise.withResolvers<http.IncomingMessage>();
      const outgoing = http.get(url, {
        agent: false,
        headers: { host, cookie: cookies[index % cookies.length] ?? "" },
      });
      outgoing.on("error", () => undefined);
      outgoing.on("response", (response) => {
        response.once("data", () => {
          response.pause();
          reader.resolve(response);
        });
      });
      disposers.push(async () => {
        outgoing.destroy();
      });
      return reader.promise;
    });
    const responses = await Promise.all(readers);
    const started = Date.now();
    let last = 0;
    let stableSince = started;
    while (Date.now() - started < 90_000) {
      await sleep(250);
      const rss = child.sampled.peak().rss;
      if (Math.abs(rss - last) > MiB) stableSince = Date.now();
      last = rss;
      if (Date.now() - started > 10_000 && Date.now() - stableSince > 5_000) break;
    }
    const peak = child.sampled.peak();
    await dispose();
    return {
      statuses: responses.map((response) => response.statusCode),
      baseline,
      peak,
      growth: peak.rss - baseline.rss,
    };
  };

  it("holds RSS under its derived ceiling, where an unbounded forward passes it", async () => {
    const bounded = await stalledReaders(false);
    const unbounded = await stalledReaders(true);
    report(
      `slow readers: ${READERS} × ${mib(PAYLOAD)} stalled after one chunk; ceiling +${mib(CEILING)}; bounded RSS ${mib(bounded.baseline.rss)} → ${mib(bounded.peak.rss)} (+${mib(bounded.growth)}), arrayBuffers peak ${mib(bounded.peak.arrayBuffers)}; unbounded RSS ${mib(unbounded.baseline.rss)} → ${mib(unbounded.peak.rss)} (+${mib(unbounded.growth)}), arrayBuffers peak ${mib(unbounded.peak.arrayBuffers)}`,
    );
    expect(bounded.statuses, "every bounded reader was answered").toEqual(
      Array.from({ length: READERS }, () => 200),
    );
    expect(unbounded.statuses, "every unbounded reader was answered").toEqual(
      Array.from({ length: READERS }, () => 200),
    );
    expect(bounded.growth, "bounded forwards stay under the ceiling").toBeLessThan(CEILING);
    expect(unbounded.growth, "the unbounded negative control passes it").toBeGreaterThan(CEILING);
  }, 600_000);
});
