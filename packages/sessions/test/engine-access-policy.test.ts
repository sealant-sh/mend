import { accessPolicyPin } from "@mend/db";
import { AccessPolicyId } from "@mend/domain";
import {
  type AccessPolicyRules,
  type ProjectAccessPolicy,
  STANDARD_ACCESS_POLICY_RULES,
  Worktree,
} from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { sealantLaunchLayer, setup, withEngine } from "./engine/fixture.ts";

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

const storeOf = (project: ProjectAccessPolicy) => ({
  projectPolicy: () => Effect.succeed(project),
  revocationsForProject: () => Effect.succeed([]),
});

const BROKERED = {
  VERCEL_TOKEN: {
    binding: { headerName: "Authorization", bindHosts: ["api.vercel.com"] },
    placeholder: "mend_sec_abcdefghijklmnopqrstuvwx",
  },
};

const launchUnder = (
  project: ProjectAccessPolicy,
  options: { readonly sessionRuntime?: "docker" | "host-vm" | "boat" } = {},
) => {
  const created: CreateOptions[] = [];
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
      sealantLayer: sealantLaunchLayer(created),
      accessPolicyStore: storeOf(project),
      secrets: () => ({
        revision: 1,
        secrets: { DATABASE_URL: "postgres://u:p@h/db", VERCEL_TOKEN: "vercel-real-token" },
        brokered: BROKERED,
      }),
      ...(options.sessionRuntime === undefined ? {} : { sessionRuntime: options.sessionRuntime }),
    },
  );
  return run.then((result) => ({ ...result, created }));
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
});
