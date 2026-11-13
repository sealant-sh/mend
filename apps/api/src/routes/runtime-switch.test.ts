import { ProjectNotFoundError, type NewAuditEvent } from "@mend/db";
import {
  defaultWorkspaceImage,
  inheritedOrganizationSettings,
  OrganizationSettings,
  type ProjectId,
  ProjectMountId,
  type SessionRuntime,
  SessionRuntimeOffer,
  type WorkspaceImage,
  type WorkspaceRuntimesReading,
} from "@mend/domain";
import { DOCKER_AND_BOAT, UNREAD } from "@mend/domain/runtime-support-fixtures";
import { Project, ProjectMount, ServiceRecipe } from "@mend/domain/workbench";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, organizationIdOf, type HarnessUser } from "../../test/support/tenancy-harness.ts";

/**
 * SLNT-796: before an owner moves an organization's new sessions to another runtime, Mend lists
 * what that runtime would not run, from Sealant's report, and can move environments in the same
 * step. Organization A (alice owner, carol member) starts on this server's Docker; B (bob) too.
 * Carol's private project is one alice cannot see.
 */

const arch: WorkspaceImage = { ...defaultWorkspaceImage, os: "arch" };
const ubuntu: WorkspaceImage = { ...defaultWorkspaceImage, os: "ubuntu" };
const fedora: WorkspaceImage = { ...defaultWorkspaceImage, os: "fedora", packages: ["postgresql"] };
const NOW = new Date("2026-11-13T14:00:00.000Z");

interface World {
  readonly api: TenancyApi;
  /** Each project's own environment, as the repo stores it; absent inherits. */
  readonly images: Map<ProjectId, WorkspaceImage | null>;
  /** Each organization's own settings, as the repo stores them. */
  readonly organizations: Map<string, OrganizationSettings>;
  readonly runtimes: Map<string, SessionRuntime>;
  readonly audited: Array<NewAuditEvent>;
}

const withWorld = async (
  setup: {
    readonly reading?: WorkspaceRuntimesReading;
    readonly images?: ReadonlyArray<readonly [ProjectId, WorkspaceImage]>;
    readonly services?: ReadonlyArray<readonly [ProjectId, number]>;
    readonly mounts?: ReadonlyArray<ProjectId>;
  },
  run: (world: World) => Promise<void>,
) => {
  const images = new Map<ProjectId, WorkspaceImage | null>(setup.images ?? []);
  const organizations = new Map<string, OrganizationSettings>();
  const runtimes = new Map<string, SessionRuntime>();
  const audited: Array<NewAuditEvent> = [];
  const own = (organizationId: string) =>
    organizations.get(organizationId) ?? inheritedOrganizationSettings;
  const withImage = (project: Project) =>
    new Project({ ...project, workspaceImage: images.get(project.id) ?? null });
  const holder: { api: TenancyApi | null } = { api: null };
  const harnessProjects = () => [...(holder.api?.world.projects.values() ?? [])];
  const api = await createTenancyApi(
    {},
    {
      sessionRuntimes: new SessionRuntimeOffer({ offered: ["docker", "boat"], default: "docker" }),
      workspaceRuntimes: setup.reading ?? DOCKER_AND_BOAT,
      implement: {
        engine: { launchUnderWay: () => false, reconcileHotSessions: () => Effect.void },
        projects: {
          listForOrganization: (organizationId) =>
            Effect.sync(() =>
              harnessProjects()
                .filter((project) => project.organizationId === organizationId)
                .map(withImage),
            ),
          setWorkspaceImage: (id, image) =>
            Effect.suspend(() => {
              const found = harnessProjects().find((project) => project.id === id);
              if (found === undefined)
                return Effect.fail(new ProjectNotFoundError({ projectId: id }));
              images.set(id, image);
              return Effect.succeed(withImage(found));
            }),
        },
        organizationSettings: {
          get: (organizationId) => Effect.sync(() => own(organizationId)),
          modify: (organizationId, update) =>
            Effect.sync(() => {
              const next = update(own(organizationId));
              organizations.set(organizationId, next);
              return next;
            }),
          sessionRuntime: (organizationId) =>
            Effect.sync(() => runtimes.get(organizationId) ?? null),
          setSessionRuntime: (organizationId, runtime) =>
            Effect.sync(() => {
              const before = runtimes.get(organizationId) ?? null;
              if (runtime === null) runtimes.delete(organizationId);
              else runtimes.set(organizationId, runtime);
              return before;
            }),
        },
        audit: { record: (event) => Effect.sync(() => void audited.push(event)) },
        recipes: {
          listForProject: (projectId) =>
            Effect.succeed(
              (setup.services ?? [])
                .filter(([id]) => id === projectId)
                .map(
                  ([, port]) =>
                    new ServiceRecipe({
                      name: "web",
                      command: "pnpm dev",
                      port,
                      protocol: "tcp",
                      browserScheme: "http",
                      source: "project",
                      shadowedBy: null,
                    }),
                ),
            ),
        },
        mounts: {
          listForProject: (projectId) =>
            Effect.succeed(
              (setup.mounts ?? [])
                .filter((id) => id === projectId)
                .map(
                  (id) =>
                    new ProjectMount({
                      id: ProjectMountId.make(`mount-${id}`),
                      projectId: id,
                      name: "models",
                      hostPath: "/srv/models",
                      readOnly: true,
                      createdAt: NOW,
                      updatedAt: NOW,
                    }),
                ),
            ),
        },
      },
    },
  );
  holder.api = api;
  try {
    await run({ api, images, organizations, runtimes, audited });
  } finally {
    await api.dispose();
  }
};

