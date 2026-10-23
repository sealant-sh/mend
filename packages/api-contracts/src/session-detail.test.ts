import { ProjectId, SealantWorkspaceId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Session } from "@mend/domain/workbench";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { SessionControlView, SessionDetail } from "./index.ts";

const NOW = new Date("2026-10-19T08:15:30.123Z");

const session = new Session({
  id: SessionId.make("sess-1"),
  projectId: ProjectId.make("proj-1"),
  worktreeId: WorktreeId.make("wt-1"),
  harness: "claude",
  providerSessionId: null,
  label: null,
  worktree: "add-rate-limit",
  branch: "mend/add-rate-limit",
  baseSha: Sha.make("0123456789abcdef"),
  baseRef: "main",
  contextSnapshotId: null,
  referenceMounts: [],
  extraMounts: [],
  sealantRunId: null,
  sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
  sealantSessionId: null,
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  workspaceImage: null,
  dotfiles: null,
  ownerUserId: "dana",
  hasTranscript: false,
  status: "idle",
  summary: null,
  lastSeenSequence: 0n,
  recordHistoryComplete: true,
  startedAt: NOW,
  settledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const detail = new SessionDetail({
  session,
  control: new SessionControlView({
    own: true,
    steer: true,
    stop: true,
    toggleSharedControl: true,
    terminalInput: true,
    turnsOnSendersLogin: false,
  }),
  checkpoints: [],
  change: null,
  repositories: [],
  landings: [],
  processes: [],
  currentAgent: null,
  liveServices: 0,
  preReleaseMemory: null,
  launchAdmission: "agentRan",
});

const codec = Schema.toCodecJson(SessionDetail);

const wire = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
  JSON.parse(JSON.stringify(Schema.encodeSync(codec)(detail))),
);

describe("SessionDetail's launchAdmission across versions", () => {
  it("encodes how this server admits a Retry of a launch it never answered", () => {
    expect(wire["launchAdmission"]).toBe("agentRan");
  });

  it("decodes agentRan off the wire", () => {
    expect(Schema.decodeUnknownSync(codec)(wire).launchAdmission).toBe("agentRan");
  });

  it("decodes an older server's detail, which omits the key, as null", () => {
    const older = Object.fromEntries(
      Object.entries(wire).filter(([key]) => key !== "launchAdmission"),
    );
    expect(Schema.decodeUnknownSync(codec)(older).launchAdmission).toBeNull();
  });

  it("decodes a later server's rule this client does not know as null, as it decodes an older one", () => {
    expect(
      Schema.decodeUnknownSync(codec)({ ...wire, launchAdmission: "agentRanOrSettled" })
        .launchAdmission,
    ).toBeNull();
    expect(
      Schema.decodeUnknownSync(codec)({ ...wire, launchAdmission: null }).launchAdmission,
    ).toBeNull();
  });

  it("still refuses a launchAdmission that is not a string", () => {
    expect(() => Schema.decodeUnknownSync(codec)({ ...wire, launchAdmission: 1 })).toThrow();
  });
});
