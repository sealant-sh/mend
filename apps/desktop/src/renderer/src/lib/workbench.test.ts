import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionProcessDto } from "./api";
import { processFixture } from "./fixtures";

const shell = (id: string, label: string): SessionProcessDto =>
  processFixture({
    id,
    sessionId: "session-1",
    serviceId: null,
    attemptOrdinal: null,
    launchCorrelationId: null,
    sealantWorkspaceId: "workspace-1",
    sealantSessionId: `pty-${id}`,
    sealantRunId: `run-${id}`,
    kind: "shell",
    harness: null,
    providerSessionId: null,
    label,
    argv: ["bash"],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    exitedAt: null,
    updatedAt: "2026-08-20T00:00:00.000Z",
  });

const memoryStorage = (): Storage => {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

describe("desktop workbench layout", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: memoryStorage(),
    });
    vi.resetModules();
  });

  it("drops a shell tab without a process id and restores live server-owned shells", async () => {
    localStorage.setItem(
      "mend-workbench",
      JSON.stringify({
        focusedProjectId: "project-1",
        byProject: {
          "project-1": {
            focused: 0,
            tabs: [
              { kind: "shell", sessionId: "session-0", processId: null },
              { kind: "session", sessionId: "session-1" },
            ],
          },
        },
      }),
    );

    const { workbench } = await import("./workbench");
    workbench.reconcileProject("project-1", new Set(["session-1"]), [shell("shell-1", "tests")]);

    const saved: unknown = JSON.parse(localStorage.getItem("mend-workbench") ?? "null");
    expect(saved).toMatchObject({
      byProject: {
        "project-1": {
          tabs: [
            { kind: "session", sessionId: "session-1" },
            { kind: "shell", sessionId: "session-1", processId: "shell-1" },
          ],
        },
      },
    });
  });

  it("keeps an explicitly detached live shell out of the current layout", async () => {
    const { workbench } = await import("./workbench");
    const live = shell("shell-1", "tests");
    workbench.reconcileProject("project-1", new Set(["session-1"]), [live]);
    workbench.detachTab("project-1", 0);
    workbench.reconcileProject("project-1", new Set(["session-1"]), [live]);

    const saved: unknown = JSON.parse(localStorage.getItem("mend-workbench") ?? "null");
    expect(saved).toMatchObject({ byProject: { "project-1": { tabs: [] } } });
  });
});