const impactOf = async (api: TenancyApi, user: HarnessUser, runtime?: SessionRuntime) => {
  const response = await api.request(
    user,
    "GET",
    `/api/organization/settings/session-runtime/impact${runtime === undefined ? "" : `?sessionRuntime=${runtime}`}`,
  );
  return {
    status: response.status,
    body: response.status === 200 ? await response.json() : await response.text(),
  };
};

const choose = (api: TenancyApi, user: HarnessUser, body: unknown) =>
  api.request(user, "PUT", "/api/organization/settings/session-runtime", body);

const A = organizationIdOf("A");
const B = organizationIdOf("B");
const sharedA = ids("shared-a").project;
const privateAlice = ids("private-alice").project;
const privateCarol = ids("private-carol").project;
const sharedB = ids("shared-b").project;

describe("what moving an organization to Boat would change (SLNT-796)", () => {
  it("is one step, as before, when Boat runs everything the organization has", async () => {
    await withWorld({}, async ({ api, organizations, runtimes, audited }) => {
      organizations.set(
        A,
        new OrganizationSettings({ ...inheritedOrganizationSettings, workspaceImage: ubuntu }),
      );
      const impact = await impactOf(api, "alice", "boat");
      expect(impact).toMatchObject({
        status: 200,
        body: {
          chosen: "boat",
          effective: "boat",
          impact: {
            state: "observed",
            runtime: "boat",
            organizationDefault: null,
            projects: [],
            unseen: 0,
          },
        },
      });
      const response = await choose(api, "alice", { sessionRuntime: "boat" });
      expect(response.status).toBe(200);
      expect(runtimes.get(A)).toBe("boat");
      expect(audited.map((event) => event.action)).toEqual(["organization.settings_changed"]);
    });
  });

  it("lists environments, Service ports and server folders before anything is saved, and moves what the owner chose", async () => {
    await withWorld(
      {
        images: [
          [sharedA, fedora],
          [privateAlice, ubuntu],
          [privateCarol, arch],
          [sharedB, arch],
        ],
        services: [[sharedA, 8080]],
        mounts: [privateAlice],
      },
      async ({ api, images, organizations, runtimes, audited }) => {
        const { status, body } = await impactOf(api, "alice", "boat");
        expect(status).toBe(200);
        expect(body.impact).toEqual({
          state: "observed",
          observedAt: "2026-11-13T14:02:00.000Z",
          runtime: "boat",
          // The organization follows the instance's Arch.
          organizationDefault: {
            refusal: "Boat supports Ubuntu and Nix; Arch is unsupported.",
            from: arch,
            to: ubuntu,
            inherited: true,
          },
          projects: [
            {
              id: sharedA,
              name: "shared-a",
              environment: {
                refusal: "Boat supports Ubuntu and Nix; Fedora is unsupported.",
                from: fedora,
                to: ubuntu,
                inherited: false,
              },
              services: [{ name: "web", port: 8080 }],
              serverFolders: null,
            },
            {
              id: privateAlice,
              name: "private-alice",
              environment: null,
              services: [],
              serverFolders: {
                count: 1,
                refusal: "Boat cannot bind directories from this deployment's own servers.",
              },
            },
          ],
          // Carol's private Arch project: counted, never named.
          unseen: 1,
        });
        expect(JSON.stringify(body)).not.toContain("private-carol");
        // Reading it saved nothing.
        expect({ runtime: runtimes.get(A), audited, organizations: organizations.size }).toEqual({
          runtime: undefined,
          audited: [],
          organizations: 0,
        });

        const response = await choose(api, "alice", {
          sessionRuntime: "boat",
          moves: { organizationDefault: true, projects: [sharedA, privateAlice, privateCarol] },
        });
        expect(response.status).toBe(200);
        expect(runtimes.get(A)).toBe("boat");
        expect(organizations.get(A)?.workspaceImage).toEqual(ubuntu);
        expect(images.get(sharedA)).toEqual(ubuntu);
        // Boat runs Ubuntu: untouched. Carol's is not alice's to move. B is another organization.
        expect(images.get(privateAlice)).toEqual(ubuntu);
        expect(images.get(privateCarol)).toEqual(arch);
        expect(images.get(sharedB)).toEqual(arch);
        expect(audited.map((event) => [event.action, event.subjectId, event.data])).toEqual([
          [
            "organization.environment_moved",
            A,
            { from: "arch · 19 packages", to: "ubuntu · 19 packages", runtime: "Boat" },
          ],
          [
            "project.environment_moved",
            sharedA,
            {
              name: "shared-a",
              from: "fedora · 1 package",
              to: "ubuntu · 19 packages",
              runtime: "Boat",
            },
          ],
          ["organization.settings_changed", A, { sessionRuntime: "boat" }],
        ]);

        // What is left is not an environment: the Service, the folder and carol's project.
        const after = await impactOf(api, "alice", "boat");
        expect(after.body.impact).toMatchObject({
          organizationDefault: null,
          projects: [
            { name: "shared-a", environment: null, services: [{ port: 8080 }] },
            { name: "private-alice", serverFolders: { count: 1 } },
          ],
          unseen: 1,
        });
        // Bob's organization reads its own projects and is still on Docker.
        expect(runtimes.get(B)).toBeUndefined();
        expect((await impactOf(api, "bob", "boat")).body.impact).toMatchObject({
          projects: [{ name: "shared-b", environment: { inherited: false } }],
          unseen: 0,
        });
      },
    );
  });

  it("switches without moving anything when the owner asks for that, as a client from before does", async () => {
    await withWorld(
      { images: [[sharedA, fedora]] },
      async ({ api, images, organizations, runtimes, audited }) => {
        const response = await choose(api, "alice", { sessionRuntime: "boat" });
        expect(response.status).toBe(200);
        expect(runtimes.get(A)).toBe("boat");
        expect(images.get(sharedA)).toEqual(fedora);
        expect(organizations.size).toBe(0);
        expect(audited.map((event) => event.action)).toEqual(["organization.settings_changed"]);
        // The list still says what will not start.
        expect((await impactOf(api, "alice", "boat")).body.impact).toMatchObject({
          state: "observed",
          organizationDefault: { from: arch },
          projects: [{ name: "shared-a" }, { name: "private-alice" }],
        });
      },
    );
  });

  it("offers nothing and rewrites nothing going back to Docker, which runs everything", async () => {
    await withWorld(
      { images: [[sharedA, fedora]] },
      async ({ api, images, organizations, runtimes, audited }) => {
        runtimes.set(A, "boat");
        const impact = await impactOf(api, "alice", "docker");
        expect(impact.body.impact).toMatchObject({
          state: "observed",
          runtime: "docker",
          organizationDefault: null,
          projects: [],
          unseen: 0,
        });
        const response = await choose(api, "alice", {
          sessionRuntime: "docker",
          moves: { organizationDefault: true, projects: [sharedA] },
        });
        expect(response.status).toBe(200);
        expect(runtimes.get(A)).toBe("docker");
        expect(images.get(sharedA)).toEqual(fedora);
        expect(organizations.size).toBe(0);
        expect(audited.map((event) => event.action)).toEqual(["organization.settings_changed"]);
      },
    );
  });

  it("says Mend cannot tell when Sealant is unread, and moves nothing then", async () => {
    await withWorld(
      { reading: UNREAD, images: [[sharedA, fedora]] },
      async ({ api, images, runtimes }) => {
        expect((await impactOf(api, "alice", "boat")).body.impact).toEqual({
          state: "unread",
          reason: "Sealant did not answer within 5 seconds",
        });
        const refused = await choose(api, "alice", {
          sessionRuntime: "boat",
          moves: { organizationDefault: true, projects: [sharedA] },
        });
        expect(refused.status).toBe(422);
        expect((await refused.json()).message).toContain(
          "Nothing was switched or moved: Mend could not read what that runtime runs (Sealant did not answer within 5 seconds)",
        );
        expect({ runtime: runtimes.get(A), image: images.get(sharedA) }).toEqual({
          runtime: undefined,
          image: fedora,
        });
        // Switching without moving still goes through.
        expect((await choose(api, "alice", { sessionRuntime: "boat" })).status).toBe(200);
        expect(runtimes.get(A)).toBe("boat");
      },
    );
  });

  it("refuses a member, before anything is read or written", async () => {
    await withWorld({}, async ({ api, runtimes, audited }) => {
      api.world.calls.length = 0;
      expect((await impactOf(api, "carol", "boat")).status).toBe(404);
      const response = await choose(api, "carol", {
        sessionRuntime: "boat",
        moves: { organizationDefault: true, projects: [] },
      });
      expect(response.status).toBe(404);
      expect({ runtimes: runtimes.size, audited, calls: api.world.calls }).toEqual({
        runtimes: 0,
        audited: [],
        calls: [],
      });
    });
  });

  it("refuses a runtime the server does not offer", async () => {
    await withWorld({}, async ({ api }) => {
      const response = await api.request(
        "alice",
        "GET",
        "/api/organization/settings/session-runtime/impact?sessionRuntime=k8s",
      );
      expect(response.status).toBe(400);
    });
  });
});
