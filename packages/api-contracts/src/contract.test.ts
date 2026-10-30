import { SealantRunId, SessionProcessId } from "@mend/domain";
import { Change as SessionChange } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import {
  HandoffUnsupported,
  CreateProjectByName,
  EnsureScratchProject,
  MendApi,
  NewWorktree,
  ProcessLogPage,
  ProjectBranch,
  ProjectDefaultShellProfileRequest,
  ProjectInheritUserSkillsRequest,
  ProjectInstallCommandRequest,
  ProjectInstallEnabledRequest,
  StoreFailure,
} from "./index.ts";

const wire = (schema: Schema.Top) =>
  Schema.toCodecJson(Schema.make<Schema.Codec<unknown, unknown>>(schema.ast));

const conversationEndpointNames = new Set(["submitTurn", "interruptTurn", "respondAgentRequest"]);

const typedEndpointNames = new Set([
  "followUpDeliver",
  "openReview",
  "processLogs",
  "reviewDiff",
  "renameShell",
  "sliceComment",
]);

describe("typed HTTP error contracts", () => {
  it("offers two source-free project creation endpoints alongside unchanged adoption", () => {
    const routes = new Map<string, string>();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint, errors }) => {
        if (group.identifier !== "projects") return;
        routes.set(endpoint.identifier, `${endpoint.method} ${endpoint.path}`);
        if (endpoint.identifier === "createNew" || endpoint.identifier === "ensureScratch") {
          expect(errors.has(422)).toBe(true);
        }
      },
    });
    expect(routes.get("createNew")).toBe("POST /api/projects/new");
    expect(routes.get("ensureScratch")).toBe("POST /api/projects/scratch");
    expect(routes.get("adopt")).toBe("POST /api/projects");
    expect(Schema.decodeUnknownSync(CreateProjectByName)({ name: "notes" }).name).toBe("notes");
    expect(() =>
      Schema.decodeUnknownSync(CreateProjectByName, { onExcessProperty: "error" })({
        name: "notes",
        source: "/etc",
      }),
    ).toThrow();
    expect(Schema.decodeUnknownSync(EnsureScratchProject)({})).toEqual({});
    expect(() => Schema.decodeUnknownSync(EnsureScratchProject)({ owner: "other" })).toThrow();
  });
  it("preserves not-found and validation status codes as separate schemas", () => {
    const statuses = new Map<string, ReadonlySet<number>>();

    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint, errors }) => {
        if (typedEndpointNames.has(endpoint.identifier)) {
          statuses.set(endpoint.identifier, new Set(errors.keys()));
        }
      },
    });

    for (const name of typedEndpointNames) {
      const endpointStatuses = statuses.get(name);
      expect(endpointStatuses?.has(404), `${name} should preserve NotFound`).toBe(true);
      expect(endpointStatuses?.has(422), `${name} should preserve StoreFailure`).toBe(true);
      expect(endpointStatuses?.has(500), `${name} should not collapse its typed errors`).toBe(
        false,
      );
    }
  });

  it("preserves conversation not-found and conflict statuses", () => {
    const statuses = new Map<string, ReadonlySet<number>>();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint, errors }) => {
        if (conversationEndpointNames.has(endpoint.identifier)) {
          statuses.set(endpoint.identifier, new Set(errors.keys()));
        }
      },
    });
    for (const name of conversationEndpointNames) {
      expect(statuses.get(name)?.has(404), `${name} should preserve NotFound`).toBe(true);
      expect(statuses.get(name)?.has(409), `${name} should preserve conflict`).toBe(true);
      expect(statuses.get(name)?.has(500), `${name} should not collapse errors`).toBe(false);
    }
  });

  it("keeps worktree endpoint statuses typed: 404/409/422 never collapse to 500", () => {
    const statuses = new Map<string, ReadonlySet<number>>();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint, errors }) => {
        if (group.identifier === "worktrees") {
          statuses.set(endpoint.identifier, new Set(errors.keys()));
        }
      },
    });
    expect([...statuses.keys()].toSorted()).toEqual([
      "checkpoint",
      "contents",
      "create",
      "createSession",
      "detail",
      "diff",
      "list",
      "previews",
      "raw",
      "rawHead",
      "remove",
    ]);
    for (const [name, codes] of statuses) {
      expect(codes.has(404), `${name} should preserve not-found`).toBe(true);
      expect(codes.has(500), `${name} should not collapse its typed errors`).toBe(false);
    }
    for (const name of ["raw", "rawHead"]) {
      expect(statuses.get(name)?.has(503)).toBe(true);
      expect(statuses.get(name)?.has(413)).toBe(true);
      expect(statuses.get(name)?.has(409)).toBe(false);
    }
    expect(statuses.get("create")?.has(409), "create should preserve WorktreeNameTaken").toBe(true);
    expect(statuses.get("remove")?.has(409), "remove should preserve RemovalRefused").toBe(true);
    expect(statuses.get("remove")?.has(403), "remove should preserve RemovalForbidden").toBe(true);
    expect(statuses.get("remove")?.has(422), "remove should preserve StoreFailure").toBe(true);
    expect(
      statuses.get("createSession")?.has(409),
      "createSession should preserve RemovalInProgress",
    ).toBe(true);
    expect(statuses.get("diff")?.has(422), "diff should preserve StoreFailure").toBe(true);
    expect(statuses.get("contents")?.has(422), "contents should preserve StoreFailure").toBe(true);
  });

  it("decodes worktree payloads: old-client omissions and the legacy change shape", () => {
    // `{}` — an old client that knows neither key — still provisions.
    const bare = Schema.decodeUnknownSync(NewWorktree)({});
    expect(bare.name).toBeNull();
    expect(bare.base).toBeNull();

    // The mobile-in-the-field guarantee: a change row decodes with the session
    // mirror present AND null, and encodes it back untouched.
    const wireCodec = Schema.toCodecJson(SessionChange);
    const withMirror = Schema.decodeUnknownSync(wireCodec)({
      id: "chg-1",
      projectId: "proj-1",
      worktreeId: "wt-1",
      sessionId: "sess-1",
      branch: "mend/fix-auth",
      baseSha: "abc",
      headSha: null,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    expect(withMirror.sessionId).toBe("sess-1");
    expect(Schema.encodeSync(wireCodec)(withMirror)).toMatchObject({ sessionId: "sess-1" });
    const orphaned = Schema.decodeUnknownSync(wireCodec)({
      id: "chg-2",
      projectId: "proj-1",
      worktreeId: "wt-1",
      sessionId: null,
      branch: "mend/fix-auth",
      baseSha: "abc",
      headSha: null,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    expect(orphaned.sessionId).toBeNull();
    expect(Schema.encodeSync(wireCodec)(orphaned)).toMatchObject({ sessionId: null });
  });

  it("exposes the project skill-inheritance endpoint and requires its switch", () => {
    const endpoints = new Set<string>();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint }) => {
        if (group.identifier === "projects") endpoints.add(endpoint.identifier);
      },
    });
    expect(endpoints.has("inheritUserSkills")).toBe(true);
    expect(
      Schema.decodeUnknownSync(ProjectInheritUserSkillsRequest)({ inheritUserSkills: false })
        .inheritUserSkills,
    ).toBe(false);
    expect(() => Schema.decodeUnknownSync(ProjectInheritUserSkillsRequest)({})).toThrow();
  });

  it("exposes the automatic install switch beside the install command it keeps", () => {
    const endpoints = new Set<string>();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint }) => {
        if (group.identifier === "projects") endpoints.add(endpoint.identifier);
      },
    });
    expect(endpoints.has("installEnabled")).toBe(true);
    expect(endpoints.has("installDetection")).toBe(true);
    expect(endpoints.has("installCommand")).toBe(true);
    expect(
      Schema.decodeUnknownSync(ProjectInstallEnabledRequest)({ installEnabled: false })
        .installEnabled,
    ).toBe(false);
    expect(() => Schema.decodeUnknownSync(ProjectInstallEnabledRequest)({})).toThrow();
    // The old payload still decodes: the custom command is set on its own route.
    expect(
      Schema.decodeUnknownSync(ProjectInstallCommandRequest)({ installCommand: null })
        .installCommand,
    ).toBeNull();
  });

  it("exposes the project default-shell-profile switch", () => {
    const endpoints = new Set<string>();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint }) => {
        if (group.identifier === "projects") endpoints.add(endpoint.identifier);
      },
    });
    expect(endpoints.has("defaultShellProfile")).toBe(true);
    expect(
      Schema.decodeUnknownSync(ProjectDefaultShellProfileRequest)({ defaultShellProfile: false })
        .defaultShellProfile,
    ).toBe(false);
    expect(() => Schema.decodeUnknownSync(ProjectDefaultShellProfileRequest)({})).toThrow();
  });

  it("encodes a process-log response as the endpoint's class schema", () => {
    const page = new ProcessLogPage({
      processId: SessionProcessId.make("process-1"),
      sealantSessionId: "pty-1",
      sealantRunId: SealantRunId.make("run-1"),
      requestedFrom: "0",
      firstSequence: "1",
      lastSequence: "1",
      nextFrom: "2",
      status: "running",
      chunks: [{ sequence: "1", dataBase64: "aGVsbG8=" }],
      telemetryLoss: "unknown",
      telemetryNote: "Sealant does not report retained-range loss for interactive-session output.",
    });

    expect(Schema.encodeUnknownSync(ProcessLogPage)(page)).toMatchObject({
      processId: "process-1",
      nextFrom: "2",
      telemetryLoss: "unknown",
    });
  });

  it("ProjectBranch encodes instances but refuses shape-alike plain objects", () => {
    // Class schemas encode INSTANCES only. A handler returning `{ name, sha, … }` compiles
    // (structural typing) and then 400s every response at runtime — observed live on
    // /projects/:id/refresh (v0.12.0); handlers must construct `new ProjectBranch(...)`.
    const codec = Schema.toCodecJson(Schema.Array(ProjectBranch));
    const fields = {
      name: "main",
      sha: "5654c8215770c29d395300a0d358739c767973b5",
      committedAt: "2026-08-30T02:21:51+03:00",
      isDefault: true,
    };
    expect(Schema.encodeUnknownSync(codec)([new ProjectBranch(fields)])).toMatchObject([
      { name: "main", isDefault: true },
    ]);
    expect(() => Schema.encodeUnknownSync(codec)([fields])).toThrow();
  });

  it("StoreFailure carries the unknown base on the wire, and reads a body without one", () => {
    const codec = Schema.toCodecJson(StoreFailure);
    expect(
      Schema.encodeUnknownSync(codec)(
        new StoreFailure({ message: "base unknown", unknownBase: "fix/login" }),
      ),
    ).toEqual({ _tag: "StoreFailure", message: "base unknown", unknownBase: "fix/login" });
    expect(
      Schema.encodeUnknownSync(codec)(new StoreFailure({ message: "No space left on device" })),
    ).toEqual({ _tag: "StoreFailure", message: "No space left on device" });
    expect(
      Schema.decodeUnknownSync(codec)({ _tag: "StoreFailure", message: "older server" }),
    ).toMatchObject({ message: "older server" });
  });

  it("serves the mode switch on the wire every released CLI and the mobile app call", () => {
    const routes: Array<{
      method: string;
      path: string;
      payloads: ReadonlyArray<Schema.Top>;
      unprocessable: ReadonlyArray<Schema.Top>;
    }> = [];
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint, errors }) => {
        if (group.identifier !== "sessions" || !endpoint.path.endsWith("/handoff")) return;
        routes.push({
          method: endpoint.method,
          path: endpoint.path,
          payloads: [...endpoint.payload.values()].flatMap((entry) => entry.schemas),
          unprocessable: errors.get(422) ?? [],
        });
      },
    });

    expect(routes).toHaveLength(1);
    const [route] = routes;
    expect(route?.method).toBe("POST");
    expect(route?.path).toBe("/api/sessions/:id/handoff");
    expect(route?.payloads).toHaveLength(1);

    const decode = (input: unknown) =>
      route?.payloads.map((schema) => Schema.decodeUnknownSync(wire(schema))(input));
    expect(decode({ to: "pty" })).toMatchObject([{ to: "pty" }]);
    expect(decode({ to: "protocol", prompt: "carry on" })).toMatchObject([
      { to: "protocol", prompt: "carry on" },
    ]);
    expect(() => decode({ to: "terminal" })).toThrow();

    const refusal = new HandoffUnsupported({ sessionId: "s-1", harness: "pi", to: "protocol" });
    const encoded = route?.unprocessable
      .filter((schema) => Schema.is(schema)(refusal))
      .map((schema) => Schema.encodeUnknownSync(wire(schema))(refusal));
    expect(encoded).toEqual([
      { _tag: "HandoffUnsupported", sessionId: "s-1", harness: "pi", to: "protocol" },
    ]);
  });
});
