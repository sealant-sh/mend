// @vitest-environment node
import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { awaitDeviceApproval, openDeviceRequest, type DeviceLoginDeps } from "./device-login";

const CLIENT = Date.parse("2026-10-13T12:00:00.000Z");
const APPROVED = {
  status: "approved",
  token: "mdt_loopback_synthetic",
  user: {
    id: "synthetic-user",
    name: "Fixture",
    email: "fixture@example.test",
  },
  device: { id: "synthetic-device", name: "Fixture desktop" },
};
const barrier = () => {
  let complete: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, release: () => complete?.() };
};
interface FixtureOptions {
  readonly serverNow: number;
  readonly expiresAt?: number | string;
  readonly expiresIn?: unknown;
  readonly date?: string | null;
  readonly headersDelay?: number;
  readonly bodyGate?: ReturnType<typeof barrier>;
  readonly pollGate?: ReturnType<typeof barrier>;
}
const withServer = async (
  options: FixtureOptions,
  work: (fixture: {
    readonly base: string;
    readonly deps: DeviceLoginDeps;
    readonly posts: string[];
    readonly headersReceived: Promise<void>;
    readonly pollReceived: Promise<void>;
    readonly advance: (ms: number) => void;
  }) => Promise<void>,
) => {
  let clock = CLIENT;
  const posts: string[] = [];
  const headers = barrier();
  const pollReceived = barrier();
  const server = createServer((request, response) => {
    request.resume();
    posts.push(request.url ?? "");
    response.sendDate = false;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/cli/auth") {
      clock += options.headersDelay ?? 0;
      const date =
        options.date === undefined ? new Date(options.serverNow).toUTCString() : options.date;
      if (date !== null) response.setHeader("date", date);
      response.writeHead(200);
      response.flushHeaders();
      const body = JSON.stringify({
        deviceCode: "device-code-synthetic",
        code: "ABCD2345",
        verifyPath: "/authorize?code=ABCD2345",
        intervalSeconds: 2,
        expiresAt:
          typeof options.expiresAt === "string"
            ? options.expiresAt
            : new Date(options.expiresAt ?? options.serverNow + 600_000).toISOString(),
        ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn }),
      });
      if (options.bodyGate === undefined) response.end(body);
      else void options.bodyGate.promise.then(() => response.end(body));
    } else if (request.url === "/api/cli/auth/token") {
      response.writeHead(200);
      response.flushHeaders();
      pollReceived.release();
      if (options.pollGate === undefined) response.end(JSON.stringify(APPROVED));
      else void options.pollGate.promise.then(() => response.end(JSON.stringify(APPROVED)));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  const deps: DeviceLoginDeps = {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      // The queued signal lets production consume the header receipt clock before the test
      // advances local time while the independently gated HTTP body is still pending.
      if (String(input).endsWith("/api/cli/auth")) queueMicrotask(headers.release);
      return response;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    name: "Fixture desktop",
  };
  try {
    await work({
      base,
      deps,
      posts,
      headersReceived: headers.promise,
      pollReceived: pollReceived.promise,
      advance: (ms) => {
        clock += ms;
      },
    });
  } finally {
    options.bodyGate?.release();
    options.pollGate?.release();
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
};

describe("desktop authorize expiry through actual HTTP responses", () => {
  for (const relative of [true, false])
    it(`approves a valid request with server two hours behind, relative=${relative}`, async () =>
      withServer(
        { serverNow: CLIENT - 7_200_000, ...(relative ? { expiresIn: 600 } : {}) },
        async ({ base, deps, posts }) => {
          const opened = await openDeviceRequest(base, deps);
          expect(opened.ok).toBe(true);
          if (!opened.ok) return;
          const result = await awaitDeviceApproval(
            base,
            opened.request,
            deps,
            () => false,
            opened.deadline,
          );
          expect({ result, posts }).toEqual({
            result: {
              ok: true,
              url: base,
              token: APPROVED.token,
              deviceId: APPROVED.device.id,
              deviceName: APPROVED.device.name,
              email: APPROVED.user.email,
            },
            posts: ["/api/cli/auth", "/api/cli/auth/token"],
          });
          expect(posts).toEqual(["/api/cli/auth", "/api/cli/auth/token"]);
          if (relative) expect(opened.request.expiresIn).toBe(600);
        },
      ));
  it("keeps relative expiry authoritative with a server clock ahead", async () =>
    withServer(
      { serverNow: CLIENT + 7_200_000, expiresIn: 3 },
      async ({ base, deps, posts, advance }) => {
        const opened = await openDeviceRequest(base, deps);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        advance(4_000);
        expect(
          await awaitDeviceApproval(base, opened.request, deps, () => false, opened.deadline),
        ).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
        expect(posts).toEqual(["/api/cli/auth"]);
      },
    ));
  it("does not extend a legacy request when the server clock is ahead", async () =>
    withServer(
      { serverNow: CLIENT + 7_200_000, expiresAt: CLIENT + 7_203_000 },
      async ({ base, deps, posts, advance }) => {
        const opened = await openDeviceRequest(base, deps);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        advance(4_000);
        expect(
          await awaitDeviceApproval(base, opened.request, deps, () => false, opened.deadline),
        ).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
        expect(posts).toEqual(["/api/cli/auth"]);
      },
    ));
  it("anchors expiry to header receipt, not body completion or a later wait", async () => {
    const gate = barrier();
    await withServer(
      { serverNow: CLIENT - 7_200_000, expiresIn: 20, headersDelay: 30_000, bodyGate: gate },
      async ({ base, deps, posts, headersReceived, advance }) => {
        const opening = openDeviceRequest(base, deps);
        await headersReceived;
        advance(5_000);
        gate.release();
        const opened = await opening;
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const expected = CLIENT + 50_000;
        expect(opened.deadline).toBe(expected);
        expect(opened.view.expiresAt).toBe(new Date(expected).toISOString());
        advance(15_000);
        expect(
          await awaitDeviceApproval(base, opened.request, deps, () => false, opened.deadline),
        ).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
        expect(posts).toEqual(["/api/cli/auth"]);
      },
    );
  });
  it("does not extend a legacy request already expired on the observed server clock", async () =>
    withServer(
      { serverNow: CLIENT - 7_200_000, expiresAt: CLIENT - 7_200_001 },
      async ({ base, deps, posts }) => {
        const opened = await openDeviceRequest(base, deps);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        expect(opened.deadline).toBe(CLIENT);
        expect(
          await awaitDeviceApproval(base, opened.request, deps, () => false, opened.deadline),
        ).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
        expect(posts).toEqual(["/api/cli/auth"]);
      },
    ));
  for (const date of [null, "unreadable"])
    it(`uses bounded legacy fallback with unusable Date=${date}`, async () =>
      withServer({ serverNow: CLIENT - 7_200_000, date }, async ({ base, deps, posts }) => {
        const opened = await openDeviceRequest(base, deps);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        expect(opened.deadline).toBe(CLIENT + 600_000);
        expect(
          await awaitDeviceApproval(base, opened.request, deps, () => false, opened.deadline),
        ).toMatchObject({ ok: true, token: APPROVED.token });
        expect(posts).toEqual(["/api/cli/auth", "/api/cli/auth/token"]);
      }));
  it("preserves the malformed-date bounded fallback", async () =>
    withServer({ serverNow: CLIENT, expiresAt: "unreadable" }, async ({ base, deps }) => {
      const opened = await openDeviceRequest(base, deps);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.deadline).toBe(CLIENT + 600_000);
      expect(
        await awaitDeviceApproval(base, opened.request, deps, () => false, opened.deadline),
      ).toMatchObject({ ok: true, token: APPROVED.token });
    }));
  for (const expiresIn of [
    -1,
    "600",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER,
  ])
    it(`invalid relative value ${expiresIn} does not override valid legacy Date evidence`, async () =>
      withServer({ serverNow: CLIENT - 7_200_000, expiresIn }, async ({ base, deps }) => {
        const opened = await openDeviceRequest(base, deps);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        expect(opened.deadline).toBe(CLIENT + 600_000);
        expect(
          await awaitDeviceApproval(base, opened.request, deps, () => false, opened.deadline),
        ).toMatchObject({ ok: true, token: APPROVED.token });
      }));
  for (const expiresIn of [0, 1])
    it(`starts no poll after the fixed deadline for expiresIn=${expiresIn}`, async () =>
      withServer(
        { serverNow: CLIENT, expiresAt: CLIENT + expiresIn * 1000, expiresIn },
        async ({ base, deps, posts }) => {
          const opened = await openDeviceRequest(base, deps);
          expect(opened.ok).toBe(true);
          if (!opened.ok) return;
          expect(
            await awaitDeviceApproval(base, opened.request, deps, () => false, opened.deadline),
          ).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
          expect(posts).toEqual(["/api/cli/auth"]);
        },
      ));
  it("keeps an authoritative approval from a poll already in flight when local expiry passes", async () => {
    const gate = barrier();
    await withServer(
      { serverNow: CLIENT, expiresAt: CLIENT + 3000, expiresIn: 3, pollGate: gate },
      async ({ base, deps, pollReceived, advance }) => {
        const opened = await openDeviceRequest(base, deps);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const waiting = awaitDeviceApproval(
          base,
          opened.request,
          deps,
          () => false,
          opened.deadline,
        );
        await pollReceived;
        advance(2000);
        gate.release();
        expect(await waiting).toMatchObject({ ok: true, token: APPROVED.token });
      },
    );
  });
  it("keeps the aligned-clock positive control", async () =>
    withServer({ serverNow: CLIENT }, async ({ base, deps, posts }) => {
      const opened = await openDeviceRequest(base, deps);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(
        await awaitDeviceApproval(base, opened.request, deps, () => false, opened.deadline),
      ).toMatchObject({ ok: true, token: APPROVED.token });
      expect(posts).toEqual(["/api/cli/auth", "/api/cli/auth/token"]);
    }));
});
