import { PgClient } from "@effect/sql-pg";
import {
  AccessPolicyId,
  OrganizationId,
  ProjectId,
  ProjectSecretId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  type AccessPolicyRules,
  BROKERED_PLACEHOLDER_PATTERN,
  STANDARD_ACCESS_POLICY_ID,
  STANDARD_ACCESS_POLICY_RULES,
  STANDARD_PROJECT_ACCESS_POLICY,
} from "@mend/domain/workbench";
import { Effect, Layer, Redacted, Result } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { AccessPoliciesRepo, AccessPoliciesRepoLive } from "../src/repos/access-policies.ts";
import { ProjectSecretsRepo, ProjectSecretsRepoLive } from "../src/repos/project-secrets.ts";
import { accessPolicyHash, WorktreesRepo, WorktreesRepoLive } from "../src/repos/worktrees.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
const SCRATCH_DB = `mend_access_policies_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = Layer.mergeAll(
  AccessPoliciesRepoLive,
  WorktreesRepoLive,
  ProjectSecretsRepoLive,
).pipe(Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))));

type Repos = AccessPoliciesRepo | WorktreesRepo | ProjectSecretsRepo | SqlClient.SqlClient;

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));
const failureOf = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
  run(effect.pipe(Effect.result)).then((outcome) =>
    Result.isFailure(outcome) ? outcome.failure : "accepted",
  );

const ORG_A = OrganizationId.make("org-access-a");
const ORG_B = OrganizationId.make("org-access-b");
const ORG_C = OrganizationId.make("org-access-c");
const ORG_D = OrganizationId.make("org-access-d");

const RESTRICTED: AccessPolicyRules = {
  ...STANDARD_ACCESS_POLICY_RULES,
  mode: "restricted",
  allowHosts: [{ host: "Registry.NPMJS.org" }],
  gitTransport: "read-only",
};

const newProject = (organizationId: OrganizationId) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const id = ProjectId.make(`p-${crypto.randomUUID()}`);
      yield* sql`
        INSERT INTO projects (id, name, store_path, default_branch, organization_id)
        VALUES (${id}, ${id}, ${`/store/${id}/repo.git`}, 'main', ${organizationId})`;
      return id;
    }),
  );

const newWorktree = (projectId: ProjectId) =>
  run(
    Effect.gen(function* () {
      const id = `w-${crypto.randomUUID()}`;
      return yield* (yield* WorktreesRepo).create({
        id: WorktreeId.make(id),
        projectId,
        name: id,
        directory: id,
        branch: `mend/${id}`,
        baseSha: Sha.make("d".repeat(40)),
        baseRef: "main",
        handoff: null,
      });
    }),
  );

const ids = (rows: ReadonlyArray<{ readonly worktreeId: WorktreeId }>) =>
  rows.map((row) => row.worktreeId).toSorted();

describe.skipIf(postgres.skip)("Access policies in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`INSERT INTO organizations (id, name) VALUES (${ORG_A}, 'Access A'), (${ORG_B}, 'Access B')`;
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("answers Standard for every organization, and never edits or removes it", async () => {
    const listed = await run(Effect.flatMap(AccessPoliciesRepo, (repo) => repo.list(ORG_B)));
    expect(
      listed.map((policy) => [policy.id, policy.name, policy.builtIn, policy.revision]),
    ).toEqual([["standard", "Standard", true, 1]]);
    const standard = await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) => repo.byId(ORG_A, STANDARD_ACCESS_POLICY_ID)),
    );
    expect(standard.rules).toEqual(STANDARD_ACCESS_POLICY_RULES);
    expect(
      await failureOf(
        Effect.flatMap(AccessPoliciesRepo, (repo) =>
          repo.update({
            organizationId: ORG_A,
            id: STANDARD_ACCESS_POLICY_ID,
            name: "Mine",
            rules: RESTRICTED,
            expectedRevision: 1,
          }),
        ),
      ),
    ).toMatchObject({ _tag: "AccessPolicyBuiltInError" });
    expect(
      await failureOf(
        Effect.flatMap(AccessPoliciesRepo, (repo) => repo.remove(ORG_A, STANDARD_ACCESS_POLICY_ID)),
      ),
    ).toMatchObject({ _tag: "AccessPolicyBuiltInError" });
  });

  it("bumps the revision on each edit, refuses a stale one and a name taken in any case", async () => {
    const created = await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) =>
        repo.create({
          organizationId: ORG_A,
          name: "  Locked down ",
          rules: RESTRICTED,
          createdByUserId: "alice",
        }),
      ),
    );
    expect(created).toMatchObject({
      name: "Locked down",
      revision: 1,
      builtIn: false,
      elevated: false,
    });
    // Stored canonical: hosts lowercase.
    expect(created.rules.allowHosts).toEqual([{ host: "registry.npmjs.org" }]);

    const updated = await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) =>
        repo.update({
          organizationId: ORG_A,
          id: created.id,
          name: "Locked down",
          rules: { ...RESTRICTED, allowBrokeredSecrets: true },
          expectedRevision: 1,
        }),
      ),
    );
    expect(updated).toMatchObject({ revision: 2, elevated: true });

    expect(
      await failureOf(
        Effect.flatMap(AccessPoliciesRepo, (repo) =>
          repo.update({
            organizationId: ORG_A,
            id: created.id,
            name: "Locked down",
            rules: RESTRICTED,
            expectedRevision: 1,
          }),
        ),
      ),
    ).toMatchObject({ _tag: "AccessPolicyStaleWriteError", currentRevision: 2 });

    expect(
      await failureOf(
        Effect.flatMap(AccessPoliciesRepo, (repo) =>
          repo.create({
            organizationId: ORG_A,
            name: "LOCKED DOWN",
            rules: RESTRICTED,
            createdByUserId: "alice",
          }),
        ),
      ),
    ).toMatchObject({ _tag: "AccessPolicyNameTakenError" });
    // The same name in another organization is its own.
    const elsewhere = await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) =>
        repo.create({
          organizationId: ORG_B,
          name: "Locked down",
          rules: RESTRICTED,
          createdByUserId: "bob",
        }),
      ),
    );
    expect(elsewhere.organizationId).toBe(ORG_B);
    // Another organization's template is not found from this one.
    expect(
      await failureOf(Effect.flatMap(AccessPoliciesRepo, (repo) => repo.byId(ORG_A, elsewhere.id))),
    ).toMatchObject({ _tag: "AccessPolicyNotFoundError" });

    const removed = await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) => repo.remove(ORG_A, created.id)),
    );
    expect(removed.id).toBe(created.id);
    expect(
      await failureOf(Effect.flatMap(AccessPoliciesRepo, (repo) => repo.byId(ORG_A, created.id))),
    ).toMatchObject({ _tag: "AccessPolicyNotFoundError" });
  });

  it("reads Standard for an existing project, and keeps the copy it is given", async () => {
    const project = await newProject(ORG_A);
    expect(
      await run(Effect.flatMap(AccessPoliciesRepo, (repo) => repo.projectPolicy(project))),
    ).toEqual(STANDARD_PROJECT_ACCESS_POLICY);
    const copy = {
      rules: RESTRICTED,
      source: { policyId: AccessPolicyId.make("ap_copy"), name: "Copied", revision: 3 },
    };
    await run(Effect.flatMap(AccessPoliciesRepo, (repo) => repo.setProjectPolicy(project, copy)));
    expect(
      await run(Effect.flatMap(AccessPoliciesRepo, (repo) => repo.projectPolicy(project))),
    ).toEqual({
      rules: { ...RESTRICTED, allowHosts: [{ host: "registry.npmjs.org" }] },
      source: copy.source,
    });
    expect(
      await run(
        Effect.flatMap(AccessPoliciesRepo, (repo) => repo.projectPolicy(ProjectId.make("p-none"))),
      ),
    ).toBeNull();
  });

  it("pins a new worktree to its project's policy, which later edits of the project never move", async () => {
    const project = await newProject(ORG_A);
    const before = await newWorktree(project);
    expect(before.accessPolicy).toMatchObject({
      rules: STANDARD_ACCESS_POLICY_RULES,
      source: { policyId: "standard" },
      policyHash: accessPolicyHash(STANDARD_ACCESS_POLICY_RULES),
    });
    await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) =>
        repo.setProjectPolicy(project, {
          rules: RESTRICTED,
          source: { policyId: AccessPolicyId.make("ap_pin"), name: "Pinned", revision: 1 },
        }),
      ),
    );
    const after = await newWorktree(project);
    expect(after.accessPolicy?.source.policyId).toBe("ap_pin");
    expect(after.accessPolicy?.policyHash).toBe(
      accessPolicyHash({ ...RESTRICTED, allowHosts: [{ host: "registry.npmjs.org" }] }),
    );
    const reread = await run(Effect.flatMap(WorktreesRepo, (repo) => repo.byId(before.id)));
    expect(reread.accessPolicy?.source.policyId).toBe("standard");
  });

  it("stores revocations oldest first and reaches only the worktrees they name", async () => {
    // Organizations of this test's own, so no other test's worktrees reach these lists.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO organizations (id, name) VALUES (${ORG_C}, 'Access C'), (${ORG_D}, 'Access D')`;
      }),
    );
    const projectA = await newProject(ORG_C);
    const projectB = await newProject(ORG_D);
    const standardWorktree = await newWorktree(projectA);
    await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) =>
        repo.setProjectPolicy(projectA, {
          rules: RESTRICTED,
          source: { policyId: AccessPolicyId.make("ap_scope"), name: "Scoped", revision: 1 },
        }),
      ),
    );
    const scopedWorktree = await newWorktree(projectA);
    const otherOrganization = await newWorktree(projectB);
    // A worktree from before Access policies: no pin, which reads as Standard.
    const legacy = await newWorktree(projectA);
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE worktrees SET access_policy = NULL WHERE id = ${legacy.id}`;
      }),
    );

    const host = await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) =>
        repo.revoke({
          organizationId: ORG_C,
          policyId: null,
          kind: "host",
          target: "API.Example.com.",
          revokedByUserId: "alice",
        }),
      ),
    );
    expect(host.target).toBe("api.example.com");
    await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) =>
        repo.revoke({
          organizationId: ORG_C,
          policyId: AccessPolicyId.make("ap_scope"),
          kind: "all",
          target: null,
          revokedByUserId: "alice",
        }),
      ),
    );
    const forProject = await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) => repo.revocationsForProject(projectA)),
    );
    expect(forProject.map((revocation) => revocation.kind)).toEqual(["host", "all"]);
    expect(
      await run(Effect.flatMap(AccessPoliciesRepo, (repo) => repo.revocationsForProject(projectB))),
    ).toEqual([]);

    const everyone = await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) => repo.worktreesFrom(ORG_C, null)),
    );
    expect(ids(everyone)).toEqual([standardWorktree.id, scopedWorktree.id, legacy.id].toSorted());
    expect(ids(everyone)).not.toContain(otherOrganization.id);
    const scoped = await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) =>
        repo.worktreesFrom(ORG_C, AccessPolicyId.make("ap_scope")),
      ),
    );
    expect(ids(scoped)).toEqual([scopedWorktree.id]);
    const standard = await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) =>
        repo.worktreesFrom(ORG_C, STANDARD_ACCESS_POLICY_ID),
      ),
    );
    expect(ids(standard)).toEqual([standardWorktree.id, legacy.id].toSorted());
  });

  it("makes a secret Brokered and back, keeping its placeholder, and refuses a bad binding", async () => {
    const project = await newProject(ORG_A);
    const binding = { headerName: "Authorization", bindHosts: ["api.stripe.com"] };
    const created = await run(
      Effect.flatMap(ProjectSecretsRepo, (repo) =>
        repo.create(project, { name: "STRIPE_KEY", sealedValue: "sealed:stripe" }),
      ),
    );
    expect(created.secret.delivery).toEqual({ mode: "direct" });

    const brokered = await run(
      Effect.flatMap(ProjectSecretsRepo, (repo) =>
        repo.setDelivery(project, created.secret.id, {
          delivery: { mode: "brokered", binding },
          expectedRevision: created.secret.revision,
        }),
      ),
    );
    expect(brokered.previous).toBe("direct");
    if (brokered.secret.delivery.mode !== "brokered") throw new Error("not made Brokered");
    const placeholder = brokered.secret.delivery.placeholder;
    expect(placeholder).toMatch(BROKERED_PLACEHOLDER_PATTERN);
    expect(placeholder).toHaveLength("mend_sec_".length + 24);
    expect(brokered.secret.delivery.binding).toEqual(binding);
    expect(
      await run(
        Effect.flatMap(ProjectSecretsRepo, (repo) => repo.deliveryOf(project, created.secret.id)),
      ),
    ).toEqual({ name: "STRIPE_KEY", delivery: "brokered", binding });

    // A new binding keeps the placeholder the workspace already holds.
    const rebound = await run(
      Effect.flatMap(ProjectSecretsRepo, (repo) =>
        repo.setDelivery(project, created.secret.id, {
          delivery: { mode: "brokered", binding: { ...binding, methods: ["POST"] } },
          expectedRevision: brokered.secret.revision,
        }),
      ),
    );
    expect(rebound.previous).toBe("brokered");
    expect(rebound.secret.delivery).toMatchObject({ mode: "brokered", placeholder });

    expect(
      await failureOf(
        Effect.flatMap(ProjectSecretsRepo, (repo) =>
          repo.setDelivery(project, created.secret.id, {
            delivery: { mode: "brokered", binding: { headerName: "Authorization", bindHosts: [] } },
            expectedRevision: rebound.secret.revision,
          }),
        ),
      ),
    ).toMatchObject({
      _tag: "ProjectEnvironmentInvalidInputError",
      issues: [{ message: "bindHosts must name at least one host" }],
    });
    expect(
      await failureOf(
        Effect.flatMap(ProjectSecretsRepo, (repo) =>
          repo.setDelivery(project, created.secret.id, {
            delivery: { mode: "direct" },
            expectedRevision: brokered.secret.revision,
          }),
        ),
      ),
    ).toMatchObject({ _tag: "ProjectEnvironmentStaleWriteError" });

    const direct = await run(
      Effect.flatMap(ProjectSecretsRepo, (repo) =>
        repo.setDelivery(project, created.secret.id, {
          delivery: { mode: "direct" },
          expectedRevision: rebound.secret.revision,
        }),
      ),
    );
    expect(direct.previous).toBe("brokered");
    expect(direct.secret.delivery).toEqual({ mode: "direct" });
    const sealed = await run(
      Effect.flatMap(ProjectSecretsRepo, (repo) => repo.sealedForLaunch(project)),
    );
    expect(sealed.secrets).toEqual([
      { id: created.secret.id, name: "STRIPE_KEY", sealedValue: "sealed:stripe", brokered: null },
    ]);
    expect(
      await run(
        Effect.flatMap(ProjectSecretsRepo, (repo) =>
          repo.deliveryOf(project, ProjectSecretId.make("secret-none")),
        ),
      ),
    ).toBeNull();
  });

  it("creates a secret Brokered in its first write, never Direct, and refuses a bad binding", async () => {
    const project = await newProject(ORG_A);
    const binding = { headerName: "Authorization", bindHosts: ["api.vercel.com"] };
    const created = await run(
      Effect.flatMap(ProjectSecretsRepo, (repo) =>
        repo.create(project, {
          name: "VERCEL_TOKEN",
          sealedValue: "sealed:vercel",
          delivery: { mode: "brokered", binding },
        }),
      ),
    );
    expect(created.secret.delivery).toMatchObject({ mode: "brokered", binding });
    const launched = await run(
      Effect.flatMap(ProjectSecretsRepo, (repo) => repo.sealedForLaunch(project)),
    );
    expect(
      launched.secrets.find((secret) => secret.name === "VERCEL_TOKEN")?.brokered,
    ).toMatchObject({
      binding,
    });
    const refused = await run(
      Effect.flip(
        Effect.flatMap(ProjectSecretsRepo, (repo) =>
          repo.create(project, {
            name: "OTHER_TOKEN",
            sealedValue: "sealed:other",
            delivery: { mode: "brokered", binding: { headerName: "Host", bindHosts: [] } },
          }),
        ),
      ),
    );
    expect(refused._tag).toBe("ProjectEnvironmentInvalidInputError");
    const after = await run(Effect.flatMap(ProjectSecretsRepo, (repo) => repo.snapshot(project)));
    expect(after.secrets.map((secret) => secret.name)).toEqual(["VERCEL_TOKEN"]);
  });

  it("reads a secret's revocation only for the project that holds the secret", async () => {
    const holder = await newProject(ORG_A);
    const neighbour = await newProject(ORG_A);
    const secret = await run(
      Effect.flatMap(ProjectSecretsRepo, (repo) =>
        repo.create(holder, { name: "DEPLOY_TOKEN", sealedValue: "sealed:deploy" }),
      ),
    );
    await run(
      Effect.flatMap(AccessPoliciesRepo, (repo) =>
        Effect.all([
          repo.revoke({
            organizationId: ORG_A,
            policyId: null,
            kind: "secret",
            target: secret.secret.id,
            revokedByUserId: "owner",
          }),
          repo.revoke({
            organizationId: ORG_A,
            policyId: null,
            kind: "host",
            target: "revoked-for-both.example.com",
            revokedByUserId: "owner",
          }),
        ]),
      ),
    );
    const kinds = (project: typeof holder) =>
      run(Effect.flatMap(AccessPoliciesRepo, (repo) => repo.revocationsForProject(project))).then(
        (revocations) =>
          revocations
            .filter(
              (revocation) =>
                revocation.target === secret.secret.id ||
                revocation.target === "revoked-for-both.example.com",
            )
            .map((revocation) => revocation.kind)
            .toSorted(),
      );
    expect(await kinds(holder)).toEqual(["host", "secret"]);
    expect(await kinds(neighbour)).toEqual(["host"]);
  });
});
