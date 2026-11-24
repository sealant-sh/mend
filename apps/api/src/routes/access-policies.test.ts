import {
  AccessPolicyBuiltInError,
  AccessPolicyNameTakenError,
  AccessPolicyNotFoundError,
  AccessPolicyStaleWriteError,
  type NewAuditEvent,
  standardAccessPolicy,
} from "@mend/db";
import { AccessPolicyId, type OrganizationId, type ProjectId, ProjectSecretId } from "@mend/domain";
import {
  AccessPolicy,
  type AccessPolicyRules,
  AccessRevocation,
  isElevatedAccessPolicy,
  type ProjectAccessPolicy,
  ProjectSecret,
  STANDARD_ACCESS_POLICY_ID,
  STANDARD_ACCESS_POLICY_RULES,
  ProjectEnvironmentSnapshot,
} from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, organizationIdOf } from "../../test/support/tenancy-harness.ts";
import { revocationProblems } from "./access-policies.ts";

const ORG_A = organizationIdOf("A");
const NOW = new Date("2026-11-24T10:00:00.000Z");

const RESTRICTED: AccessPolicyRules = {
  ...STANDARD_ACCESS_POLICY_RULES,
  mode: "restricted",
  allowHosts: [{ host: "registry.npmjs.org" }],
  gitTransport: "read-only",
};
/** Elevated: Brokered secrets reach the workspace. */
const BROKERED: AccessPolicyRules = { ...STANDARD_ACCESS_POLICY_RULES, allowBrokeredSecrets: true };

const SECRET = ProjectSecretId.make("secret-1");
const BINDING = { headerName: "Authorization", bindHosts: ["api.stripe.com"] };

/** What the fakes did, in order: shows a revocation is stored before it is pushed. */
const log: Array<string> = [];
const audits: Array<NewAuditEvent> = [];
const templates = new Map<string, AccessPolicy>();
const projectPolicies = new Map<string, ProjectAccessPolicy>();
const revocations: Array<AccessRevocation> = [];
const deliveries = new Map<
  string,
  {
    name: string;
    delivery: "direct" | "brokered";
    binding: { headerName: string; bindHosts: ReadonlyArray<string> } | null;
  }
>();

const template = (
  id: string,
  name: string,
  rules: AccessPolicyRules,
  revision = 1,
  organizationId: OrganizationId = ORG_A,
) =>
  new AccessPolicy({
    id: AccessPolicyId.make(id),
    organizationId,
    name,
    builtIn: false,
    revision,
    rules,
    elevated: isElevatedAccessPolicy(rules),
    createdAt: NOW,
    updatedAt: NOW,
  });

const secretOf = (projectId: ProjectId, delivery: "direct" | "brokered") =>
  new ProjectSecret({
    id: SECRET,
    projectId,
    name: "STRIPE_KEY",
    revision: 2,
    delivery:
      delivery === "direct"
        ? { mode: "direct" }
        : { mode: "brokered", binding: BINDING, placeholder: "mend_sec_abcdefghijklmnopqrstuvwx" },
    createdAt: NOW,
    updatedAt: NOW,
  });

const deliveryKey = (projectId: string) => `${projectId}/${SECRET}`;

let api: TenancyApi;

