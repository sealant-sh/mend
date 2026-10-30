import { ProjectLinkNotFoundError, ProjectNotFoundError } from "@mend/db";
import { ProjectId, ProjectLinkId } from "@mend/domain";
import { Project, ProjectLink } from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * Removing a project keeps it (SLNT-96 Q5): Restore brings it back as it was, and only a purge
 * confirmed by its name deletes it, as a client of the HTTP API observes it.
 */

const privateAlice = ids("private-alice");
const sharedA = ids("shared-a");

let api: TenancyApi | undefined;
let removedStores: Array<string> = [];

/** Links declared on projects, held in memory: one to a removed project keeps its row. */
let links: Array<ProjectLink> = [];

const world = async (scene: { readonly failFirstPurge?: boolean } = {}) => {
  removedStores = [];
  links = [];
  api = await createTenancyApi(
    {},
    {
      errorDetail: { mode: "redacted" },
      implement: {
        engine: {
          refreshCaptureStatus: () => Effect.void,
          reconcileHotSessions: () => Effect.void,
          launchUnderWay: () => false,
          captureHolds: () => Effect.succeed([]),
        },
        checkpoints: { listForWorktree: () => Effect.succeed([]) },
        forwards: { listOpen: () => Effect.succeed([]) },
        reads: { changedFiles: () => Effect.succeed({ value: [], stamp: WORKTREE_STAMP }) },
        landings: { listForChange: () => Effect.succeed([]) },
        setupRuns: { unendedInWorktree: () => Effect.succeed(false) },
        sessionRepositories: {
          listForWorktree: () => Effect.succeed([]),
          listForSession: () => Effect.succeed([]),
          listForProject: () => Effect.succeed([]),
        },
        resources: { declaredNames: () => Effect.succeed([]) },
        links: {
          byId: (id) => {
            const found = links.find((link) => link.id === id);
            return found === undefined
              ? Effect.fail(new ProjectLinkNotFoundError({ linkId: id }))
              : Effect.succeed(found);
          },
          listAllForProject: (projectId) =>
            Effect.sync(() =>
              links
                .filter((link) => link.projectId === projectId)
                .map((link) => ({
                  link,
                  targetListed: api?.world.retainedProjects.has(link.linkedProjectId) !== true,
                })),
            ),
          remove: (id) =>
            Effect.sync(() => {
              links = links.filter((link) => link.id !== id);
            }),
        },
        hotWorkspaces: { listForProject: () => Effect.succeed([]) },
        projects: {
          byId: (id) =>
            Effect.suspend(() => {
              const project = api?.world.projects.get(id);
              return project === undefined || api?.world.retainedProjects.has(id) === true
                ? Effect.fail(new ProjectNotFoundError({ projectId: id }))
                : Effect.succeed(project);
            }),
        },
        store: {
          retainedStoreProblem: () => Effect.succeed(null),
          projectDiskUsage: () => Effect.succeed(1024),
          removeProjectStore: (storePath) =>
            Effect.sync(() => {
              removedStores.push(storePath);
              return {
                leftover:
                  scene.failFirstPurge === true && removedStores.length === 1 ? storePath : null,
              };
            }),
        },
      },
    },
  );
  return api;
};

afterEach(async () => {
  await api?.dispose();
  api = undefined;
});

const bodyOf = async (response: Response): Promise<unknown> => response.json();

