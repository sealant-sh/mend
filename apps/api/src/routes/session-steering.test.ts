import { afterEach, describe, expect, it } from "vitest";

import { createRouteHarness, type RouteHarness } from "../../test/support/route-harness.ts";

interface SessionRouteCase {
  readonly name: string;
  readonly path: string;
  readonly missingPath: string;
  readonly method: "POST" | "DELETE";
  readonly body?: unknown;
  readonly expectedCalls: ReadonlyArray<string>;
  readonly nonOwnerCanCall?: true;
}

const pngBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");

const cases: ReadonlyArray<SessionRouteCase> = [
  {
    name: "submitTurn",
    path: "/api/sessions/session-alice/turns",
    missingPath: "/api/sessions/missing/turns",
    method: "POST",
    body: { input: "Continue" },
    expectedCalls: ["engine.submitTurn"],
  },
  {
    name: "pasteImage",
    path: "/api/sessions/session-alice/images",
    missingPath: "/api/sessions/missing/images",
    method: "POST",
    body: { contentsBase64: pngBase64 },
    expectedCalls: ["projects.byId"],
  },
  {
    name: "interruptTurn",
    path: "/api/turns/turn-alice/interrupt",
    missingPath: "/api/turns/missing/interrupt",
    method: "POST",
    expectedCalls: ["engine.interruptTurn"],
  },
  {
    name: "respondAgentRequest",
    path: "/api/requests/request-alice/respond",
    missingPath: "/api/requests/missing/respond",
    method: "POST",
    body: { decision: "accept" },
    expectedCalls: ["engine.respondRequest"],
  },
  {
    name: "openShell",
    path: "/api/sessions/session-alice/shell",
    missingPath: "/api/sessions/missing/shell",
    method: "POST",
    expectedCalls: ["engine.openShell"],
  },
  {
    name: "stopShell",
    path: "/api/processes/process-alice/stop",
    missingPath: "/api/processes/missing/stop",
    method: "POST",
    expectedCalls: ["engine.stopShell"],
  },
  {
    name: "renameShell",
    path: "/api/processes/process-alice/label",
    missingPath: "/api/processes/missing/label",
    method: "POST",
    body: { label: "tools" },
    expectedCalls: ["engine.renameShell"],
  },
  {
    name: "addService",
    path: "/api/sessions/session-alice/services",
    missingPath: "/api/sessions/missing/services",
    method: "POST",
    body: { port: 3000, name: "web" },
    expectedCalls: ["engine.addService"],
  },
  {
    name: "runService",
    path: "/api/sessions/session-alice/services/run",
    missingPath: "/api/sessions/missing/services/run",
    method: "POST",
    body: { argv: ["pnpm", "dev"], port: 3000, name: "web" },
    expectedCalls: ["engine.runService"],
  },
  {
    name: "runServiceRecipe",
    path: "/api/sessions/session-alice/services/recipe",
    missingPath: "/api/sessions/missing/services/recipe",
    method: "POST",
    body: { name: "web" },
    expectedCalls: ["engine.runServiceRecipe"],
  },
  {
    name: "restartService",
    path: "/api/services/service-alice/restart",
    missingPath: "/api/services/missing/restart",
    method: "POST",
    expectedCalls: ["engine.restartService"],
  },
  {
    name: "stopService",
    path: "/api/services/service-alice/stop",
    missingPath: "/api/services/missing/stop",
    method: "POST",
    expectedCalls: ["engine.stopService"],
  },
  {
    name: "remove",
    path: "/api/sessions/session-alice",
    missingPath: "/api/sessions/missing",
    method: "DELETE",
    expectedCalls: ["projects.byId", "repo.remove"],
  },
  {
    name: "label",
    path: "/api/sessions/session-alice/label",
    missingPath: "/api/sessions/missing/label",
    method: "POST",
    body: { label: "Owner label" },
    expectedCalls: ["repo.setLabel"],
  },
  {
    name: "stop",
    path: "/api/sessions/session-alice/stop",
    missingPath: "/api/sessions/missing/stop",
    method: "POST",
    expectedCalls: ["engine.stop"],
  },
  {
    name: "checkpoint",
    path: "/api/sessions/session-alice/checkpoints",
    missingPath: "/api/sessions/missing/checkpoints",
    method: "POST",
    body: { trigger: "user-mark" },
    expectedCalls: ["engine.checkpointNow"],
    nonOwnerCanCall: true,
  },
  {
    name: "handoff",
    path: "/api/sessions/session-alice/handoff",
    missingPath: "/api/sessions/missing/handoff",
    method: "POST",
    body: { to: "pty" },
    expectedCalls: ["engine.handoff"],
  },
  {
    name: "resume",
    path: "/api/sessions/session-alice/resume",
    missingPath: "/api/sessions/missing/resume",
    method: "POST",
    body: { harness: null },
    expectedCalls: ["engine.resumeSession"],
  },
  {
    name: "launch",
    path: "/api/sessions/session-alice/launch",
    missingPath: "/api/sessions/missing/launch",
    method: "POST",
    body: { argv: ["codex"] },
    expectedCalls: ["engine.launch"],
  },
  {
    name: "followUpDeliver",
    path: "/api/sessions/session-alice/follow-up/deliver",
    missingPath: "/api/sessions/missing/follow-up/deliver",
    method: "POST",
    body: {
      reviewSliceId: "slice-route-harness",
      checkpointAId: "checkpoint-a",
      checkpointBId: "checkpoint-b",
      diffDigest: "0".repeat(64),
      commentIds: [],
      instruction: "Address the review",
      idempotencyKey: "delivery-key",
    },
    expectedCalls: ["followUp.deliver"],
  },
];