beforeAll(async () => {
  api = await createTenancyApi(undefined, {
    implement: {
      cipher: { encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext.length}`) },
      environment: {
        snapshot: () =>
          Effect.succeed(new ProjectEnvironmentSnapshot({ revision: 0, variables: [] })),
      },
      audit: {
        record: (event) =>
          Effect.sync(() => {
            log.push(`audit:${event.action}`);
            audits.push(event);
          }),
      },
      engine: { launchUnderWay: () => false, reconcileHotSessions: () => Effect.void },
      accessPolicies: {
        list: (organizationId) =>
          Effect.succeed([
            standardAccessPolicy(organizationId),
            ...[...templates.values()].filter((entry) => entry.organizationId === organizationId),
          ]),
        byId: (organizationId, id) => {
          if (id === STANDARD_ACCESS_POLICY_ID)
            return Effect.succeed(standardAccessPolicy(organizationId));
          const found = templates.get(id);
          return found === undefined || found.organizationId !== organizationId
            ? Effect.fail(new AccessPolicyNotFoundError({ policyId: id }))
            : Effect.succeed(found);
        },
        create: (input) =>
          Effect.gen(function* () {
            const name = input.name.trim();
            if (
              [...templates.values()].some(
                (entry) => entry.name.toLowerCase() === name.toLowerCase(),
              )
            ) {
              return yield* new AccessPolicyNameTakenError({ name });
            }
            const created = template(`ap_${templates.size + 1}`, name, input.rules);
            templates.set(created.id, created);
            log.push("create");
            return created;
          }),
        update: (input) =>
          Effect.gen(function* () {
            if (input.id === STANDARD_ACCESS_POLICY_ID) {
              return yield* new AccessPolicyBuiltInError({ policyId: input.id });
            }
            const current = templates.get(input.id);
            if (current === undefined)
              return yield* new AccessPolicyNotFoundError({ policyId: input.id });
            if (current.revision !== input.expectedRevision) {
              return yield* new AccessPolicyStaleWriteError({
                policyId: input.id,
                currentRevision: current.revision,
              });
            }
            const updated = template(
              input.id,
              input.name.trim(),
              input.rules,
              current.revision + 1,
            );
            templates.set(input.id, updated);
            log.push("update");
            return updated;
          }),
        remove: (_, id) =>
          Effect.gen(function* () {
            if (id === STANDARD_ACCESS_POLICY_ID)
              return yield* new AccessPolicyBuiltInError({ policyId: id });
            const current = templates.get(id);
            if (current === undefined)
              return yield* new AccessPolicyNotFoundError({ policyId: id });
            templates.delete(id);
            log.push("remove");
            return current;
          }),
        projectPolicy: (projectId) => Effect.succeed(projectPolicies.get(projectId) ?? null),
        setProjectPolicy: (projectId, policy) =>
          Effect.sync(() => {
            log.push(`setProjectPolicy:${policy.source.policyId}`);
            projectPolicies.set(projectId, policy);
          }),
        revoke: (input) =>
          Effect.sync(() => {
            const stored = new AccessRevocation({
              id: `arv_${revocations.length + 1}`,
              organizationId: input.organizationId,
              policyId: input.policyId,
              kind: input.kind,
              target: input.target,
              revokedByUserId: input.revokedByUserId,
              revokedAt: NOW,
            });
            revocations.push(stored);
            log.push("revoke");
            return stored;
          }),
        revocations: () => Effect.sync(() => [...revocations]),
        revocationsForProject: () => Effect.sync(() => [...revocations]),
      },
      accessPolicyEnforcement: {
        fanOutRevocation: (revocation) =>
          Effect.sync(() => {
            // Stored first: the fan-out reads it back as the database would.
            log.push(`fanOut:${revocations.some((entry) => entry.id === revocation.id)}`);
            return [{ workspaceId: "ws-1", enforcement: "enforced" as const, message: null }];
          }),
        applyUpdatedPolicy: () =>
          Effect.sync(() => {
            log.push("apply");
            return {
              pin: {
                rules: RESTRICTED,
                source: { policyId: AccessPolicyId.make("ap_r"), name: "Restricted", revision: 1 },
                policyHash: "sha256:pin",
                pinnedAt: NOW,
              },
              workspaces: [
                { workspaceId: "ws-1", enforcement: "next-start" as const, message: null },
              ],
            };
          }),
      },
      secrets: {
        create: (projectId, input) =>
          Effect.sync(() => {
            log.push(`create:${input.delivery?.mode ?? "direct"}`);
            return {
              secret: secretOf(projectId, input.delivery?.mode ?? "direct"),
              revision: 1,
            };
          }),
        deliveryOf: (projectId) => Effect.succeed(deliveries.get(deliveryKey(projectId)) ?? null),
        setDelivery: (projectId, _, input) =>
          Effect.sync(() => {
            const key = deliveryKey(projectId);
            const previous = deliveries.get(key)?.delivery ?? "direct";
            deliveries.set(key, {
              name: "STRIPE_KEY",
              delivery: input.delivery.mode,
              binding: input.delivery.mode === "brokered" ? input.delivery.binding : null,
            });
            log.push(`setDelivery:${input.delivery.mode}`);
            return {
              secret: secretOf(projectId, input.delivery.mode),
              revision: 3,
              previous,
            };
          }),
      },
    },
  });
});
afterAll(async () => {
  await api.dispose();
});
beforeEach(() => {
  log.length = 0;
  audits.length = 0;
  templates.clear();
  projectPolicies.clear();
  revocations.length = 0;
  deliveries.clear();
  api.world.calls.splice(0, api.world.calls.length);
});

const send = async (
  user: "alice" | "carol" | "bob" | "dave",
  method: string,
  path: string,
  body?: unknown,
) => {
  const response = await api.request(user, method, path, body);
  const json: unknown = await response.json();
  return { status: response.status, body: json };
};

describe("Organization → Access policies", () => {
  it("every member reads the policies, Standard first; someone outside reads nothing", async () => {
    templates.set("ap_r", template("ap_r", "Restricted", RESTRICTED));
    const member = await send("carol", "GET", "/api/organization/access-policies");
    expect(member.status).toBe(200);
    expect(member.body).toMatchObject({
      policies: [
        { id: "standard", name: "Standard", builtIn: true },
        { id: "ap_r", name: "Restricted", builtIn: false },
      ],
      revocations: [],
      privateEgressCeiling: [],
    });
    expect((await send("dave", "GET", "/api/organization/access-policies")).status).toBe(404);
  });

  it("a member cannot create, edit or remove a policy, and nothing is written", async () => {
    templates.set("ap_r", template("ap_r", "Restricted", RESTRICTED));
    const create = await send("carol", "POST", "/api/organization/access-policies", {
      name: "Locked",
      rules: RESTRICTED,
    });
    const update = await send("carol", "PUT", "/api/organization/access-policies/ap_r", {
      name: "Locked",
      rules: RESTRICTED,
      expectedRevision: 1,
    });
    const remove = await send("carol", "DELETE", "/api/organization/access-policies/ap_r");
    for (const refused of [create, update, remove]) {
      expect(refused).toMatchObject({ status: 403, body: { _tag: "AccessPolicyOwnersOnly" } });
    }
    expect(log).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("an owner creates, edits and removes one, and each is audited without rules", async () => {
    const created = await send("alice", "POST", "/api/organization/access-policies", {
      name: "Brokered",
      rules: BROKERED,
    });
    expect(created).toMatchObject({
      status: 200,
      body: { id: "ap_1", revision: 1, elevated: true },
    });
    const updated = await send("alice", "PUT", "/api/organization/access-policies/ap_1", {
      name: "Brokered APIs",
      rules: BROKERED,
      expectedRevision: 1,
    });
    expect(updated).toMatchObject({ status: 200, body: { revision: 2, name: "Brokered APIs" } });
    const removed = await send("alice", "DELETE", "/api/organization/access-policies/ap_1");
    expect(removed.status).toBe(200);
    expect(audits).toEqual([
      {
        organizationId: ORG_A,
        actorUserId: "alice",
        action: "access_policy.created",
        subjectType: "access_policy",
        subjectId: "ap_1",
        data: { name: "Brokered", revision: 1, elevated: true },
      },
      {
        organizationId: ORG_A,
        actorUserId: "alice",
        action: "access_policy.updated",
        subjectType: "access_policy",
        subjectId: "ap_1",
        data: { name: "Brokered APIs", revision: 2, elevated: true },
      },
      {
        organizationId: ORG_A,
        actorUserId: "alice",
        action: "access_policy.removed",
        subjectType: "access_policy",
        subjectId: "ap_1",
        data: { name: "Brokered APIs", revision: 2, elevated: true },
      },
    ]);
  });

  it("refuses every problem of a policy with 400, before anything is written", async () => {
    const refused = await send("alice", "POST", "/api/organization/access-policies", {
      name: "standard",
      rules: {
        ...RESTRICTED,
        allowHosts: [{ host: "*.example.com" }],
        allowedPrivateEgress: ["10.0.4.0/24"],
      },
    });
    expect(refused).toMatchObject({
      status: 400,
      body: {
        _tag: "AccessPolicyRejected",
        problems: [
          "Standard is the built-in policy's name; give this one another.",
          expect.stringMatching(/^allowHosts:/),
          expect.stringContaining("MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS is unset"),
        ],
      },
    });
    expect(log).toEqual([]);
  });

  it("answers 409 on a taken name, a stale revision and Standard", async () => {
    templates.set("ap_r", template("ap_r", "Restricted", RESTRICTED, 3));
    templates.set("ap_b", template("ap_b", "Brokered", BROKERED));
    const taken = await send("alice", "POST", "/api/organization/access-policies", {
      name: "restricted",
      rules: RESTRICTED,
    });
    expect(taken).toMatchObject({
      status: 409,
      body: { _tag: "AccessPolicyNameTaken", name: "restricted" },
    });
    const stale = await send("alice", "PUT", "/api/organization/access-policies/ap_r", {
      name: "Restricted",
      rules: RESTRICTED,
      expectedRevision: 2,
    });
    expect(stale).toMatchObject({
      status: 409,
      body: { _tag: "AccessPolicyStaleWrite", policyId: "ap_r", currentRevision: 3 },
    });
    const editStandard = await send("alice", "PUT", "/api/organization/access-policies/standard", {
      name: "Mine",
      rules: RESTRICTED,
      expectedRevision: 1,
    });
    const removeStandard = await send(
      "alice",
      "DELETE",
      "/api/organization/access-policies/standard",
    );
    for (const builtIn of [editStandard, removeStandard]) {
      expect(builtIn).toMatchObject({ status: 409, body: { _tag: "AccessPolicyBuiltIn" } });
    }
    expect(audits).toEqual([]);
  });
});

describe("revoking access", () => {
  it("a member cannot revoke", async () => {
    const refused = await send("carol", "POST", "/api/organization/access-policies/revocations", {
      policyId: null,
      kind: "all",
      target: null,
    });
    expect(refused).toMatchObject({ status: 403, body: { _tag: "AccessPolicyOwnersOnly" } });
    expect(log).toEqual([]);
  });

  it("stores the revocation, then pushes it, then audits it", async () => {
    const revoked = await send("alice", "POST", "/api/organization/access-policies/revocations", {
      policyId: null,
      kind: "host",
      target: "API.Example.com",
    });
    expect(revoked).toMatchObject({
      status: 200,
      body: {
        revocation: { id: "arv_1", kind: "host", target: "API.Example.com", policyId: null },
        workspaces: [{ workspaceId: "ws-1", enforcement: "enforced", message: null }],
      },
    });
    expect(log).toEqual(["revoke", "fanOut:true", "audit:access_policy.revoked"]);
    expect(audits).toEqual([
      {
        organizationId: ORG_A,
        actorUserId: "alice",
        action: "access_policy.revoked",
        subjectType: "access_revocation",
        subjectId: "arv_1",
        data: { kind: "host", target: "API.Example.com", policyId: null },
      },
    ]);
  });

  it("refuses a revocation without its target, of a host that is none, or of a policy that is not here", async () => {
    const noTarget = await send("alice", "POST", "/api/organization/access-policies/revocations", {
      policyId: null,
      kind: "secret",
      target: " ",
    });
    expect(noTarget).toMatchObject({ status: 400, body: { _tag: "AccessPolicyRejected" } });
    const wildcard = await send("alice", "POST", "/api/organization/access-policies/revocations", {
      policyId: null,
      kind: "host",
      target: "*.example.com",
    });
    expect(wildcard).toMatchObject({ status: 400, body: { _tag: "AccessPolicyRejected" } });
    const unknown = await send("alice", "POST", "/api/organization/access-policies/revocations", {
      policyId: "ap_gone",
      kind: "all",
      target: null,
    });
    expect(unknown).toMatchObject({ status: 404, body: { _tag: "NotFound", id: "ap_gone" } });
    expect(log).toEqual([]);
  });

  it("names every rule a revocation breaks", () => {
    expect(revocationProblems({ policyId: null, kind: "all", target: "x" })).toEqual([
      "target: a revocation of everything names no target",
    ]);
    expect(revocationProblems({ policyId: null, kind: "host", target: "10.0.4.0/24" })).toEqual([]);
    expect(revocationProblems({ policyId: null, kind: "host", target: "api.example.com" })).toEqual(
      [],
    );
    expect(
      revocationProblems({ policyId: null, kind: "host", target: "https://a.b/" }),
    ).not.toEqual([]);
  });
});

describe("a project's Access policy", () => {
  const sharedA = ids("shared-a").project;
  const privateCarol = ids("private-carol").project;

  it("reads Standard for a project that holds no other", async () => {
    const read = await send("carol", "GET", `/api/projects/${sharedA}/access-policy`);
    expect(read).toMatchObject({
      status: 200,
      body: {
        policy: { source: { policyId: "standard", name: "Standard", revision: 1 } },
        elevated: false,
        latestRevision: null,
        sourceRemoved: false,
      },
    });
  });

  it("says when the template moved on, or was removed", async () => {
    templates.set("ap_r", template("ap_r", "Restricted", RESTRICTED, 4));
    projectPolicies.set(sharedA, {
      rules: RESTRICTED,
      source: { policyId: AccessPolicyId.make("ap_r"), name: "Restricted", revision: 2 },
    });
    projectPolicies.set(privateCarol, {
      rules: RESTRICTED,
      source: { policyId: AccessPolicyId.make("ap_gone"), name: "Gone", revision: 1 },
    });
    expect(
      (await send("alice", "GET", `/api/projects/${sharedA}/access-policy`)).body,
    ).toMatchObject({
      latestRevision: 4,
      sourceRemoved: false,
    });
    expect(
      (await send("carol", "GET", `/api/projects/${privateCarol}/access-policy`)).body,
    ).toMatchObject({
      latestRevision: null,
      sourceRemoved: true,
    });
  });

  it("the project's creator assigns a policy that is not elevated, as a copy, audited", async () => {
    templates.set("ap_r", template("ap_r", "Restricted", RESTRICTED, 2));
    const assigned = await send("carol", "PUT", `/api/projects/${privateCarol}/access-policy`, {
      policyId: "ap_r",
    });
    expect(assigned).toMatchObject({
      status: 200,
      body: {
        policy: { source: { policyId: "ap_r", name: "Restricted", revision: 2 } },
        elevated: false,
      },
    });
    expect(projectPolicies.get(privateCarol)?.rules).toEqual(RESTRICTED);
    expect(audits).toEqual([
      {
        organizationId: ORG_A,
        actorUserId: "carol",
        action: "project.access_policy_assigned",
        subjectType: "project",
        subjectId: privateCarol,
        data: { policyId: "ap_r", revision: 2, elevated: false },
      },
    ]);
  });

  it("an elevated policy takes an Organization Owner", async () => {
    templates.set("ap_b", template("ap_b", "Brokered", BROKERED));
    const member = await send("carol", "PUT", `/api/projects/${privateCarol}/access-policy`, {
      policyId: "ap_b",
    });
    expect(member).toMatchObject({ status: 403, body: { _tag: "AccessPolicyOwnersOnly" } });
    expect(projectPolicies.size).toBe(0);
    expect(audits).toEqual([]);
    const owner = await send("alice", "PUT", `/api/projects/${sharedA}/access-policy`, {
      policyId: "ap_b",
    });
    expect(owner).toMatchObject({ status: 200, body: { elevated: true } });
    expect(audits.map((event) => [event.action, event.data])).toEqual([
      ["project.access_policy_assigned", { policyId: "ap_b", revision: 1, elevated: true }],
    ]);
  });

  it("someone who does not manage the project cannot assign one", async () => {
    templates.set("ap_r", template("ap_r", "Restricted", RESTRICTED));
    const member = await send("carol", "PUT", `/api/projects/${sharedA}/access-policy`, {
      policyId: "ap_r",
    });
    expect(member).toMatchObject({ status: 404, body: { _tag: "NotFound", id: sharedA } });
    const unknown = await send("alice", "PUT", `/api/projects/${sharedA}/access-policy`, {
      policyId: "ap_gone",
    });
    expect(unknown).toMatchObject({ status: 404, body: { _tag: "NotFound", id: "ap_gone" } });
    expect(log).toEqual([]);
  });
});

describe("a project secret's delivery", () => {
  const sharedA = ids("shared-a").project;
  const privateCarol = ids("private-carol").project;
  const path = (project: string) => `/api/projects/${project}/secrets/${SECRET}/delivery`;

  it("whoever manages the project makes a secret Brokered; the answer and the audit carry no value", async () => {
    deliveries.set(deliveryKey(privateCarol), {
      name: "STRIPE_KEY",
      delivery: "direct",
      binding: null,
    });
    const brokered = await send("carol", "PUT", path(privateCarol), {
      delivery: { mode: "brokered", binding: BINDING },
      expectedRevision: 2,
    });
    expect(brokered).toMatchObject({
      status: 200,
      body: {
        secret: {
          name: "STRIPE_KEY",
          delivery: {
            mode: "brokered",
            binding: BINDING,
            placeholder: "mend_sec_abcdefghijklmnopqrstuvwx",
          },
        },
      },
    });
    expect(audits).toEqual([
      {
        organizationId: ORG_A,
        actorUserId: "carol",
        action: "project.secret_brokered",
        subjectType: "project",
        subjectId: privateCarol,
        data: {
          secret: "STRIPE_KEY",
          headerName: BINDING.headerName,
          bindHosts: BINDING.bindHosts.join(","),
          previousHeaderName: null,
          previousBindHosts: null,
        },
      },
    ]);
  });

  it("adds a secret Brokered in one write, audited with where it goes and never its value", async () => {
    const added = await send("carol", "POST", `/api/projects/${privateCarol}/secrets`, {
      name: "STRIPE_KEY",
      value: "sk_live_real",
      delivery: { mode: "brokered", binding: BINDING },
    });
    expect(added).toMatchObject({
      status: 200,
      body: { secret: { delivery: { mode: "brokered", binding: BINDING } } },
    });
    expect(log[0]).toBe("create:brokered");
    expect(audits.map((event) => [event.action, event.data])).toEqual([
      [
        "project.secret_brokered",
        {
          secret: "STRIPE_KEY",
          headerName: BINDING.headerName,
          bindHosts: BINDING.bindHosts.join(","),
          previousHeaderName: null,
          previousBindHosts: null,
        },
      ],
    ]);
    expect(JSON.stringify(added.body)).not.toContain("sk_live_real");
    const refused = await send("carol", "POST", `/api/projects/${privateCarol}/secrets`, {
      name: "OTHER",
      value: "x",
      delivery: {
        mode: "brokered",
        binding: { headerName: "Host", bindHosts: ["api.stripe.com"] },
      },
    });
    expect(refused).toMatchObject({ status: 400, body: { _tag: "AccessPolicyRejected" } });
  });

  it("only an Organization Owner changes where an existing Brokered secret's value goes, audited", async () => {
    deliveries.set(deliveryKey(privateCarol), {
      name: "STRIPE_KEY",
      delivery: "brokered",
      binding: BINDING,
    });
    const elsewhere = { headerName: BINDING.headerName, bindHosts: ["collector.example.net"] };
    const member = await send("carol", "PUT", path(privateCarol), {
      delivery: { mode: "brokered", binding: elsewhere },
      expectedRevision: 2,
    });
    expect(member).toMatchObject({ status: 403, body: { _tag: "AccessPolicyOwnersOnly" } });
    expect(log).toEqual([]);
    // The same binding, its hosts in another order, is no move.
    const same = await send("carol", "PUT", path(privateCarol), {
      delivery: {
        mode: "brokered",
        binding: { ...BINDING, bindHosts: BINDING.bindHosts.toReversed() },
      },
      expectedRevision: 2,
    });
    expect(same.status).toBe(200);

    deliveries.set(deliveryKey(sharedA), {
      name: "STRIPE_KEY",
      delivery: "brokered",
      binding: BINDING,
    });
    audits.length = 0;
    const owner = await send("alice", "PUT", path(sharedA), {
      delivery: { mode: "brokered", binding: elsewhere },
      expectedRevision: 2,
    });
    expect(owner.status).toBe(200);
    expect(audits.map((event) => event.data)).toEqual([
      {
        secret: "STRIPE_KEY",
        headerName: BINDING.headerName,
        bindHosts: "collector.example.net",
        previousHeaderName: BINDING.headerName,
        previousBindHosts: BINDING.bindHosts.join(","),
      },
    ]);
  });

  it("refuses a binding that breaks a rule with every problem", async () => {
    const refused = await send("carol", "PUT", path(privateCarol), {
      delivery: { mode: "brokered", binding: { headerName: "Authorization", bindHosts: [] } },
      expectedRevision: 2,
    });
    expect(refused).toMatchObject({
      status: 400,
      body: { _tag: "AccessPolicyRejected", problems: ["bindHosts must name at least one host"] },
    });
    expect(log).toEqual([]);
  });

  it("turning a Brokered secret back to Direct takes an Organization Owner", async () => {
    deliveries.set(deliveryKey(privateCarol), {
      name: "STRIPE_KEY",
      delivery: "brokered",
      binding: BINDING,
    });
    const member = await send("carol", "PUT", path(privateCarol), {
      delivery: { mode: "direct" },
      expectedRevision: 2,
    });
    expect(member).toMatchObject({ status: 403, body: { _tag: "AccessPolicyOwnersOnly" } });
    expect(log).toEqual([]);

    deliveries.set(deliveryKey(sharedA), {
      name: "STRIPE_KEY",
      delivery: "brokered",
      binding: BINDING,
    });
    const owner = await send("alice", "PUT", path(sharedA), {
      delivery: { mode: "direct" },
      expectedRevision: 2,
    });
    expect(owner).toMatchObject({
      status: 200,
      body: { secret: { delivery: { mode: "direct" } } },
    });
    expect(audits.map((event) => [event.action, event.subjectId, event.data])).toEqual([
      ["project.secret_unbrokered", sharedA, { secret: "STRIPE_KEY" }],
    ]);
  });

  it("a Direct secret staying Direct needs no owner and is not audited", async () => {
    deliveries.set(deliveryKey(privateCarol), {
      name: "STRIPE_KEY",
      delivery: "direct",
      binding: null,
    });
    const kept = await send("carol", "PUT", path(privateCarol), {
      delivery: { mode: "direct" },
      expectedRevision: 2,
    });
    expect(kept.status).toBe(200);
    expect(audits).toEqual([]);
  });

  it("answers 404 for a secret the project does not hold", async () => {
    const missing = await send("alice", "PUT", path(sharedA), {
      delivery: { mode: "direct" },
      expectedRevision: 2,
    });
    expect(missing).toMatchObject({ status: 404, body: { _tag: "NotFound", id: SECRET } });
  });
});

describe("a worktree's Access policy", () => {
  const worktree = ids("shared-a").worktree;
  const sharedA = ids("shared-a").project;

  it("reads a worktree from before policies as Standard, less the revocations that reach it", async () => {
    const revoke = (policyId: string | null, kind: "host" | "all", target: string | null) =>
      revocations.push(
        new AccessRevocation({
          id: `arv_${revocations.length + 1}`,
          organizationId: ORG_A,
          policyId: policyId === null ? null : AccessPolicyId.make(policyId),
          kind,
          target,
          revokedByUserId: "alice",
          revokedAt: NOW,
        }),
      );
    revoke(null, "host", "api.example.com");
    revoke("ap_other", "all", null);
    const read = await send("carol", "GET", `/api/worktrees/${worktree}/access-policy`);
    expect(read).toMatchObject({
      status: 200,
      body: {
        pin: null,
        effective: { mode: "standard", gitTransport: "read-write" },
        revocations: [{ id: "arv_1" }],
        projectPolicyDiffers: false,
      },
    });
    projectPolicies.set(sharedA, {
      rules: RESTRICTED,
      source: { policyId: AccessPolicyId.make("ap_r"), name: "Restricted", revision: 1 },
    });
    expect(
      (await send("carol", "GET", `/api/worktrees/${worktree}/access-policy`)).body,
    ).toMatchObject({
      projectPolicyDiffers: true,
    });
  });

  it("anyone who may start sessions applies the updated policy", async () => {
    const applied = await send("carol", "POST", `/api/worktrees/${worktree}/access-policy/apply`);
    expect(applied).toMatchObject({
      status: 200,
      body: {
        pin: { source: { policyId: "ap_r" } },
        workspaces: [{ workspaceId: "ws-1", enforcement: "next-start" }],
      },
    });
    expect(log).toEqual(["apply"]);
    const outside = await send("bob", "POST", `/api/worktrees/${worktree}/access-policy/apply`);
    expect(outside).toMatchObject({ status: 404, body: { id: worktree } });
  });
});
