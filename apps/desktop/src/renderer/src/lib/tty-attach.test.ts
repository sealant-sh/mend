import { describe, expect, it } from "vitest";

import { ApiError, type SessionDetailDto, type SessionProcessDto } from "#/lib/api";
import { OWNER_CONTROL, processFixture, sessionFixture } from "#/lib/fixtures";
import {
  afterUnopenedClose,
  livenessOfError,
  processPtyLiveness,
  sessionPtyLiveness,
} from "#/lib/tty-attach";

const process = (overrides: Partial<SessionProcessDto> = {}): SessionProcessDto =>
  processFixture({
    id: "p1",
    sessionId: "s1",
    serviceId: null,
    attemptOrdinal: null,
    launchCorrelationId: null,
    sealantWorkspaceId: "w1",
    sealantSessionId: "sess_1",
    sealantRunId: "run_1",
    kind: "agent-pty",
    harness: "codex",
    providerSessionId: null,
    label: "codex",
    argv: ["codex"],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: "2026-09-22T13:11:19.907Z",
    exitedAt: null,
    updatedAt: "2026-09-22T13:11:19.907Z",
    ...overrides,
  });

const detail = (
  agent: SessionProcessDto | null,
  status: "running" | "completed",
): SessionDetailDto => ({
  session: sessionFixture({
    id: "s1",
    projectId: "proj",
    harness: "codex",
    worktree: "w",
    branch: "mend/w",
    baseSha: "abc",
    sealantRunId: "run_1",
    sealantSessionId: "sess_1",
    status,
    createdAt: "2026-09-22T13:11:01.826Z",
  }),
  control: OWNER_CONTROL,
  checkpoints: [],
  change: null,
  processes: agent === null ? [] : [agent],
  currentAgent: agent,
});

describe("afterUnopenedClose", () => {
  it("stops for an ended PTY and for a refusal, and reconnects otherwise", () => {
    expect(afterUnopenedClose("ended")).toBe("ended");
    expect(afterUnopenedClose("refused")).toBe("refused");
    expect(afterUnopenedClose("live")).toBe("reconnect");
    expect(afterUnopenedClose("unknown")).toBe("reconnect");
  });
});

describe("sessionPtyLiveness", () => {
  it("reads the agent process, not the session fold", () => {
    expect(sessionPtyLiveness(detail(process(), "running"))).toBe("live");
    const exited = process({ status: "exited", exitedAt: "2026-09-22T14:11:10.339Z" });
    expect(sessionPtyLiveness(detail(exited, "completed"))).toBe("ended");
  });

  it("falls back to the session status before the first process row", () => {
    expect(sessionPtyLiveness(detail(null, "running"))).toBe("live");
    expect(sessionPtyLiveness(detail(null, "completed"))).toBe("ended");
  });
});

describe("processPtyLiveness", () => {
  it("answers for the named process only", () => {
    const shell = process({ id: "shell-1", kind: "shell", harness: null });
    const ended = process({ id: "shell-2", kind: "shell", status: "exited", exitedAt: "x" });
    expect(processPtyLiveness([shell, ended], "shell-1")).toBe("live");
    expect(processPtyLiveness([shell, ended], "shell-2")).toBe("ended");
    expect(processPtyLiveness([shell], "gone")).toBe("refused");
  });
});

describe("livenessOfError", () => {
  it("treats the server saying no as a refusal and silence as unknown", () => {
    expect(livenessOfError(new ApiError("nope", 401))).toBe("refused");
    expect(livenessOfError(new ApiError("hidden", 404))).toBe("refused");
    expect(livenessOfError(new ApiError("no answer", 0))).toBe("unknown");
    expect(livenessOfError(new ApiError("bad gateway", 502))).toBe("unknown");
    expect(livenessOfError(new Error("boom"))).toBe("unknown");
  });
});
