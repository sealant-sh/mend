import {
  defaultWorkspaceImage,
  RuntimeSupport,
  SessionRuntimeOffer,
  type WorkspaceRuntimesReading,
} from "@mend/domain";
import {
  BOAT_SUPPORT,
  DOCKER_AND_BOAT,
  DOCKER_SUPPORT,
  observedRuntimes,
  UNREAD,
} from "@mend/domain/runtime-support-fixtures";
import { Worktree } from "@mend/domain/workbench";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, organizationIdOf } from "../../test/support/tenancy-harness.ts";

/**
 * SLNT-795: what each runtime supports is Sealant's report, read through one service. The read,
 * the environment refusals and the Service port refusals all follow the report: change the fake
 * report and the answers change with it. Organization A (alice owner, carol member) runs on Boat;
 * organization B (bob) on this server's Docker.
 */
const withApi = async (
  workspaceRuntimes: WorkspaceRuntimesReading,
  run: (api: TenancyApi) => Promise<void>,
) => {
  const api = await createTenancyApi(
    {},
    {
      sessionRuntimes: new SessionRuntimeOffer({ offered: ["docker", "boat"], default: "docker" }),
      organizationRuntimes: new Map([[organizationIdOf("A"), "boat"]]),
      workspaceRuntimes,
      implement: {
        engine: {
          launchUnderWay: () => false,
          addService: () => Effect.die("the engine was reached"),
          runService: () => Effect.die("the engine was reached"),
        },
      },
    },
  );
  try {
    await run(api);
  } finally {
    await api.dispose();
  }
};

const arch = { ...defaultWorkspaceImage, os: "arch" };
const ubuntu = { ...defaultWorkspaceImage, os: "ubuntu" };

const readRuntime = async (api: TenancyApi, user: "alice" | "carol" | "bob" | "dave") => {
  const response = await api.request(user, "GET", "/api/organization/runtime");
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
};

describe("GET /organization/runtime", () => {
  it("answers each organization with where its new sessions run and what Sealant says it supports", async () => {
    await withApi(DOCKER_AND_BOAT, async (api) => {
      const owner = await readRuntime(api, "alice");
      expect(owner.status).toBe(200);
      expect(owner.body).toMatchObject({
        sessionRuntime: { chosen: "boat", effective: "boat", offered: ["docker", "boat"] },
        support: {
          state: "observed",
          support: {
            runtime: "boat",
            os: { arch: BOAT_SUPPORT.os.arch },
            reservedPorts: [8080],
            idleCost: { charged: true },
          },
        },
      });
      // A member reads the same; another organization reads its own runtime.
      expect((await readRuntime(api, "carol")).body).toEqual(owner.body);
      expect((await readRuntime(api, "bob")).body).toMatchObject({
        sessionRuntime: { chosen: null, effective: "docker" },
        support: { state: "observed", support: { runtime: "docker", reservedPorts: [] } },
      });
      expect((await readRuntime(api, "dave")).status).toBe(404);
    });
  });

  it("says when Sealant does not launch the runtime, and when it could not be read", async () => {
    await withApi(observedRuntimes(DOCKER_SUPPORT), async (api) => {
      expect((await readRuntime(api, "alice")).body).toMatchObject({
        support: { state: "not-launched", runtime: "boat" },
      });
    });
    await withApi(UNREAD, async (api) => {
      expect((await readRuntime(api, "alice")).body).toMatchObject({
        support: { state: "unread", reason: UNREAD.state === "unread" ? UNREAD.reason : "" },
      });
    });
  });
});

const saveOrganizationEnvironment = (api: TenancyApi, user: "alice" | "bob", image: unknown) =>
  api.request(user, "PUT", "/api/organization/settings/workspace-environment", {
    workspaceImage: image,
  });

