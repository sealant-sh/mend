import { SealantRunId, SessionProcessId } from "@mend/domain";
import { Change as SessionChange } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";

import {
  MendApi,
  NewWorktree,
  ProcessLogPage,
  ProjectBranch,
  ProjectDefaultShellProfileRequest,
  ProjectInheritUserSkillsRequest,
} from "./index.ts";

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
  it("preserves not-found and validation status codes as separate schemas", () => {
    const statuses = new Map<string, ReadonlySet<number>>();

    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint, errors }) => {
        if (typedEndpointNames.has(endpoint.name)) {
          statuses.set(endpoint.name, new Set(errors.keys()));
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
        if (conversationEndpointNames.has(endpoint.name)) {
          statuses.set(endpoint.name, new Set(errors.keys()));
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
          statuses.set(endpoint.name, new Set(errors.keys()));
        }
      },
    });
    expect([...statuses.keys()].toSorted()).toEqual([
      "checkpoint",
      "create",
      "createSession",
      "detail",
      "list",
      "remove",
    ]);
    for (const [name, codes] of statuses) {
      expect(codes.has(404), `${name} should preserve not-found`).toBe(true);
      expect(codes.has(500), `${name} should not collapse its typed errors`).toBe(false);
    }
    expect(statuses.get("create")?.has(409), "create should preserve WorktreeNameTaken").toBe(true);
    expect(statuses.get("remove")?.has(409), "remove should preserve WorktreeActive").toBe(true);
    expect(statuses.get("remove")?.has(422), "remove should preserve StoreFailure").toBe(true);
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
  });

  it("exposes the authenticated project skill-inheritance update contract", () => {
    const endpoints = new Set<string>();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint }) => {
        if (group.identifier === "projects") endpoints.add(endpoint.name);
      },
    });
    expect(endpoints.has("inheritUserSkills")).toBe(true);
    expect(
      Schema.decodeUnknownSync(ProjectInheritUserSkillsRequest)({ inheritUserSkills: false })
        .inheritUserSkills,
    ).toBe(false);
    expect(() => Schema.decodeUnknownSync(ProjectInheritUserSkillsRequest)({})).toThrow();
  });

  it("exposes the project default-shell-profile switch", () => {
    const endpoints = new Set<string>();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint }) => {
        if (group.identifier === "projects") endpoints.add(endpoint.name);
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
});
