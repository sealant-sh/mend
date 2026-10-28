import * as https from "node:https";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { spawnFixture } from "./fixtures/preview/apps.ts";
import {
  type AcceptanceGatewayOptions,
  type PreviewSignIn,
  previewSignIn,
  startGateway,
} from "./support/preview-acceptance-world.ts";
import { createPreviewDatabase } from "./support/preview-database.ts";
import {
  type EdgeKind,
  type ErrorLogLevel,
  type RunningEdge,
  startEdge,
  sweepEdges,
} from "./support/preview-edge.ts";
import { freePort } from "./support/preview-gateway-world.ts";

const DOMAIN = "preview.localhost";
const APP_QUERY = "SYNAPPQUERY";
const REFERER = "https://elsewhere.invalid/page?ticket=SYNREFERER";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const next of disposers.splice(0).toReversed()) await next();
});
afterAll(sweepEdges);

const report = (line: string) => process.stderr.write(`${line}\n`);

interface Stage {
  readonly edge: RunningEdge;
  readonly signIn: PreviewSignIn;
  readonly options: AcceptanceGatewayOptions;
}

const stage = async (tag: string, kind: EdgeKind, errorLevel: ErrorLogLevel): Promise<Stage> => {
  const database = await createPreviewDatabase(tag);
  disposers.push(database.drop);
  const port = await freePort();
  const edge = await startEdge(kind, {
    upstreamPort: port,
    domain: DOMAIN,
    logged: { errorLevel },
  });
  disposers.push(edge.stop);
  report(`${kind}: ${edge.image} (${edge.version})`);
  const options: AcceptanceGatewayOptions = {
    databaseUrl: database.url,
    routing: { mode: "domain-https", domain: DOMAIN, port: edge.httpsPort },
    port,
    localPorts: { web: await freePort(), docs: await freePort() },
  };
  const signIn = previewSignIn(database.url, options.routing, database.previews);
  disposers.push(signIn.dispose);
  return { edge, signIn, options };
};

interface Answer {
  readonly status: number;
  readonly location: string | undefined;
  readonly cookies: ReadonlyArray<string>;
}

const navigate = (edge: RunningEdge, url: URL, cookies: ReadonlyArray<string>) =>
  new Promise<Answer>((resolve, reject) => {
    const outgoing = https.request({
      host: "127.0.0.1",
      port: edge.httpsPort,
      servername: url.hostname,
      ...(edge.ca === null ? {} : { ca: edge.ca }),
      path: `${url.pathname}${url.search}`,
      agent: false,
      headers: {
        host: url.host,
        accept: "text/html",
        referer: REFERER,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        ...(cookies.length === 0 ? {} : { cookie: cookies.join("; ") }),
      },
    });
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error(`${url.pathname} timed out`)));
    outgoing.on("error", reject);
    outgoing.on("response", (response) => {
      response.resume();
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          location: response.headers.location,
          cookies: (response.headers["set-cookie"] ?? []).map(
            (cookie) => cookie.split(";")[0] ?? "",
          ),
        }),
      );
    });
    outgoing.end();
  });

const walk = async (edge: RunningEdge, authUrl: string) => {
  const steps: Array<readonly [string, number]> = [];
  const cookies: Array<string> = [];
  let url = new URL(authUrl);
  for (let hop = 0; hop < 4; hop += 1) {
    const answer = await navigate(edge, url, cookies);
    steps.push([url.pathname, answer.status]);
    cookies.push(...answer.cookies);
    if (answer.location === undefined || answer.status < 300 || answer.status >= 400) break;
    url = new URL(answer.location, url);
  }
  return steps;
};

const leaksOf = (logs: string, ticket: string) =>
  logs
    .split("\n")
    .filter(
      (line) =>
        line.includes(ticket) ||
        line.includes("ticket=") ||
        line.includes(APP_QUERY) ||
        line.includes("SYNREFERER") ||
        line.includes("elsewhere.invalid"),
    );

const ticketOf = (authUrl: string) => {
  const ticket = new URL(authUrl).searchParams.get("ticket");
  if (ticket === null) throw new Error("the sign-in URL carries no ticket");
  return ticket;
};

const settled = async (edge: RunningEdge, enough: (logs: string) => boolean) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const logs = await edge.logs();
    if (enough(logs)) return logs;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return edge.logs();
};

