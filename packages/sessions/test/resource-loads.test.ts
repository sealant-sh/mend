import {
  OrganizationsRepo,
  ProjectsRepo,
  ResourceLoadsRepo,
  ResourcesRepo,
  SessionsRepo,
  type StoredResourceDefinition,
  type StoredResourceLoad,
  WorktreesRepo,
} from "@mend/db";
import { OrganizationId, ProjectId, ResourceDefinitionId, ResourceLoadId } from "@mend/domain";
import {
  ImageDigest,
  presetDefinition,
  PresetVersion,
  ResourceName,
  resourceSpecDigest,
  type Viewer,
} from "@mend/domain/workbench";
import { ResourceScopes, type ResourceScope } from "@mend/sealant";
import { Effect, Fiber, Layer, Logger, ManagedRuntime, Redacted, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { loadNames } from "../src/resources/load-ops.ts";
import { ResourceLoads, ResourceLoadsLive } from "../src/resources/loads.ts";
import { ResourceRuntime } from "../src/resources/runtime.ts";

const projectId = ProjectId.make("load-project");
const spec = presetDefinition({
  name: ResourceName.make("db"),
  preset: "postgres",
  version: PresetVersion.make("17"),
  scope: "project",
});
const def: StoredResourceDefinition = {
  id: ResourceDefinitionId.make("def-load"),
  projectId,
  spec,
  specDigest: resourceSpecDigest(spec),
  imageDigest: ImageDigest.make(`sha256:${"a".repeat(64)}`),
  image: "postgres:17",
  addedBy: "alice",
  createdAt: new Date(),
  updatedAt: new Date(),
};
const project = {
  id: projectId,
  createdByUserId: "alice",
  organizationId: OrganizationId.make("load-org"),
  visibility: "shared" as const,
};
const viewer: Viewer = { userId: "alice", organizationId: project.organizationId, role: "member" };
const clock = { now: new Date("2026-11-01T14:02:00Z"), timeZone: "UTC" };

const world = (
  options: {
    readonly failRestore?: boolean;
    readonly restart?: StoredResourceLoad;
    readonly names?: ReadonlyArray<string>;
  } = {},
) => {
  const rows = new Map<ResourceLoadId, StoredResourceLoad>(
    options.restart === undefined ? [] : [[options.restart.id, options.restart]],
  );
  const calls: Array<{
    readonly argv: ReadonlyArray<string>;
    readonly user: string;
    readonly stdin: string;
  }> = [];
  const phases: Array<string> = [];
  const logs: Array<string> = [];
  let present = [...(options.names ?? [])];
  const scope: ResourceScope = {
    id: "scope",
    up: () => Effect.die("not used"),
    get: () => Effect.die("not used"),
    list: () => Effect.succeed([]),
    stop: () => Effect.die("not used"),
    archiveScope: () => Effect.succeed([]),
    archive: () => Effect.succeed([]),
    link: () => Effect.void,
    exec: (_key, input) =>
      Effect.promise(async () => {
        let stdin = "";
        if (input.stdin !== undefined)
          for await (const chunk of input.stdin) stdin += new TextDecoder().decode(chunk);
        calls.push({ argv: input.argv, user: input.user, stdin });
        const script = input.argv[2] ?? "";
        const row = [...rows.values()][0];
        if (row !== undefined) {
          const names = loadNames(row.database, row.id);
          if (script.includes('tmp="$1"')) {
            if (options.failRestore)
              return {
                exitCode: 1,
                truncated: false,
                timedOut: false,
                stdout: "",
                stderr: "private SQL",
              };
            present = [names.target, names.temp];
          }
          if (script.includes('target="$1"')) present = [names.target, names.prev];
          if (script.includes('prev="$1"')) present = [names.target];
          if (script.includes("for db in"))
            return {
              exitCode: 0,
              truncated: false,
              timedOut: false,
              stdout: `${present.join("\n")}\n`,
              stderr: "",
            };
          if (input.argv[0] === "sh" && script.includes("stat -c"))
            return { exitCode: 0, truncated: false, timedOut: false, stdout: "1234", stderr: "" };
        }
        return { exitCode: 0, truncated: false, timedOut: false, stdout: "", stderr: "" };
      }),
  };
  const deps = Layer.mergeAll(
    Layer.succeed(ResourceLoadsRepo, {
      begin: (row) =>
        Effect.sync(() => {
          rows.set(row.id, row);
          phases.push(row.phase);
          return row;
        }),
      get: (id) => Effect.sync(() => rows.get(id) ?? null),
      latest: () => Effect.succeed([...rows.values()]),
      live: () => Effect.succeed([...rows.values()]),
      advance: (row, phase, patch) =>
        Effect.sync(() => {
          rows.set(row.id, { ...(rows.get(row.id) ?? row), ...patch, phase });
          phases.push(phase);
        }),
      progress: (id, bytesDone) =>
        Effect.sync(() => {
          const row = rows.get(id);
          if (row !== undefined) rows.set(id, { ...row, bytesDone });
        }),
    }),
    Layer.mock(ResourcesRepo, {
      byName: () => Effect.succeed(def),
      listForProject: () => Effect.succeed([def]),
      listWithChoices: () => Effect.succeed([{ definition: def, choice: "own" }]),
    }),
    Layer.succeed(ResourceScopes, { of: () => Effect.succeed(scope) }),
    Layer.mock(ResourceRuntime, {
      start: () => Effect.succeed({ instance: { kind: "running" }, observedAt: clock.now }),
    }),
    Layer.mock(WorktreesRepo, { changeOwnerOf: () => Effect.succeed("alice") }),
    Layer.mock(SessionsRepo, {}),
    Layer.mock(ProjectsRepo, {}),
    Layer.mock(OrganizationsRepo, {}),
  );
  const runtime = ManagedRuntime.make(
    ResourceLoadsLive.pipe(
      Layer.provide(deps),
      Layer.provide(
        Logger.layer([Logger.make((event) => logs.push(String(Logger.formatJson.log(event))))]),
      ),
    ),
  );
  const untilDone = async (id: ResourceLoadId) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = rows.get(id);
      if (row?.phase === "done" || row?.phase === "failed") return row;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("load did not end");
  };
  return { runtime, rows, calls, phases, logs, untilDone };
};

