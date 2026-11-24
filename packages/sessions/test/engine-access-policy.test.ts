import { AccessPoliciesRepo, accessPolicyPin, DopplerRepo } from "@mend/db";
import { AccessPolicyId, OrganizationId } from "@mend/domain";
import {
  type AccessPolicyRules,
  type ProjectAccessPolicy,
  AccessRevocation,
  STANDARD_ACCESS_POLICY_RULES,
  STANDARD_PROJECT_ACCESS_POLICY,
  Worktree,
} from "@mend/domain/workbench";
import {
  AccessPolicyEnforcement,
  AccessPolicyEnforcementLive,
  AccessPolicyStore,
  SessionEngine,
} from "@mend/sessions";
import type { CreateOptions, RevokeAccessOptions } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  mcpServersLayerOf,
  projectSecretsLayer,
  projectsLayer,
  sealantLaunchLayer,
  secretCipherStubLayer,
  sessionsLayer,
  setup,
  withEngine,
  worktreesLayer,
} from "./engine/fixture.ts";

/**
 * A launch under a project's Access policy (agent-home `workspace-isolation-architecture.md`
 * §7–§8): what the create hands sealant, and what admission refuses before anything is created.
 */

const policy = (rules: Partial<AccessPolicyRules>): ProjectAccessPolicy => ({
  rules: { ...STANDARD_ACCESS_POLICY_RULES, ...rules },
  source: {
    policyId: AccessPolicyId.make("ap_deploy"),
    name: "Deploy",
    revision: 3,
  },
});

const storeOf = (
  project: ProjectAccessPolicy,
  revocations: ReadonlyArray<AccessRevocation> = [],
) => ({
  projectPolicy: () => Effect.succeed(project),
  revocationsForProject: () => Effect.succeed(revocations),
});

const revocationOf = (kind: "host" | "all", target: string | null) =>
  new AccessRevocation({
    id: `arv_${kind}`,
    organizationId: OrganizationId.make("org-fixture"),
    policyId: null,
    kind,
    target,
    revokedByUserId: "owner",
    revokedAt: new Date(),
  });

const BROKERED = {
  VERCEL_TOKEN: {
    binding: { headerName: "Authorization", bindHosts: ["api.vercel.com"] },
    placeholder: "mend_sec_abcdefghijklmnopqrstuvwx",
  },
};

const launchUnder = (
  project: ProjectAccessPolicy,
  options: {
    readonly sessionRuntime?: "docker" | "host-vm" | "boat";
    readonly revocations?: ReadonlyArray<AccessRevocation>;
  } = {},
) => {
  const created: CreateOptions[] = [];
  const accessRevokes: Array<{
    readonly workspaceId: string;
    readonly options: RevokeAccessOptions;
  }> = [];
  const run = withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const adopted = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          projectId: adopted.id,
          harness: "codex",
          label: null,
          name: null,
          ownerUserId: "user-fixture",
          start: { kind: "base", base: null },
        });
        // What `WorktreesRepo.create` does: the new worktree pins its project's own policy.
        const worktree = world.worktrees.get(session.worktreeId);
        if (worktree !== undefined) {
          world.worktrees.set(
            worktree.id,
            new Worktree({
              ...worktree,
              accessPolicy: accessPolicyPin(project.rules, project.source, new Date()),
            }),
          );
        }
        const outcome = yield* engine.launch(session.id, ["codex"]).pipe(Effect.result);
        return { outcome, session: world.sessions.get(session.id) };
      }),
    {
      sealantLayer: sealantLaunchLayer(
        created,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { accessRevokes },
      ),
      accessPolicyStore: storeOf(project, options.revocations),
      secrets: () => ({
        revision: 1,
        secrets: { DATABASE_URL: "postgres://u:p@h/db", VERCEL_TOKEN: "vercel-real-token" },
        brokered: BROKERED,
      }),
      ...(options.sessionRuntime === undefined ? {} : { sessionRuntime: options.sessionRuntime }),
    },
  );
  return run.then((result) => ({ ...result, created, accessRevokes }));
};