describe.each<EdgeKind>(["caddy", "nginx"])("the %s edge's logs after a real sign-in", (kind) => {
  it("hold no ticket, query or Referer, and the sign-in reaches the app's own page", async () => {
    const at = await stage(`logs_${kind}`, kind, "error");
    const gateway = await startGateway(at.options);
    disposers.push(gateway.close);
    const app = await spawnFixture("all", at.options.localPorts.web);
    disposers.push(app.stop);
    const authUrl = await at.signIn.authUrl("carol", "web", `/private-dir/page?${APP_QUERY}=1`);
    const ticket = ticketOf(authUrl);
    expect(await walk(at.edge, authUrl)).toEqual([
      ["/__mend/auth", 303],
      ["/__mend/signed-in", 303],
      ["/private-dir/page", 200],
    ]);
    const logs = await settled(
      at.edge,
      (text) =>
        text.split("\n").filter((line) => line.includes(" 200 ") || line.includes('"status":200'))
          .length > 0,
    );
    const lines = logs.split("\n").filter((line) => line.includes("GET") || line.includes('"uri"'));
    report(
      `${kind}, a real sign-in: ${lines.length} access lines; ${leaksOf(logs, ticket).length} hold the ticket, a query or the Referer`,
    );
    for (const line of lines) report(`  ${line.slice(0, 400)}`);
    expect(leaksOf(logs, ticket)).toEqual([]);
    if (kind === "caddy") {
      const access = logs
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line): unknown => JSON.parse(line))
        .flatMap((entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "logger" in entry &&
          entry.logger === "http.log.access.preview" &&
          "request" in entry &&
          typeof entry.request === "object" &&
          entry.request !== null &&
          "uri" in entry.request
            ? [entry.request.uri]
            : [],
        );
      expect(access.length).toBeGreaterThanOrEqual(3);
      expect([...new Set(access)]).toEqual(["REDACTED"]);
    } else {
      for (const path of ["/__mend/auth", "/__mend/signed-in", "/private-dir/page"])
        expect(logs, path).toContain(`"GET ${path} HTTP/1.1"`);
    }
  });

  it("hold no ticket when the gateway refuses the dial during the exchange, at the documented level", async () => {
    const at = await stage(`refused_${kind}`, kind, "crit");
    const authUrl = await at.signIn.authUrl("carol", "web", "/");
    const ticket = ticketOf(authUrl);
    expect(await walk(at.edge, authUrl)).toEqual([["/__mend/auth", 502]]);
    const logs = await settled(at.edge, (text) => text.includes("502"));
    report(
      `${kind}, the gateway refusing the dial: ${leaksOf(logs, ticket).length} lines hold the ticket`,
    );
    for (const line of logs
      .split("\n")
      .filter((text) => text.includes("502") || text.includes("connect"))) {
      report(`  ${line.slice(0, 400)}`);
    }
    expect(leaksOf(logs, ticket)).toEqual([]);
  });
});

describe("nginx's error log at a default level", () => {
  it.each<readonly [ErrorLogLevel, string]>([
    ["error", "nginx's own default"],
    ["notice", "ingress-nginx's default, its controller ConfigMap's error-log-level"],
  ])(
    "at %s (%s), records the request line, ticket included, when the dial fails during the exchange",
    async (level) => {
      const at = await stage(`refused_nginx_${level}`, "nginx", level);
      const authUrl = await at.signIn.authUrl("carol", "web", "/");
      const ticket = ticketOf(authUrl);
      expect(await walk(at.edge, authUrl)).toEqual([["/__mend/auth", 502]]);
      const logs = await settled(at.edge, (text) => text.includes("connect() failed"));
      const holding = logs.split("\n").filter((line) => line.includes(ticket));
      report(
        `nginx, error_log at ${level}, the gateway refusing the dial: ${holding.length} line(s) hold the ticket`,
      );
      for (const line of holding)
        report(`  ${line.replaceAll(ticket, "<the ticket>").slice(0, 600)}`);
      // No log_format reaches the error log.
      expect(holding.length).toBeGreaterThan(0);
      expect(
        holding.every(
          (line) =>
            line.includes("connect() failed") &&
            line.includes('request: "GET /__mend/auth?ticket='),
        ),
      ).toBe(true);
    },
  );
});