describe("the load pipeline through ResourceLoads and a scope client", () => {
  it("streams, restores, installs, then saves checked previous data", async () => {
    const w = world();
    try {
      const row = await w.runtime.runPromise(
        Effect.flatMap(ResourceLoads, (loads) =>
          loads.begin(
            project,
            viewer,
            {
              name: "db",
              worktreeId: null,
              target: "shared",
              source: { kind: "upload", label: "staging.sql", bytesTotal: 9 },
            },
            clock,
          ),
        ),
      );
      await w.runtime.runPromise(
        Effect.flatMap(ResourceLoads, (loads) =>
          loads.feed(
            project,
            viewer,
            row.id,
            Stream.make(new TextEncoder().encode("select 1;")),
            clock,
          ),
        ),
      );
      const done = await w.untilDone(row.id);
      expect(w.phases).toEqual(["receiving", "restoring", "installing", "saving", "done"]);
      expect(done.savedPath).toMatch(/\/mend\/dumps\/app-.*\.dump/);
      expect(w.calls.find((c) => c.argv[2]?.includes("cat >"))?.stdin).toBe("select 1;");
      expect(w.calls.findIndex((c) => c.argv[2]?.includes('target="$1"'))).toBeLessThan(
        w.calls.findIndex((c) => c.argv[2]?.includes('prev="$1"')),
      );
      const observed = await w.runtime.runPromise(
        Effect.flatMap(ResourceLoads, (loads) => loads.read(project, viewer, row.id, clock)),
      );
      expect(observed.statusLine).toContain("previous data saved as a dump");
    } finally {
      await w.runtime.dispose();
    }
  });
  it("drops only the temporary database after a restore failure", async () => {
    const w = world({ failRestore: true });
    try {
      const row = await w.runtime.runPromise(
        Effect.flatMap(ResourceLoads, (loads) =>
          loads.begin(
            project,
            viewer,
            {
              name: "db",
              worktreeId: null,
              target: "shared",
              source: { kind: "upload", label: "bad.sql", bytesTotal: null },
            },
            clock,
          ),
        ),
      );
      await w.runtime.runPromise(
        Effect.flatMap(ResourceLoads, (loads) =>
          loads.feed(project, viewer, row.id, Stream.make(new Uint8Array([1])), clock),
        ),
      );
      expect((await w.untilDone(row.id)).phase).toBe("failed");
      expect(w.calls.some((c) => c.argv[2]?.includes('target="$1"'))).toBe(false);
      const last = w.calls.at(-1);
      expect(last?.argv[2]).toContain("with (force)");
      expect(last?.argv[4]).toContain("__load_");
    } finally {
      await w.runtime.dispose();
    }
  });
  it("pull credentials occur only on stdin, never in rows, argv, errors or replies", async () => {
    const w = world();
    const secret = "pipeline-password-private";
    try {
      const row = await w.runtime.runPromise(
        Effect.flatMap(ResourceLoads, (loads) =>
          loads.begin(
            project,
            viewer,
            {
              name: "db",
              worktreeId: null,
              target: "shared",
              source: {
                kind: "pull",
                url: Redacted.make(`postgres://alice:${secret}@staging/app`),
              },
            },
            clock,
          ),
        ),
      );
      await w.untilDone(row.id);
      expect(w.calls.find((c) => c.argv[2]?.includes("read -r PGPASSWORD"))?.stdin).toBe(
        `${secret}\n`,
      );
      const response = await w.runtime.runPromise(
        Effect.flatMap(ResourceLoads, (loads) => loads.read(project, viewer, row.id, clock)),
      );
      expect(JSON.stringify([...w.rows.values()])).not.toContain(secret);
      expect(JSON.stringify(w.calls.map((c) => c.argv))).not.toContain(secret);
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(w.logs.join("\n")).not.toContain(secret);
      expect(response.statusLine).toContain("staging/app");
      expect(response.statusLine).not.toContain("alice");
    } finally {
      await w.runtime.dispose();
    }
  });

  it("releases an upload's target when its request is interrupted", async () => {
    const w = world();
    try {
      const row = await w.runtime.runPromise(
        Effect.flatMap(ResourceLoads, (loads) =>
          loads.begin(
            project,
            viewer,
            {
              name: "db",
              worktreeId: null,
              target: "shared",
              source: { kind: "upload", label: "cancelled.sql", bytesTotal: null },
            },
            clock,
          ),
        ),
      );
      const request = w.runtime.runFork(
        Effect.flatMap(ResourceLoads, (loads) =>
          loads.feed(
            project,
            viewer,
            row.id,
            Stream.make(new Uint8Array([1])).pipe(Stream.concat(Stream.never)),
            clock,
          ),
        ),
      );
      for (let attempt = 0; attempt < 100 && w.rows.get(row.id)?.bytesDone === 0; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      await w.runtime.runPromise(Fiber.interrupt(request));
      expect(w.rows.get(row.id)?.phase).toBe("failed");
      expect(w.calls.some((c) => c.argv[2]?.includes('target="$1"'))).toBe(false);
    } finally {
      await w.runtime.dispose();
    }
  });
  it.each(["receiving", "pulling", "restoring"] as const)(
    "a restart before install discards an interrupted %s attempt",
    async (phase) => {
      const row: StoredResourceLoad = {
        id: ResourceLoadId.make("11111111-1111-1111-1111-111111111111"),
        projectId,
        definitionId: def.id,
        worktreeId: null,
        instanceKey: def.id,
        database: "app",
        target: "shared",
        label: "staging/app",
        startedBy: "alice",
        phase,
        bytesDone: 4,
        bytesTotal: null,
        savedPath: null,
        savedAt: null,
        message: null,
        createdAt: clock.now,
      };
      const w = world({ restart: row, names: ["app", loadNames("app", row.id).temp] });
      try {
        await w.runtime.runPromise(Effect.flatMap(ResourceLoads, (loads) => loads.recover));
        expect(w.rows.get(row.id)?.phase).toBe("failed");
        expect(w.calls.at(-1)?.argv[2]).toContain("with (force)");
        expect(w.calls.some((c) => c.argv[2]?.includes('target="$1"'))).toBe(false);
      } finally {
        await w.runtime.dispose();
      }
    },
  );
  it("a restart after installation saves the retained previous database", async () => {
    const row: StoredResourceLoad = {
      id: ResourceLoadId.make("22222222-2222-2222-2222-222222222222"),
      projectId,
      definitionId: def.id,
      worktreeId: null,
      instanceKey: def.id,
      database: "app",
      target: "shared",
      label: "staging/app",
      startedBy: "alice",
      phase: "saving",
      bytesDone: 4,
      bytesTotal: null,
      savedPath: "/mend/dumps/app-recovery.dump",
      savedAt: clock.now,
      message: null,
      createdAt: clock.now,
    };
    const w = world({ restart: row, names: ["app", loadNames("app", row.id).prev] });
    try {
      await w.runtime.runPromise(Effect.flatMap(ResourceLoads, (loads) => loads.recover));
      expect(w.rows.get(row.id)?.phase).toBe("done");
      expect(w.calls.find((c) => c.argv[2]?.includes('prev="$1"'))?.argv).toContain(row.savedPath);
      expect(w.calls.some((c) => c.argv[2]?.includes('tmp="$1"'))).toBe(false);
    } finally {
      await w.runtime.dispose();
    }
  });
});
