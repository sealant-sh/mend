import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const sessionId = "8b1c3a52-7e0f-4c1e-9a6d-2f4b5c6d7e8f";
const alice = "user-alice";

const organizationOf = (userId: string) => ({
  organization: {
    id: "org-test",
    name: "Test",
    createdByUserId: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  },
  userId,
  role: "member",
  memberCount: 2,
  operator: false,
  tenancy: "single",
  mountDelivery: "bind",
});

/**
 * An API where `signedIn` is signed in and every other request is refused with `refusal`, as a
 * 409 unless `status` says otherwise. It keeps what it was sent.
 */
const startApi = async (
  refusal: Record<string, unknown> = {
    _tag: "NothingUnsaved",
    sessionId,
    message: "Nothing is waiting to be saved.",
  },
  signedIn = alice,
  /** Paths answered 200 with these bodies instead of the refusal. */
  answers: Record<string, unknown> = {},
  status = 409,
) => {
  const requests: Array<{ readonly path: string | undefined; readonly body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ path: request.url, body });
      if (request.url === "/api/organization") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(organizationOf(signedIn)));
        return;
      }
      const answer = request.url === undefined ? undefined : answers[request.url];
      if (answer !== undefined) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(answer));
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(refusal));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No API address");
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeAllConnections();
      }),
  };
};