describe("saving an environment the organization's runtime cannot run", () => {
  it("is refused with Sealant's reason, before any package is resolved", async () => {
    await withApi(DOCKER_AND_BOAT, async (api) => {
      const refused = await saveOrganizationEnvironment(api, "alice", arch);
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({
        _tag: "SettingsFailure",
        message:
          "Boat supports Ubuntu and Nix; Arch is unsupported. New sessions in this organization run on Boat, so this environment was not saved.",
      });
      expect(api.world.calls).not.toContain("sealant.resolveWorkspacePackage");

      const project = await api.request(
        "alice",
        "PUT",
        `/api/projects/${ids("shared-a").project}/workspace-image`,
        {
          workspaceImage: {
            mode: "custom",
            baseImage: "node:22",
            packages: [],
            setupCommands: [],
            services: { docker: true },
          },
        },
      );
      expect(project.status).toBe(422);
      expect((await project.json()).message).toContain("Boat cannot boot a custom OCI base image.");

      const instance = await api.request(
        "alice",
        "PUT",
        "/api/settings/workspace-environment",
        arch,
      );
      expect(instance.status).toBe(422);
      expect((await instance.json()).message).toContain("Arch is unsupported");
      expect(api.world.calls).not.toContain("settings.modify");
    });
  });

  it("lets a Docker organization, an environment Boat runs, and an unread report through", async () => {
    const reachedResolution = async (api: TenancyApi, user: "alice" | "bob", image: unknown) => {
      api.world.calls.length = 0;
      await saveOrganizationEnvironment(api, user, image);
      return api.world.calls.includes("sealant.resolveWorkspacePackage");
    };
    await withApi(DOCKER_AND_BOAT, async (api) => {
      expect(await reachedResolution(api, "bob", arch)).toBe(true);
      expect(await reachedResolution(api, "alice", ubuntu)).toBe(true);
    });
    await withApi(UNREAD, async (api) => {
      expect(await reachedResolution(api, "alice", arch)).toBe(true);
    });
  });

  it("follows the report: a Boat that ran Arch would take it", async () => {
    const archOnBoat = new RuntimeSupport({
      ...BOAT_SUPPORT,
      os: { ...BOAT_SUPPORT.os, arch: { supported: true } },
    });
    await withApi(observedRuntimes(DOCKER_SUPPORT, archOnBoat), async (api) => {
      api.world.calls.length = 0;
      await saveOrganizationEnvironment(api, "alice", arch);
      expect(api.world.calls).toContain("sealant.resolveWorkspacePackage");
    });
  });
});

describe("declaring a Service on a port the runtime holds", () => {
  const boatMessage =
    "Boat holds port 8080 inside every workspace for itself, so a Service cannot listen on it. Use another port.";

  it("refuses a project's Service on Boat's port in an organization on Boat, and not elsewhere", async () => {
    await withApi(DOCKER_AND_BOAT, async (api) => {
      const add = (user: "alice" | "bob", project: "shared-a" | "shared-b", port: number) =>
        api.request(user, "POST", `/api/projects/${ids(project).project}/service-recipes`, {
          name: "web",
          command: "pnpm dev",
          port,
        });
      const refused = await add("alice", "shared-a", 8080);
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ _tag: "StoreFailure", message: boatMessage });
      expect(api.world.calls).not.toContain("recipes.create");
      // Organization B runs on Docker, which holds no port: the save goes on to the store.
      await add("bob", "shared-b", 8080);
      expect(api.world.calls).toContain("recipes.create");
    });
  });

  it("refuses a session's Service on the port its worktree's runtime holds", async () => {
    await withApi(DOCKER_AND_BOAT, async (api) => {
      const { session, worktree } = ids("shared-a");
      const recorded = api.world.worktrees.get(worktree);
      if (recorded === undefined) throw new Error("the harness has no shared-a worktree");
      api.world.addWorktree(new Worktree({ ...recorded, sessionRuntime: "boat" }));
      for (const [path, body] of [
        [`/api/sessions/${session}/services`, { port: 8080, name: "web" }],
        [
          `/api/sessions/${session}/services/run`,
          { argv: ["pnpm", "dev"], port: 8080, name: "web" },
        ],
      ] as const) {
        const refused = await api.request("alice", "POST", path, body);
        expect(refused.status).toBe(422);
        expect(await refused.json()).toMatchObject({ message: boatMessage });
      }
      // A worktree created on this server's Docker keeps it, whatever the organization chose since.
      api.world.addWorktree(new Worktree({ ...recorded, sessionRuntime: "docker" }));
      const reached = await api.request("alice", "POST", `/api/sessions/${session}/services`, {
        port: 8080,
        name: "web",
      });
      expect(reached.status).toBe(500);
    });
  });
});
