import { once } from "node:events";
import { createServer } from "node:http";

import { STANDARD_ACCESS_POLICY_RULES } from "@mend/domain/workbench";
import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** A fake API: records each request's method, path and body, and answers what the test set. */
const startApi = async () => {
  const seen: Array<{ method: string | undefined; path: string | undefined; body: unknown }> = [];
  let answer: Answer = { status: 200, body: {} };
  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: request.method,
        path: request.url,
        body: text === "" ? null : JSON.parse(text),
      });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No API address");
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    seen,
    answer: (next: Answer) => {
      answer = next;
    },
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

type Api = Awaited<ReturnType<typeof startApi>>;

/** One tRPC mutation through the web tier, as the browser sends it; the result's JSON side. */
const mutate = async (api: Api, path: string, input: unknown): Promise<unknown> => {
  const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
  const response = await handle(
    new Request(`http://internal-web.invalid/trpc/${path}`, {
      method: "POST",
      headers: { origin, cookie: "test-cookie=credential", "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    }),
  );
  const body: { readonly result?: { readonly data: { readonly json: unknown } } } =
    await response.json();
  return body.result?.data.json;
};

const policyJson = {
  id: "p-1",
  organizationId: "org-1",
  name: "Deploys",
  builtIn: false,
  revision: 2,
  rules: STANDARD_ACCESS_POLICY_RULES,
  elevated: false,
  createdAt: "2026-11-24T09:00:00.000Z",
  updatedAt: "2026-11-24T09:00:00.000Z",
};

describe("access policies router", () => {
  let api: Api;
  beforeEach(async () => {
    api = await startApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it("creates a policy and answers it as saved", async () => {
    api.answer({ status: 200, body: policyJson });
    const result = await mutate(api, "accessPolicies.create", {
      name: "Deploys",
      rules: STANDARD_ACCESS_POLICY_RULES,
    });
    expect(api.seen[0]).toMatchObject({
      method: "POST",
      path: "/api/organization/access-policies",
      body: { name: "Deploys" },
    });
    expect(result).toMatchObject({ ok: true, result: { id: "p-1", name: "Deploys" } });
  });

  it("hands a rejection's every problem to the dialog, not just its sentence", async () => {
    api.answer({
      status: 400,
      body: {
        _tag: "AccessPolicyRejected",
        message: "This policy was not saved: fix what is listed and save it again.",
        problems: ["allowHosts: `*.example.com` is a wildcard", "A policy needs a name."],
      },
    });
    const result = await mutate(api, "accessPolicies.create", {
      name: "",
      rules: STANDARD_ACCESS_POLICY_RULES,
    });
    expect(result).toEqual({
      ok: false,
      kind: "rejected",
      message: "This policy was not saved: fix what is listed and save it again.",
      problems: ["allowHosts: `*.example.com` is a wildcard", "A policy needs a name."],
    });
  });

  it("sends the revision an edit read, and answers a stale write with the revision now", async () => {
    api.answer({
      status: 409,
      body: {
        _tag: "AccessPolicyStaleWrite",
        policyId: "p-1",
        currentRevision: 3,
        message: "Someone changed this policy since you opened it.",
      },
    });
    const result = await mutate(api, "accessPolicies.update", {
      id: "p-1",
      request: { name: "Deploys", rules: STANDARD_ACCESS_POLICY_RULES, expectedRevision: 2 },
    });
    expect(api.seen[0]).toMatchObject({
      method: "PUT",
      path: "/api/organization/access-policies/p-1",
      body: { expectedRevision: 2 },
    });
    expect(result).toEqual({
      ok: false,
      kind: "stale",
      message: "Someone changed this policy since you opened it.",
      revision: 3,
    });
  });

  it("answers a name taken, Standard's refusal and a member's attempt in the server's words", async () => {
    api.answer({
      status: 409,
      body: { _tag: "AccessPolicyNameTaken", name: "Deploys", message: "Taken." },
    });
    expect(
      await mutate(api, "accessPolicies.create", {
        name: "Deploys",
        rules: STANDARD_ACCESS_POLICY_RULES,
      }),
    ).toEqual({ ok: false, kind: "name-taken", message: "Taken." });
    for (const [status, body, kind] of [
      [409, { _tag: "AccessPolicyBuiltIn", message: "Standard is built in." }, "built-in"],
      [
        403,
        { _tag: "AccessPolicyOwnersOnly", message: "Only an Organization Owner." },
        "owners-only",
      ],
    ] as const) {
      api.answer({ status, body });
      const result = await mutate(api, "accessPolicies.remove", { id: "p-1" });
      expect(result).toEqual({ ok: false, kind, message: body.message });
    }
  });

  it("revokes, and hands back each running workspace's answer", async () => {
    api.answer({
      status: 200,
      body: {
        revocation: {
          id: "r-1",
          organizationId: "org-1",
          policyId: null,
          kind: "host",
          target: "api.vercel.com",
          revokedByUserId: "u-1",
          revokedAt: "2026-11-24T09:00:00.000Z",
        },
        workspaces: [
          { workspaceId: "ws-1", enforcement: "enforced", message: null },
          { workspaceId: "ws-2", enforcement: "failed", message: "proxy unreachable" },
        ],
      },
    });
    const result = await mutate(api, "accessPolicies.revoke", {
      policyId: null,
      kind: "host",
      target: "api.vercel.com",
    });
    expect(api.seen[0]).toMatchObject({
      method: "POST",
      path: "/api/organization/access-policies/revocations",
      body: { policyId: null, kind: "host", target: "api.vercel.com" },
    });
    expect(result).toMatchObject({
      ok: true,
      result: { workspaces: [{ enforcement: "enforced" }, { enforcement: "failed" }] },
    });
  });

  it("keeps Apply updated policy's refusal word for word", async () => {
    const message =
      "A running workspace has no egress proxy to take the new rules. Stop the worktree's sessions, apply the policy, then start one.";
    api.answer({ status: 409, body: { _tag: "AccessPolicyNotApplied", message } });
    const result = await mutate(api, "accessPolicies.applyUpdated", { id: "wt-1" });
    expect(api.seen[0]).toMatchObject({
      method: "POST",
      path: "/api/worktrees/wt-1/access-policy/apply",
    });
    expect(result).toEqual({ ok: false, kind: "not-applied", message });
  });

  it("tells a member assigning an elevated policy that it takes an owner", async () => {
    api.answer({
      status: 403,
      body: { _tag: "AccessPolicyOwnersOnly", message: "This policy is elevated." },
    });
    const result = await mutate(api, "accessPolicies.assign", {
      projectId: "project-1",
      request: { policyId: "p-1" },
    });
    expect(api.seen[0]).toMatchObject({
      method: "PUT",
      path: "/api/projects/project-1/access-policy",
    });
    expect(result).toEqual({ ok: false, kind: "owners-only", message: "This policy is elevated." });
  });
});

describe("a secret's delivery", () => {
  let api: Api;
  beforeEach(async () => {
    api = await startApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it("creates a secret Brokered in one write", async () => {
    api.answer({
      status: 200,
      body: { secret: { id: "s-1", name: "VERCEL_TOKEN", revision: 1 }, revision: 4 },
    });
    await mutate(api, "environment.createSecret", {
      projectId: "project-1",
      request: {
        name: "VERCEL_TOKEN",
        value: "token-value",
        delivery: {
          mode: "brokered",
          binding: { headerName: "Authorization", bindHosts: ["api.vercel.com"] },
        },
      },
    });
    expect(api.seen[0]).toMatchObject({
      method: "POST",
      path: "/api/projects/project-1/secrets",
      body: {
        name: "VERCEL_TOKEN",
        delivery: { mode: "brokered", binding: { bindHosts: ["api.vercel.com"] } },
      },
    });
  });

  it("answers a binding's problems and an owner's gate as outcomes the dialog lays out", async () => {
    api.answer({
      status: 400,
      body: {
        _tag: "AccessPolicyRejected",
        message: "The secret was not made Brokered: fix what is listed and try again.",
        problems: ["bindHosts must name at least one host"],
      },
    });
    const input = {
      projectId: "project-1",
      secretId: "s-1",
      request: { delivery: { mode: "direct" }, expectedRevision: 1 },
    };
    expect(await mutate(api, "environment.setSecretDelivery", input)).toEqual({
      ok: false,
      kind: "binding",
      message: "The secret was not made Brokered: fix what is listed and try again.",
      problems: ["bindHosts must name at least one host"],
    });
    expect(api.seen[0]).toMatchObject({
      method: "PUT",
      path: "/api/projects/project-1/secrets/s-1/delivery",
    });
    api.answer({
      status: 403,
      body: {
        _tag: "AccessPolicyOwnersOnly",
        message: "Only an Organization Owner turns it back.",
      },
    });
    expect(await mutate(api, "environment.setSecretDelivery", input)).toEqual({
      ok: false,
      kind: "owners-only",
      message: "Only an Organization Owner turns it back.",
    });
  });
});