describe("sessions router", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeEach(async () => {
    api = await startApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it("sends the owner's discard to the API as the contract's request class", async () => {
    // A plain `{ confirm }` object fails the client's encode before any request leaves, and the
    // page's "Discard unsaved and stop…" answered 500 every time (RC 0.36.0-next.754, E-F1).
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/sessions.discardUnsaved", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({ json: { id: sessionId } }),
      }),
    );

    expect(api.requests).toEqual([
      {
        path: `/api/sessions/${sessionId}/discard-unsaved`,
        body: JSON.stringify({ confirm: "discard unsaved" }),
      },
    ]);
    // The API's refusal crosses as its own status and words, not as an internal error.
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Nothing is waiting to be saved.");
  });

  it("reads what Stop session would do, naming the session that keeps the workspace running", async () => {
    const other = "4f2e9d1c-3b7a-4c5e-8d6f-1a2b3c4d5e6f";
    const preview = {
      sessionId,
      workspace: "keeps-running",
      runningSessions: [
        {
          sessionId: other,
          title: "Write tests for retry",
          harness: "codex",
          status: "running",
          ownerUserId: "user-ada",
          ownerName: "Ada Lovelace",
        },
      ],
      services: [
        { serviceId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f", sessionId, name: "api", port: 8080 },
      ],
      observedAt: "2026-11-18T10:00:00.000Z",
    };
    await api.close();
    api = await startApi(undefined, alice, {
      [`/api/sessions/${sessionId}/stop-preview`]: preview,
    });
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const input = encodeURIComponent(JSON.stringify({ json: { id: sessionId } }));
    const response = await handle(
      new Request(`http://internal-web.invalid/trpc/sessions.stopPreview?input=${input}`, {
        headers: { origin, cookie: "test-cookie=credential" },
      }),
    );

    expect(api.requests).toEqual([{ path: `/api/sessions/${sessionId}/stop-preview`, body: "" }]);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      result: {
        data: {
          json: {
            workspace: "keeps-running",
            runningSessions: [
              { sessionId: other, title: "Write tests for retry", ownerName: "Ada Lovelace" },
            ],
            services: [{ name: "api", port: 8080 }],
          },
        },
      },
    });
  });

  it("grants one person's ask and answers who holds shared control now (docs/adr/0026)", async () => {
    const answer = {
      sessionId,
      ownerUserId: alice,
      everyoneSince: null,
      granted: [
        {
          userId: "user-ada",
          state: "granted",
          askedAt: "2026-11-18T10:52:00.000Z",
          grantedAt: "2026-11-18T10:53:00.000Z",
          grantedByUserId: alice,
        },
      ],
      asked: [],
      steer: true,
      acts: { ask: false, withdraw: false, decide: true, takeBack: true },
      turnsOnSendersLogin: true,
    };
    await api.close();
    api = await startApi(undefined, alice, {
      [`/api/sessions/${sessionId}/shared-control/people/user-ada/grant`]: answer,
    });
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/sessions.grantSharedControl", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({ json: { id: sessionId, userId: "user-ada" } }),
      }),
    );

    expect(api.requests).toEqual([
      { path: `/api/sessions/${sessionId}/shared-control/people/user-ada/grant`, body: "" },
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        data: {
          json: { granted: [{ userId: "user-ada", state: "granted" }], acts: { decide: true } },
        },
      },
    });
  });

  it("a grant of an ask already withdrawn reaches the browser with its reason", async () => {
    const words = "There is no open ask from this person: it was withdrawn or already answered.";
    await api.close();
    api = await startApi({
      _tag: "SharedControlRefused",
      sessionId,
      reason: "not-asked",
      message: words,
    });
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/sessions.grantSharedControl", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({ json: { id: sessionId, userId: "user-ada" } }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        json: {
          message: words,
          data: { tag: "SharedControlRefused", sharedControl: { reason: "not-asked" } },
        },
      },
    });
  });

  it("a message refused for the sender's expired login names the login to connect again", async () => {
    const words =
      "Your Claude login needs reconnecting. Reconnect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.";
    await api.close();
    api = await startApi(
      {
        _tag: "SessionNotSteerable",
        sessionId,
        message: words,
        login: { provider: "claude", state: "invalid" },
      },
      alice,
      {},
      403,
    );
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/sessions.sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({
          json: {
            id: sessionId,
            input: "skip 410s on replay",
            clientMessageId: "0d6f3c1a-2b4e-4f6a-9c8d-7e5f4a3b2c1d",
            expectedUserId: alice,
          },
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        json: {
          message: words,
          data: {
            tag: "SessionNotSteerable",
            sharedControl: { login: { provider: "claude", state: "invalid" } },
          },
        },
      },
    });
  });

  it("forwards a message's words and key, and its refusal reaches the browser in words", async () => {
    const words =
      "You have two running turns in this session; Mend cannot tell which one to steer.";
    await api.close();
    api = await startApi({ _tag: "MessageTargetAmbiguous", sessionId, message: words });
    const clientMessageId = "0d6f3c1a-2b4e-4f6a-9c8d-7e5f4a3b2c1d";
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/sessions.sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({
          json: {
            id: sessionId,
            input: "also check the migrations",
            clientMessageId,
            expectedUserId: alice,
          },
        }),
      }),
    );

    expect(api.requests).toEqual([
      { path: "/api/organization", body: "" },
      {
        path: `/api/sessions/${sessionId}/messages`,
        body: JSON.stringify({ input: "also check the migrations", clientMessageId }),
      },
    ]);
    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      error: { json: { message: words, data: { tag: "MessageTargetAmbiguous" } } },
    });
  });

  it("forwards nothing when another account is signed in than the one who wrote the message", async () => {
    await api.close();
    api = await startApi(undefined, "user-bob");
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/sessions.sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({
          json: {
            id: sessionId,
            input: "Alice private words",
            clientMessageId: "0d6f3c1a-2b4e-4f6a-9c8d-7e5f4a3b2c1d",
            expectedUserId: alice,
          },
        }),
      }),
    );

    expect(api.requests).toEqual([{ path: "/api/organization", body: "" }]);
    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      error: {
        json: {
          message: "another account is signed in now · this message was not sent",
          data: { tag: "MessageAuthorChanged" },
        },
      },
    });
  });

  it("sends the next turn's model, thinking, speed and permission with the message", async () => {
    const selection = {
      harness: "claude",
      model: "opus",
      effort: "high",
      interactionMode: "default",
      speed: "fast",
      permissionMode: "ask",
    };
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    await handle(
      new Request("http://internal-web.invalid/trpc/sessions.sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({
          json: { id: sessionId, input: "carry on", selection, expectedUserId: alice },
        }),
      }),
    );

    const sent = api.requests.find((request) => request.path?.endsWith("/messages"));
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ input: "carry on", selection });
  });

  it("stops a turn through its interrupt, and a refusal reaches the browser in words", async () => {
    const turnId = "turn-7";
    const words = "The conversation's agent isn't running.";
    await api.close();
    api = await startApi({
      _tag: "ProtocolSessionNotLive",
      processId: "process-1",
      message: words,
    });
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/sessions.interruptTurn", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({ json: { turnId } }),
      }),
    );

    expect(api.requests).toEqual([{ path: `/api/turns/${turnId}/interrupt`, body: "" }]);
    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ error: { json: { data: { tag: "ProtocolSessionNotLive" } } } });
  });
});
