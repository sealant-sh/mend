import { lookup } from "node:dns/promises";

import { afterEach, describe, expect, it } from "vitest";

import { type EchoedHeaders, spawnFixture } from "./fixtures/preview/apps.ts";
import { APP_URL, previewSignIn, startGateway } from "./support/preview-acceptance-world.ts";
import { type BrowserKind, launchBrowser } from "./support/preview-browser.ts";
import { createPreviewDatabase } from "./support/preview-database.ts";
import { freePort } from "./support/preview-gateway-world.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const next of disposers.splice(0).toReversed()) await next();
});

const report = (line: string) => process.stderr.write(`${line}\n`);

const isEchoedHeaders = (value: unknown): value is EchoedHeaders =>
  typeof value === "object" && value !== null && "headers" in value && "rawHeaders" in value;

const signedIn = async (kind: BrowserKind, tag: string) => {
  const database = await createPreviewDatabase(`${tag}_${kind}`);
  disposers.push(database.drop);
  const port = await freePort();
  const options = {
    databaseUrl: database.url,
    routing: { mode: "loopback-http" as const, port },
    port,
    localPorts: { web: await freePort(), docs: await freePort() },
  };
  const gateway = await startGateway(options);
  disposers.push(gateway.close);
  const app = await spawnFixture("all", options.localPorts.web);
  disposers.push(app.stop);
  const signIn = previewSignIn(database.url, options.routing, database.previews);
  disposers.push(signIn.dispose);
  const web = signIn.originOf(database.previews.web.id);
  const resolved = await lookup(new URL(web).hostname, { all: true }).catch(() => []);
  report(
    `${kind}: this machine's resolver gives ${new URL(web).hostname} ${resolved.map(({ address }) => address).join(", ") || "nothing"}; the gateway listens on 127.0.0.1 only`,
  );
  const browser = await launchBrowser(kind);
  disposers.push(() => browser.close());
  report(`${kind}: ${browser.version()}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  const opened = await page.goto(await signIn.authUrl("carol", "web", "/echo-headers"));
  expect(page.url()).toBe(`${web}/echo-headers`);
  expect(opened?.status()).toBe(200);
  return {
    context,
    page,
    opened,
    web,
    docs: signIn.originOf(database.previews.docs.id),
    docsId: database.previews.docs.id,
  };
};

describe.each<BrowserKind>(["chromium", "firefox"])("a *.localhost preview in %s", (kind) => {
  it("signs in through a real ticket and keeps the grant host-only, HttpOnly, Lax and not Secure", async () => {
    const { context, page, opened, web } = await signedIn(kind, "browser_grant");
    const echoed: unknown = await opened?.json();
    if (!isEchoedHeaders(echoed)) throw new Error("the app did not echo its request headers");
    const sentFetchMetadata = Object.keys(echoed.headers)
      .filter((name) => name.startsWith("sec-fetch-"))
      .toSorted();
    const secure = await page.evaluate(() => window.isSecureContext);
    report(
      `${kind}: window.isSecureContext ${String(secure)} on ${web}; Sec-Fetch-* that reached the app: ${sentFetchMetadata.join(", ") || "none"}`,
    );
    const cookies = await context.cookies();
    expect(
      cookies.map(({ name, domain, path, httpOnly, sameSite, secure: isSecure }) => ({
        name,
        domain,
        path,
        httpOnly,
        sameSite,
        secure: isSecure,
      })),
    ).toEqual([
      {
        name: "mend-preview",
        domain: new URL(web).hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
      },
    ]);
  });

  it("sends a second label no grant, and a navigation there to Mend's sign-in", async () => {
    const { context, page, docs, docsId } = await signedIn(kind, "browser_sibling");
    expect(await context.cookies(docs)).toEqual([]);
    const signInAt = `${APP_URL}/preview-auth?preview=${encodeURIComponent(docsId)}&path=%2Fpricing`;
    const answered = page.waitForResponse((response) => response.url() === `${docs}/pricing`);
    const followed = page.waitForRequest((request) => request.url() === signInAt);
    await page.goto(`${docs}/pricing`).catch(() => null);
    const answer = await answered;
    expect([answer.status(), answer.headers()["location"]]).toEqual([302, signInAt]);
    expect(await answer.request().headerValue("cookie")).toBeNull();
    await followed;
    report(
      `${kind}: ${docs}/pricing with no grant answered 302 to Mend's /preview-auth, and the browser followed it`,
    );
  });
});