const requestInit = (testCase: SessionRouteCase): RequestInit => ({
  method: testCase.method,
  ...(testCase.body === undefined ? {} : { body: JSON.stringify(testCase.body) }),
});

let harness: RouteHarness | null = null;

afterEach(async () => {
  if (harness !== null) await harness.dispose();
  harness = null;
});

describe.each(cases)("$name session-owner authorization", (testCase) => {
  it(
    testCase.nonOwnerCanCall === true
      ? "allows a non-owner to use this non-steering operation"
      : "refuses a non-owner before any effect",
    async () => {
      harness = await createRouteHarness();

      const response = await harness.request("bob", testCase.path, requestInit(testCase));

      if (testCase.nonOwnerCanCall === true) {
        expect(response.status).toBeGreaterThanOrEqual(200);
        expect(response.status).toBeLessThan(300);
        expect(harness.effects.calls).toEqual(testCase.expectedCalls);
        return;
      }

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        _tag: "SessionNotSteerable",
        sessionId: "session-alice",
        message: "only the session owner can steer this session",
      });
      expect(harness.effects.calls).toEqual([]);
    },
  );

  it("returns 404 for an unknown resource before any effect", async () => {
    harness = await createRouteHarness();

    const response = await harness.request("alice", testCase.missingPath, requestInit(testCase));

    expect(response.status).toBe(404);
    expect(harness.effects.calls).toEqual([]);
  });

  it("lets the owner call the operation and records the expected effect", async () => {
    harness = await createRouteHarness();

    const response = await harness.request("alice", testCase.path, requestInit(testCase));

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(harness.effects.calls).toEqual(testCase.expectedCalls);
  });
});

describe("legacy null-owner fallback", () => {
  it("lets the first user steer", async () => {
    harness = await createRouteHarness();

    const response = await harness.request("alice", "/api/sessions/session-fallback/turns", {
      method: "POST",
      body: JSON.stringify({ input: "Continue" }),
    });

    expect(response.status).toBe(200);
    expect(harness.effects.calls).toEqual(["engine.submitTurn"]);
  });

  it("refuses another user before any effect", async () => {
    harness = await createRouteHarness();

    const response = await harness.request("bob", "/api/sessions/session-fallback/turns", {
      method: "POST",
      body: JSON.stringify({ input: "Continue" }),
    });

    expect(response.status).toBe(403);
    expect(harness.effects.calls).toEqual([]);
  });

  it("memoizes the first user after a non-null lookup", async () => {
    harness = await createRouteHarness();
    const request = {
      method: "POST",
      body: JSON.stringify({ input: "Continue" }),
    };

    expect(
      (await harness.request("alice", "/api/sessions/session-fallback/turns", request)).status,
    ).toBe(200);
    expect(
      (await harness.request("alice", "/api/sessions/session-fallback/turns", request)).status,
    ).toBe(200);

    expect(harness.diagnostics.firstUserIdCalls()).toBe(1);
    expect(harness.effects.calls).toEqual(["engine.submitTurn", "engine.submitTurn"]);
  });
});

describe("raw steering routes", () => {
  interface DisclosureCase {
    readonly name: string;
    readonly path: string;
    readonly ownerConflict: string;
  }

  const disclosureCases: ReadonlyArray<DisclosureCase> = [
    {
      name: "PTY process protocol",
      path: "/api/tty?process=process-protocol-alice",
      ownerConflict: "protocol agents use the structured conversation API",
    },
    {
      name: "PTY session protocol",
      path: "/api/tty?session=session-alice",
      ownerConflict: "protocol agents use the structured conversation API",
    },
    {
      name: "Service tunnel UDP transport",
      path: "/api/service-tunnel?service=service-udp-alice",
      ownerConflict: "UDP Services have no connection to tunnel",
    },
  ];

  it.each(disclosureCases)("authorizes before disclosing the $name conflict", async (testCase) => {
    harness = await createRouteHarness();

    const refused = await harness.rawRequest("bob", testCase.path);

    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("forbidden");
    expect(harness.effects.calls).toEqual([]);

    const owner = await harness.rawRequest("alice", testCase.path);

    expect(owner.status).toBe(409);
    expect(await owner.text()).toBe(testCase.ownerConflict);
    expect(harness.effects.calls).toEqual([]);
  });

  it("returns 404 for an unknown PTY process without a Sealant call", async () => {
    harness = await createRouteHarness();

    const response = await harness.rawRequest("alice", "/api/tty?process=missing");

    expect(response.status).toBe(404);
    expect(harness.effects.calls).toEqual([]);
  });

  it("returns 404 for an unknown PTY session without a Sealant call", async () => {
    harness = await createRouteHarness();

    const response = await harness.rawRequest("alice", "/api/tty?session=missing");

    expect(response.status).toBe(404);
    expect(harness.effects.calls).toEqual([]);
  });

  it("returns 404 for an unknown Service without a Sealant call", async () => {
    harness = await createRouteHarness();

    const response = await harness.rawRequest("alice", "/api/service-tunnel?service=missing");

    expect(response.status).toBe(404);
    expect(harness.effects.calls).toEqual([]);
  });

  it("returns 404 when a Service's session is missing without a Sealant call", async () => {
    harness = await createRouteHarness();
    harness.seed.service({ id: "orphan-service", sessionId: "missing" });

    const response = await harness.rawRequest(
      "alice",
      "/api/service-tunnel?service=orphan-service",
    );

    expect(response.status).toBe(404);
    expect(harness.effects.calls).toEqual([]);
  });
});
