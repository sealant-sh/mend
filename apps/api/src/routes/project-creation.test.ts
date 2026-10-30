import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { ProjectNotFoundError, ProjectPublicationUnconfirmed, ProjectsRepo } from "@mend/db";
import { ProjectId } from "@mend/domain";
import { GitAuthor, Project, ResolvedGitAuthor } from "@mend/domain/workbench";
import { Store, StoreConfig, UNSETTLED_REPOSITORY_MARKER } from "@mend/store";
import { Duration, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { sweepUnsettledRepositories } from "../project-creation.ts";

const decodeProject = Schema.decodeUnknownSync(Schema.toCodecJson(Project));
const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)("git", args, { cwd, encoding: "utf8" })).stdout.trim();
const fixture = async (
  projects: { readonly publishInitialized?: ProjectsRepo["Service"]["publishInitialized"] } = {},
) => {
  const profile = { name: "alice", email: "alice@example.invalid" };
  let setting: GitAuthor | null = new GitAuthor({
    name: "Author alice",
    email: "alice@example.com",
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-project-creation-"));
  const layer = Store.layer.pipe(Layer.provide(Layer.succeed(StoreConfig, { root })));
  const api = await createTenancyApi(
    {},
    {
      profiles: { alice: profile },
      implement: {
        projects,
        gitAccess: { mode: () => Effect.succeed(null) },
        store: {
          createRepository: (directory, commit) =>
            Effect.gen(function* () {
              return yield* (yield* Store).createRepository(directory, commit);
            }).pipe(Effect.provide(layer)),
          settleCreatedRepository: (storePath) =>
            Effect.gen(function* () {
              return yield* (yield* Store).settleCreatedRepository(storePath);
            }).pipe(Effect.provide(layer)),
          removeProjectStore: (storePath) =>
            Effect.gen(function* () {
              return yield* (yield* Store).removeProjectStore(storePath);
            }).pipe(Effect.provide(layer)),
          listBranches: (storePath) =>
            Effect.gen(function* () {
              return yield* (yield* Store).listBranches(storePath);
            }).pipe(Effect.provide(layer)),
        },
        gitAuthor: {
          resolve: (userId) =>
            Effect.succeed(
              new ResolvedGitAuthor({
                ...(userId === "alice"
                  ? (setting ?? profile)
                  : { name: userId, email: `${userId}@example.invalid` }),
                source: setting === null ? "account" : "setting",
              }),
            ),
        },
      },
    },
  );
  return {
    api,
    root,
    profile,
    setAuthor: (author: GitAuthor | null) => {
      setting = author;
    },
    dispose: async () => {
      await api.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
};
const create = async (api: Awaited<ReturnType<typeof fixture>>["api"], name: string) => {
  const response = await api.request("alice", "POST", "/api/projects/new", { name });
  expect(response.status).toBe(200);
  return decodeProject(await response.json());
};
describe("private project creation over HTTP", () => {
  it("uses the last available candidate, then refuses exhaustion without creating a store", async () => {
    const f = await fixture();
    try {
      const template = [...f.api.world.projects.values()][0];
      if (template === undefined) throw new Error("the world needs a project template");
      for (let i = 1; i <= 99; i++)
        f.api.world.addProject(
          new Project({
            ...template,
            id: ProjectId.make(`held-${i}`),
            name: i === 1 ? "full" : `full-${i}`,
            createdByUserId: "carol",
            visibility: "private",
            scratchOwnerUserId: null,
            storePath: `/unused/${i}/repo.git`,
          }),
        );
      const last = await create(f.api, "full");
      expect(last.name).toBe("full-100");
      const refused = await f.api.request("alice", "POST", "/api/projects/new", { name: "full" });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({
        message: "No project name is available for this request. Choose another name.",
      });
      expect(fs.readdirSync(f.root)).toEqual([last.id]);
    } finally {
      await f.dispose();
    }
  });
  it("commits with the saved author or account fallback", async () => {
    const f = await fixture();
    try {
      const named = await create(f.api, "authored");
      expect(await git(named.storePath, "log", "--format=%an|%ae|%cn|%ce|%s|%P")).toBe(
        "Author alice|alice@example.com|Author alice|alice@example.com|Initial commit|",
      );
      f.setAuthor(null);
      const scratchResponse = await f.api.request("alice", "POST", "/api/projects/scratch", {});
      expect(scratchResponse.status).toBe(200);
      const scratch = decodeProject(await scratchResponse.json());
      expect(await git(scratch.storePath, "log", "--format=%an|%ae|%cn|%ce|%s|%P")).toBe(
        "alice|alice@example.invalid|alice|alice@example.invalid|Initial commit|",
      );
    } finally {
      await f.dispose();
    }
  });

  it("authors as the email's local part when the account name is not one git stores as it is", async () => {
    const f = await fixture();
    try {
      f.setAuthor(null);
      for (const [name, project] of [
        ["Jane <Team>", "angled"],
        ["<>", "bracketed"],
      ] as const) {
        f.profile.name = name;
        const created = await create(f.api, project);
        expect(await git(created.storePath, "log", "--format=%an|%ae|%cn|%ce")).toBe(
          "alice|alice@example.invalid|alice|alice@example.invalid",
        );
      }
    } finally {
      await f.dispose();
    }
  });

  it("keeps scratch fixed after account rename and author changes, and never reuses an ordinary scratch-prefixed project", async () => {
    const f = await fixture();
    try {
      await create(f.api, "scratch-alice");
      const response = await f.api.request("alice", "POST", "/api/projects/scratch", {});
      const original = decodeProject(await response.json());
      expect(original.name).toBe("scratch-alice-2");
      f.profile.name = "Renamed Person";
      f.setAuthor(new GitAuthor({ name: "", email: "invalid" }));
      const again = await f.api.request("alice", "POST", "/api/projects/scratch", {});
      expect(again.status).toBe(200);
      expect(decodeProject(await again.json())).toEqual(original);
      expect(fs.readdirSync(f.root)).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  });

  it("gives concurrent named requests separate repositories with matching names in their READMEs", async () => {
    const f = await fixture();
    try {
      const projects = await Promise.all(Array.from({ length: 5 }, () => create(f.api, "race")));
      expect(projects.map((p) => p.name).toSorted()).toEqual([
        "race",
        "race-2",
        "race-3",
        "race-4",
        "race-5",
      ]);
      expect(new Set(projects.map((p) => p.id)).size).toBe(5);
      expect(fs.readdirSync(f.root)).toHaveLength(5);
      for (const project of projects)
        expect(await git(project.storePath, "show", "main:README.md")).toBe(`# ${project.name}`);
    } finally {
      await f.dispose();
    }
  });

  it("counts an invisible member's name without returning that member's project, and scopes names to the organization", async () => {
    const f = await fixture();
    try {
      const hiddenResponse = await f.api.request("carol", "POST", "/api/projects/new", {
        name: "private-name",
      });
      const hidden = decodeProject(await hiddenResponse.json());
      const own = await create(f.api, "private-name");
      expect(own.name).toBe("private-name-2");
      expect((await f.api.request("alice", "GET", `/api/projects/${hidden.id}`)).status).toBe(404);
      const otherOrganization = await f.api.request("bob", "POST", "/api/projects/new", {
        name: "private-name",
      });
      expect(decodeProject(await otherOrganization.json()).name).toBe("private-name");
    } finally {
      await f.dispose();
    }
  });
  it("returns a ready private named project, allocates collisions, and keeps it invisible to another member", async () => {
    const f = await fixture();
    try {
      const first = await create(f.api, "notes");
      const second = await create(f.api, "notes");
      expect(first).toMatchObject({
        name: "notes",
        visibility: "private",
        createdByUserId: "alice",
        originUrl: null,
        adoptedSha: await git(first.storePath, "rev-parse", "main"),
        defaultBranch: "main",
        scratchOwnerUserId: null,
      });
      expect(second.name).toBe("notes-2");
      const branches = await f.api.request("alice", "GET", `/api/projects/${first.id}/branches`);
      expect(branches.status).toBe(200);
      expect(await branches.json()).toMatchObject([{ name: "main", isDefault: true }]);
      const listed = await f.api.request("carol", "GET", "/api/projects");
      expect(JSON.stringify(await listed.json())).not.toContain(first.id);
      expect((await f.api.request("carol", "GET", `/api/projects/${first.id}`)).status).toBe(404);
    } finally {
      await f.dispose();
    }
  });
  it("concurrent scratch first use and reuse converge on one ready repository", async () => {
    const f = await fixture();
    try {
      const answers = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const r = await f.api.request("alice", "POST", "/api/projects/scratch", {});
          expect(r.status).toBe(200);
          return decodeProject(await r.json());
        }),
      );
      expect(new Set(answers.map((p) => p.id)).size).toBe(1);
      expect(answers[0]).toMatchObject({
        name: "scratch-alice",
        scratchOwnerUserId: "alice",
        visibility: "private",
      });
      expect(fs.readdirSync(f.root)).toHaveLength(1);
      const again = await f.api.request("alice", "POST", "/api/projects/scratch", {});
      expect(decodeProject(await again.json()).id).toBe(answers[0]?.id);
      expect((await f.api.request("carol", "GET", `/api/projects/${answers[0]?.id}`)).status).toBe(
        404,
      );
    } finally {
      await f.dispose();
    }
  });
  it("rejects invalid names, extra authority or source fields, unauthenticated calls and accounts without membership", async () => {
    const f = await fixture();
    try {
      for (const name of ["", "My App", "../etc", "a".repeat(65)]) {
        const r = await f.api.request("alice", "POST", "/api/projects/new", { name });
        expect(r.status, `${name}: ${await r.text()}`).toBe(422);
      }
      for (const extra of [
        { source: "/etc" },
        { visibility: "shared" },
        { organizationId: "other" },
        { createdByUserId: "carol" },
      ])
        expect(
          (await f.api.request("alice", "POST", "/api/projects/new", { name: "notes", ...extra }))
            .status,
        ).toBe(400);
      expect(
        (await f.api.request("alice", "POST", "/api/projects/scratch", { owner: "carol" })).status,
      ).toBe(400);
      expect(
        (await f.api.request(null, "POST", "/api/projects/new", { name: "notes" })).status,
      ).toBe(401);
      expect(
        (await f.api.request("dave", "POST", "/api/projects/new", { name: "notes" })).status,
      ).toBe(422);
      expect(fs.readdirSync(f.root)).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});

const marked = (storePath: string) =>
  fs.existsSync(path.join(path.dirname(storePath), UNSETTLED_REPOSITORY_MARKER));
describe("repositories no project row claimed", () => {
  it("settles a created project's repository once its row exists", async () => {
    const f = await fixture();
    try {
      const project = await create(f.api, "settled");
      expect(marked(project.storePath)).toBe(false);
    } finally {
      await f.dispose();
    }
  });
  it("keeps an unconfirmed or abandoned repository until the startup sweep finds no row for it and it is old", async () => {
    const f = await fixture({
      publishInitialized: (input) =>
        Effect.fail(new ProjectPublicationUnconfirmed({ projectId: input.id, cause: "lost" })),
    });
    try {
      const refused = await f.api.request("alice", "POST", "/api/projects/new", {
        name: "unconfirmed",
      });
      expect(refused.status).toBe(422);
      const [unconfirmedId] = fs.readdirSync(f.root);
      if (unconfirmedId === undefined) throw new Error("the unconfirmed repository is gone");
      const unconfirmed = path.join(f.root, unconfirmedId, "repo.git");
      expect(marked(unconfirmed)).toBe(true);
      const store = Store.layer.pipe(Layer.provide(Layer.succeed(StoreConfig, { root: f.root })));
      const createdOnly = (id: string) =>
        Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* Store).createRepository(id, {
              readme: "# lost\n",
              author: { name: "alice", email: "alice@example.invalid" },
              at: new Date(),
            });
          }).pipe(Effect.provide(store)),
        );
      // A process lost between the repository and its row leaves exactly this behind.
      const abandoned = await createdOnly("abandoned");
      const registered = await createdOnly("registered");
      const template = [...f.api.world.projects.values()][0];
      if (template === undefined) throw new Error("the world needs a project template");
      f.api.world.addProject(
        new Project({
          ...template,
          id: ProjectId.make("registered"),
          name: "registered",
          storePath: registered.storePath,
        }),
      );
      const sweep = () =>
        Effect.runPromise(
          sweepUnsettledRepositories(Duration.minutes(10)).pipe(
            Effect.provide(
              Layer.merge(
                store,
                Layer.mock(ProjectsRepo, {
                  byId: (id) => {
                    const project = f.api.world.projects.get(id);
                    return project === undefined
                      ? Effect.fail(new ProjectNotFoundError({ projectId: id }))
                      : Effect.succeed(project);
                  },
                }),
              ),
            ),
          ),
        );
      await sweep();
      expect([unconfirmed, abandoned.storePath, registered.storePath].map(marked)).toEqual([
        true,
        true,
        false,
      ]);
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      for (const storePath of [unconfirmed, abandoned.storePath])
        fs.utimesSync(
          path.join(path.dirname(storePath), UNSETTLED_REPOSITORY_MARKER),
          hourAgo,
          hourAgo,
        );
      fs.writeFileSync(
        path.join(path.dirname(registered.storePath), UNSETTLED_REPOSITORY_MARKER),
        "",
      );
      fs.utimesSync(
        path.join(path.dirname(registered.storePath), UNSETTLED_REPOSITORY_MARKER),
        hourAgo,
        hourAgo,
      );
      await sweep();
      expect(fs.readdirSync(f.root)).toEqual(["registered"]);
      expect(marked(registered.storePath)).toBe(false);
      expect(await git(registered.storePath, "rev-parse", "main")).toBe(registered.headSha);
    } finally {
      await f.dispose();
    }
  });
});
