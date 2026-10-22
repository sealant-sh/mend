import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { BoundClient } from "./handoff-client.js";
import { HandoffSubmission } from "./handoff-submit.js";
import { uploadMendBundle } from "./mend-http.js";
import { bundle, fakeHandoff, project, receipt, summary, terms } from "./test-handoff.js";

const closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});
const serve = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  closing.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No local listener");
  return `http://127.0.0.1:${address.port}`;
};
const answer = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const bound = (url: string) =>
  new BoundClient(
    { url, token: "test-token" },
    async () => ({ url, token: "test-token" }),
    () => undefined,
  );

const as = (token: string) =>
  new BoundClient(
    { url: "https://mend.example", token },
    async () => ({ url: "https://mend.example", token }),
    () => undefined,
  );
describe("a bound client's account", () => {
  it("separates two accounts on one host without holding the token in the key", () => {
    expect(as("dana-token").label).toBe(as("sam-token").label);
    expect(as("dana-token").account).not.toBe(as("sam-token").account);
    expect(as("dana-token").account).toBe(as("dana-token").account);
    expect(as("dana-token").account).not.toContain("dana-token");
  });
});
describe("raw handoff HTTP", () => {
  it("streams the exact bytes with auth, length and hold; finish precedes receipt", async () => {
    const body = Buffer.from([0, 1, 127, 255, 10]);
    const progress: string[] = [];
    const seen: { path?: string; headers?: IncomingMessage["headers"]; body?: Buffer } = {};
    const url = await serve((req, res) => {
      seen.path = req.url ?? "";
      seen.headers = req.headers;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.body = Buffer.concat(chunks);
        answer(res, 200, receipt());
      });
    });
    const { Readable } = await import("node:stream");
    const result = await bound(url).receiveBranchHandoff(
      project.id,
      { bytes: body.length, open: () => Readable.from([body]) },
      () => {
        progress.push("finished");
      },
    );
    progress.push("received");
    expect(result.kind).toBe("received");
    expect(seen).toMatchObject({
      path: "/api/projects/p1/handoffs?harness=claude&hold=true",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/x-git-bundle",
        accept: "application/json",
        "content-length": "5",
      },
      body,
    });
    expect(progress).toEqual(["finished", "received"]);
  });
  it("retries a dropped admitted response with identical bytes, then gets one replay receipt", async () => {
    const bodies: Buffer[] = [];
    const url = await serve((req, res) => {
      if (req.method === "GET") {
        answer(
          res,
          200,
          req.url === "/api/projects"
            ? [project]
            : req.url?.includes("handoffs")
              ? terms
              : { session: receipt().session, processes: [], currentAgent: null, change: null },
        );
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks));
        if (bodies.length === 1) res.destroy();
        else answer(res, 200, { ...receipt(), replayed: true });
      });
    });
    const f = fakeHandoff();
    const operation = new HandoffSubmission(
      { ...f.accepted, client: bound(url) },
      {
        launches: { launch: async () => undefined },
        record: () => undefined,
        progress: () => undefined,
      },
    );
    expect((await operation.run()).kind).toBe("done");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    await operation.dispose();
  });
  it.each([
    [413, { budget: "bodyBytes", limit: 8 }, "unsupported"],
    [413, { budget: "bundleBytes", limit: 8 }, "bundle-too-large"],
    [413, "proxy limit", "proxy-too-small"],
    [
      422,
      { _tag: "HandoffRefused", reason: "store-co-located", message: "Co-located store" },
      "refused",
    ],
    [429, { _tag: "BudgetExceeded", budget: "handoffsInFlight", limit: 1 }, "refused"],
    [401, { _tag: "Unauthorized" }, "signed-out"],
  ])("classifies %s as %s without retrying refusals", async (status, body, kind) => {
    const url = await serve((_req, res) => answer(res, status, body));
    expect(
      await bound(url).receiveBranchHandoff(project.id, bundle(), () => undefined),
    ).toMatchObject({ kind: "refused", issue: { kind } });
  });
  it.each([502, 503, 504, 200])(
    "treats %s without a readable receipt as uncertain",
    async (status) => {
      const url = await serve((_req, res) => {
        res.writeHead(status);
        res.end("<html>edge</html>");
      });
      expect(await bound(url).receiveBranchHandoff(project.id, bundle(), () => undefined)).toEqual({
        kind: "unconfirmed",
      });
    },
  );
  it("reads a refusal the server sends before it has read a large body", async () => {
    const url = await serve((req, res) => {
      res.writeHead(413, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ _tag: "PayloadTooLarge", message: "Too large" }));
      req.socket.destroy();
    });
    const { Readable } = await import("node:stream");
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const answered = await uploadMendBundle(
      { url, token: "test-token" },
      "/projects/p1/handoffs",
      {
        bytes: 64 * chunk.length,
        open: () => Readable.from(Array.from({ length: 64 }, () => chunk)),
      },
      () => undefined,
    );
    expect(answered.status).toBe(413);
  });
  it("bounds silence and never follows a redirect with the bearer", async () => {
    const requests: string[] = [];
    const url = await serve((req, res) => {
      requests.push(req.url ?? "");
      if (req.url === "/api/redirect") {
        res.writeHead(307, { location: "/api/stolen" });
        res.end();
      }
    });
    const connection = { url, token: "test-token" };
    expect(
      (await uploadMendBundle(connection, "/silent", bundle(), () => undefined, 20)).status,
    ).toBeNull();
    expect(
      (await uploadMendBundle(connection, "/redirect", bundle(), () => undefined)).status,
    ).toBe(307);
    expect(requests).not.toContain("/api/stolen");
  });
  it("binds the first launch and Retry to the same account, stopping after a 401", async () => {
    const auth: Array<string | undefined> = [];
    let signedOut = false;
    const url = await serve((req, res) => {
      auth.push(req.headers.authorization);
      answer(res, signedOut ? 401 : 200, receipt().session);
    });
    let current = { url, token: "first" };
    const client = new BoundClient(
      current,
      async () => current,
      () => undefined,
    );
    current = { url: "http://unused.invalid", token: "second" };
    expect(await client.isCurrent()).toBe(false);
    await client.launchSession("s1", { mode: "pty", prompt: "one" });
    signedOut = true;
    await expect(client.launchSession("s1", { mode: "pty", prompt: "two" })).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      client.launchSession("s1", { mode: "pty", prompt: "three" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(auth).toEqual(["Bearer first", "Bearer first"]);
  });
  it.each([
    [404, "Not found", "unsupported"],
    [404, { _tag: "NotFound" }, "supported"],
    [404, { _tag: "ProxyNotFound" }, "unavailable"],
    [422, { _tag: "HandoffRefused" }, "supported"],
    [200, terms, "supported"],
    [200, { fileBytes: -1, bundleBytes: 10 }, "unavailable"],
    [200, "proxy", "unavailable"],
    [401, null, "unavailable"],
    [503, null, "unavailable"],
  ])("probes support from %s %j", async (status, body, support) => {
    const url = await serve((_req, res) => answer(res, status, body));
    expect(await bound(url).support()).toBe(support);
  });
  it("rejects a malformed or mismatched provenance receipt as uncertain", async () => {
    const bad = receipt();
    const url = await serve((_req, res) =>
      answer(res, 200, {
        ...bad,
        worktree: {
          ...bad.worktree,
          handoff: { checkpoint: summary.worktree, machine: "", cutAt: "yesterday" },
        },
      }),
    );
    expect(await bound(url).receiveBranchHandoff(project.id, bundle(), () => undefined)).toEqual({
      kind: "unconfirmed",
    });
  });
});