describe("a removed project", () => {
  it("removes a project while keeping its store and records, and hides all ordinary reads", async () => {
    const instance = await world();
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/projects/${privateAlice.project}`,
    );
    expect(response.status).toBe(200);
    expect(removedStores).toEqual([]);
    expect(instance.world.sessions.has(privateAlice.session)).toBe(true);
    for (const path of [
      `/api/projects/${privateAlice.project}`,
      `/api/sessions/${privateAlice.session}`,
      `/api/worktrees/${privateAlice.worktree}`,
    ])
      expect((await instance.request("alice", "GET", path)).status).toBe(404);
    const removed = await instance.request("alice", "GET", "/api/removed-projects");
    expect(removed.status).toBe(200);
    expect(await bodyOf(removed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: privateAlice.project,
          rights: { restore: true, purge: true },
        }),
      ]),
    );
  });

  it("Restore brings back the same project and sessions without starting anything, and is idempotent", async () => {
    const instance = await world();
    const before = await bodyOf(await instance.request("alice", "GET", "/api/projects"));
    await instance.request("alice", "DELETE", `/api/projects/${privateAlice.project}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await instance.request(
        "alice",
        "POST",
        `/api/removed-projects/${privateAlice.project}/restore`,
        {},
      );
      expect(response.status).toBe(200);
      expect(await bodyOf(response)).toMatchObject({ id: privateAlice.project });
    }
    expect(await bodyOf(await instance.request("alice", "GET", "/api/projects"))).toEqual(before);
    expect(
      (await instance.request("alice", "GET", `/api/sessions/${privateAlice.session}`)).status,
    ).toBe(200);
    expect(removedStores).toEqual([]);
    expect(
      instance.world.calls.filter((call) =>
        /engine\.(?:provision|start|resume|launchSession|land)/.test(call),
      ),
    ).toEqual([]);
  });

  it("only removal authority may Restore, and private removed projects stay hidden", async () => {
    const instance = await world();
    await instance.request("alice", "DELETE", `/api/projects/${privateAlice.project}`);
    expect(
      (
        await instance.request(
          "bob",
          "POST",
          `/api/removed-projects/${privateAlice.project}/restore`,
          {},
        )
      ).status,
    ).toBe(404);
    expect(await bodyOf(await instance.request("bob", "GET", "/api/removed-projects"))).toEqual([]);
  });

  it("Restore refuses a taken name with a typed conflict and accepts a supplied new name", async () => {
    const instance = await world();
    await instance.request("alice", "DELETE", `/api/projects/${privateAlice.project}`);
    const conflict = await instance.request(
      "alice",
      "POST",
      `/api/removed-projects/${privateAlice.project}/restore`,
      { name: "shared-a" },
    );
    expect(conflict.status).toBe(409);
    expect(await bodyOf(conflict)).toMatchObject({ _tag: "ProjectNameConflict", name: "shared-a" });
    const restored = await instance.request(
      "alice",
      "POST",
      `/api/removed-projects/${privateAlice.project}/restore`,
      { name: "restored-api" },
    );
    expect(restored.status).toBe(200);
    expect(await bodyOf(restored)).toMatchObject({
      id: privateAlice.project,
      name: "restored-api",
    });
    expect(removedStores).toEqual([]);
  });

  it("hands a removed project's standbys to the hot pool, which drains them until they are gone", async () => {
    const instance = await world();
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/projects/${privateAlice.project}`,
    );
    expect(response.status).toBe(200);
    expect(instance.world.calls).toContain("engine.reconcileHotSessions");
  });

  it("purge requires the exact project name before deleting its retained store and rows", async () => {
    const instance = await world();
    await instance.request("alice", "DELETE", `/api/projects/${privateAlice.project}`);
    const wrong = await instance.request(
      "alice",
      "POST",
      `/api/removed-projects/${privateAlice.project}/purge`,
      { confirm: "wrong" },
    );
    expect(wrong.status).toBe(422);
    expect(await bodyOf(wrong)).toMatchObject({ _tag: "PurgeNotConfirmed" });
    expect(removedStores).toEqual([]);
    const storePath = instance.world.projects.get(privateAlice.project)?.storePath;
    const purged = await instance.request(
      "alice",
      "POST",
      `/api/removed-projects/${privateAlice.project}/purge`,
      { confirm: "private-alice" },
    );
    expect(purged.status).toBe(200);
    expect(await bodyOf(purged)).toMatchObject({ purged: true });
    expect(removedStores).toEqual([storePath]);
    expect(instance.world.calls).toContain(`projects.purge:${privateAlice.project}`);
    expect(instance.world.sessions.has(privateAlice.session)).toBe(false);
  });

  it("a failed purge keeps the project hidden, refuses Restore, and a second purge finishes", async () => {
    const instance = await world({ failFirstPurge: true });
    await instance.request("alice", "DELETE", `/api/projects/${privateAlice.project}`);
    const first = await instance.request(
      "alice",
      "POST",
      `/api/removed-projects/${privateAlice.project}/purge`,
      { confirm: "private-alice" },
    );
    expect(first.status).toBe(409);
    expect(instance.world.sessions.has(privateAlice.session)).toBe(true);
    expect(
      (
        await instance.request(
          "alice",
          "POST",
          `/api/removed-projects/${privateAlice.project}/restore`,
          {},
        )
      ).status,
    ).toBe(409);
    expect(
      (await instance.request("alice", "GET", `/api/projects/${privateAlice.project}`)).status,
    ).toBe(404);
    expect(
      (
        await instance.request(
          "alice",
          "POST",
          `/api/removed-projects/${privateAlice.project}/purge`,
          { confirm: "private-alice" },
        )
      ).status,
    ).toBe(200);
    expect(instance.world.sessions.has(privateAlice.session)).toBe(false);
  });

  it("a shared member can see removal metadata but cannot Restore or purge, even as creator", async () => {
    const instance = await world();
    const project = instance.world.projects.get(privateAlice.project);
    if (project === undefined) throw new Error("missing project");
    instance.world.addProject(
      new Project({ ...project, visibility: "shared", createdByUserId: "carol" }),
    );
    expect((await instance.request("alice", "DELETE", `/api/projects/${project.id}`)).status).toBe(
      200,
    );
    const rows = await bodyOf(await instance.request("carol", "GET", "/api/removed-projects"));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: project.id, rights: { restore: false, purge: false } }),
      ]),
    );
    for (const verb of ["restore", "purge"])
      expect(
        (
          await instance.request(
            "carol",
            "POST",
            `/api/removed-projects/${project.id}/${verb}`,
            verb === "purge" ? { confirm: project.name } : {},
          )
        ).status,
      ).toBe(403);
  });

  it.each([false, true])(
    "restores a removed scratch project with an occupied slot: %s",
    async (occupied) => {
      const instance = await world();
      const project = instance.world.projects.get(privateAlice.project);
      if (project === undefined) throw new Error("missing project");
      instance.world.addProject(new Project({ ...project, scratchOwnerUserId: "alice" }));
      await instance.request("alice", "DELETE", `/api/projects/${project.id}`);
      if (occupied)
        instance.world.addProject(
          new Project({
            ...project,
            id: ProjectId.make("new-scratch"),
            name: "new-scratch",
            scratchOwnerUserId: "alice",
          }),
        );
      const response = await instance.request(
        "alice",
        "POST",
        `/api/removed-projects/${project.id}/restore`,
        {},
      );
      expect(response.status).toBe(200);
      expect(await bodyOf(response)).toMatchObject({
        id: project.id,
        scratchOwnerUserId: occupied ? null : "alice",
        visibility: "private",
      });
    },
  );

  it("names a removed project whose link still holds a name, and lets the link be deleted", async () => {
    const instance = await world();
    const shared = instance.world.projects.get(ProjectId.make(sharedA.project));
    if (shared === undefined) throw new Error("missing project");
    instance.world.addProject(
      new Project({ ...shared, id: ProjectId.make("third"), name: "third" }),
    );
    const held = new ProjectLink({
      id: ProjectLinkId.make("link-lib"),
      projectId: shared.id,
      linkedProjectId: ProjectId.make(privateAlice.project),
      name: "lib",
      worktreeName: "main",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    links = [held];
    await instance.request("alice", "DELETE", `/api/projects/${privateAlice.project}`);
    const clash = await instance.request("alice", "POST", `/api/projects/${shared.id}/links`, {
      linkedProjectId: "third",
      name: "lib",
      worktreeName: null,
    });
    expect(clash.status).toBe(422);
    expect(await bodyOf(clash)).toMatchObject({
      message: expect.stringContaining("the removed project private-alice"),
    });
    const deleted = await instance.request(
      "alice",
      "DELETE",
      `/api/projects/${shared.id}/links/${held.id}`,
    );
    expect({ status: deleted.status, links }).toEqual({ status: 204, links: [] });
  });

  it("counts every kept project of the organization on an owner's disk report, a teammate's private one too", async () => {
    const instance = await world();
    const project = instance.world.projects.get(privateAlice.project);
    if (project === undefined) throw new Error("missing project");
    await instance.request("alice", "DELETE", `/api/projects/${project.id}`);
    instance.world.setVisibility("private-alice", "private");
    const asOwner = await instance.request("alice", "GET", "/api/removed-projects/disk");
    const asMember = await instance.request("carol", "GET", "/api/removed-projects/disk");
    expect({ owner: await bodyOf(asOwner), member: await bodyOf(asMember) }).toEqual({
      owner: { projects: 1, bytes: 1024, sharedBytes: 0 },
      member: { projects: 0, bytes: 0, sharedBytes: 0 },
    });
  });
});