describe("a launch under an Access policy", () => {
  it("hands a Brokered secret to sealant as a placeholder, its value for the egress proxy only", async () => {
    const { created, session } = await launchUnder(
      policy({
        mode: "restricted",
        allowBrokeredSecrets: true,
        allowHosts: [{ host: "github.com" }],
      }),
      // Restricted egress with Docker inside the workspace needs a VM of its own.
      { sessionRuntime: "host-vm" },
    );
    expect(session?.summary ?? "").not.toContain("launch failed");
    expect(created).toHaveLength(1);
    const options = created[0];
    // The Direct secret rides secretEnv; the Brokered one never does.
    expect(options?.secretEnv).toEqual({ DATABASE_URL: "postgres://u:p@h/db" });
    expect(options?.brokeredSecrets).toEqual([
      {
        secretId: "secret-VERCEL_TOKEN",
        name: "VERCEL_TOKEN",
        placeholder: "mend_sec_abcdefghijklmnopqrstuvwx",
        secretRef: "secret-VERCEL_TOKEN",
        headerName: "Authorization",
        bindHosts: ["api.vercel.com"],
      },
    ]);
    expect(options?.brokeredSecretValues).toEqual({ "secret-VERCEL_TOKEN": "vercel-real-token" });
    const network = options?.networkPolicy;
    expect(network?.mode).toBe("restricted");
    expect(network?.sourcePolicyId).toBe("ap_deploy");
    expect(network?.sourcePolicyRevision).toBe(3);
    expect(network?.policyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const hosts = network?.allowHosts?.map((entry) => entry.host) ?? [];
    // The listed host, the bind host (inspected), and what a Codex session needs to run.
    expect(hosts).toEqual(expect.arrayContaining(["github.com", "api.vercel.com", "chatgpt.com"]));
    expect(network?.allowHosts?.find((entry) => entry.host === "api.vercel.com")?.inspectTls).toBe(
      true,
    );
    expect(JSON.stringify(options?.env)).not.toContain("vercel-real-token");
  });

  it("refuses a Brokered secret its policy does not allow, and creates nothing", async () => {
    const { created, session, outcome } = await launchUnder(policy({}));
    expect(outcome._tag).toBe("Failure");
    expect(created).toHaveLength(0);
    expect(session?.status).toBe("failed");
    expect(JSON.stringify(session?.summary ?? null)).toContain("VERCEL_TOKEN is Brokered");
  });

  it("refuses Restricted egress with Docker inside on this server's Docker", async () => {
    const { created, session } = await launchUnder(
      policy({ mode: "restricted", allowBrokeredSecrets: true }),
      {
        sessionRuntime: "docker",
      },
    );
    expect(created).toHaveLength(0);
    expect(session?.summary).toContain("restricts egress");
  });

  it("refuses a policy that needs a VM of its own on this server's Docker", async () => {
    const { created, session } = await launchUnder(
      policy({ allowBrokeredSecrets: true, requireVmIsolation: true }),
      { sessionRuntime: "docker" },
    );
    expect(created).toHaveLength(0);
    expect(JSON.stringify(session?.summary ?? null)).toContain("needs a VM of its own");
  });

  it("refuses a Brokered secret on Boat, which runs no egress proxy, even under Standard", async () => {
    const { created, session } = await launchUnder(policy({ allowBrokeredSecrets: true }), {
      sessionRuntime: "boat",
    });
    expect(created).toHaveLength(0);
    expect(JSON.stringify(session?.summary ?? null)).toContain("egress proxy of its own");
  });

  it("tells a new workspace the organization's revoked hosts before anything runs in it", async () => {
    const { created, accessRevokes } = await launchUnder(policy({ allowBrokeredSecrets: true }), {
      sessionRuntime: "host-vm",
      revocations: [revocationOf("host", "api.vercel.com")],
    });
    expect(created).toHaveLength(1);
    // The revoked bind host is gone, and with it the secret it was bound to alone.
    expect(created[0]?.brokeredSecrets).toBeUndefined();
    expect(created[0]?.networkPolicy?.allowHosts?.map((entry) => entry.host) ?? []).not.toContain(
      "api.vercel.com",
    );
    expect(accessRevokes.map((entry) => entry.options)).toEqual([{ hosts: ["api.vercel.com"] }]);
  });

  it("refuses a Standard launch on this server's Docker that could not refuse a revoked host", async () => {
    const { created, session } = await launchUnder(policy({}), {
      sessionRuntime: "docker",
      revocations: [revocationOf("all", null)],
    });
    expect(created).toHaveLength(0);
    expect(session?.summary).toContain("egress proxy can refuse a host");
  });
});

describe("Apply updated policy", () => {
  const applyUnder = (runtime: "docker" | "host-vm") =>
    withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const adopted = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: adopted.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          const worktree = world.worktrees.get(session.worktreeId);
          if (worktree === undefined) throw new Error("no worktree");
          const before = accessPolicyPin(
            STANDARD_ACCESS_POLICY_RULES,
            STANDARD_PROJECT_ACCESS_POLICY.source,
            new Date(),
          );
          world.worktrees.set(
            worktree.id,
            new Worktree({ ...worktree, sessionRuntime: runtime, accessPolicy: before }),
          );
          const outcome = yield* Effect.gen(function* () {
            const enforcement = yield* AccessPolicyEnforcement;
            return yield* enforcement.applyUpdatedPolicy(worktree.id);
          }).pipe(
            Effect.provide(
              AccessPolicyEnforcementLive.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    projectsLayer(world),
                    worktreesLayer(world),
                    sessionsLayer(world),
                    projectSecretsLayer(() => ({ revision: 0, secrets: {} })),
                    secretCipherStubLayer,
                    mcpServersLayerOf(),
                    Layer.mock(DopplerRepo, { mappings: () => Effect.succeed([]) }),
                    Layer.mock(AccessPoliciesRepo, {}),
                    sealantLaunchLayer([]),
                  ),
                ),
              ),
            ),
            Effect.provideService(AccessPolicyStore, storeOf(policy({ requireVmIsolation: true }))),
            Effect.result,
          );
          return { outcome, before, after: world.worktrees.get(worktree.id)?.accessPolicy };
        }),
      {},
    );

  it("keeps the pin it had when the worktree's runtime cannot hold to the new rules", async () => {
    const { outcome, before, after } = await applyUnder("docker");
    expect(outcome._tag).toBe("Failure");
    expect(JSON.stringify(outcome)).toContain("needs a VM of its own");
    expect(after?.policyHash).toBe(before.policyHash);
  });

  it("pins the new rules once the runtime holds to them", async () => {
    const { outcome, before, after } = await applyUnder("host-vm");
    expect(outcome._tag).toBe("Success");
    expect(after?.policyHash).not.toBe(before.policyHash);
    expect(after?.rules.requireVmIsolation).toBe(true);
  });
});
