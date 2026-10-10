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

const tabsOf = (): unknown => JSON.parse(localStorage.getItem("mend-workbench") ?? "null");

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

describe("tabs opened before the server lists them", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: memoryStorage(),
    });
    vi.resetModules();
  });

  it("keeps a launched session's tab focused until the project detail lists it", async () => {
    const { workbench } = await import("./workbench");
    workbench.reconcileProject("project-1", new Set(["session-0"]), []);
    workbench.openSession("project-1", "session-0");
    workbench.openLaunchedSession("project-1", "session-1");

    // The launcher's own invalidation re-reads the detail; the first answer predates the create.
    workbench.reconcileProject("project-1", new Set(["session-0"]), []);
    expect(tabsOf()).toMatchObject({
      byProject: {
        "project-1": {
          focused: 1,
          tabs: [
            { kind: "session", sessionId: "session-0" },
            { kind: "session", sessionId: "session-1" },
          ],
        },
      },
    });

    workbench.reconcileProject("project-1", new Set(["session-0", "session-1"]), []);
    // Listed once, the server decides: a later read without it closes the tab.
    workbench.reconcileProject("project-1", new Set(["session-0"]), []);
    expect(tabsOf()).toMatchObject({
      byProject: { "project-1": { tabs: [{ kind: "session", sessionId: "session-0" }] } },
    });
  });

  it("keeps a just-started shell's tab until the process index lists it", async () => {
    const { workbench } = await import("./workbench");
    workbench.reconcileProject("project-1", new Set(["session-1"]), []);
    workbench.openSession("project-1", "session-1");
    workbench.openStartedShell("project-1", "session-1", "shell-1");

    workbench.reconcileProject("project-1", new Set(["session-1"]), []);
    expect(tabsOf()).toMatchObject({
      byProject: {
        "project-1": {
          focused: 1,
          tabs: [
            { kind: "session", sessionId: "session-1" },
            { kind: "shell", sessionId: "session-1", processId: "shell-1" },
          ],
        },
      },
    });

    workbench.reconcileProject("project-1", new Set(["session-1"]), [shell("shell-1", "shell 1")]);
    workbench.reconcileProject("project-1", new Set(["session-1"]), [
      { ...shell("shell-1", "shell 1"), status: "exited", exitedAt: "2026-08-20T00:01:00.000Z" },
    ]);
    expect(tabsOf()).toMatchObject({
      byProject: { "project-1": { tabs: [{ kind: "session", sessionId: "session-1" }] } },
    });
  });

  it("closes a tab no read has listed within a minute", async () => {
    vi.useFakeTimers();
    try {
      const { workbench } = await import("./workbench");
      workbench.reconcileProject("project-1", new Set(), []);
      workbench.openLaunchedSession("project-1", "session-1");
      vi.advanceTimersByTime(60_001);
      workbench.reconcileProject("project-1", new Set(), []);
      expect(tabsOf()).toMatchObject({ byProject: { "project-1": { tabs: [] } } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still closes a plain tab whose session the server no longer lists", async () => {
    const { workbench } = await import("./workbench");
    workbench.reconcileProject("project-1", new Set(), []);
    workbench.openSession("project-1", "session-1");
    workbench.reconcileProject("project-1", new Set(), []);
    expect(tabsOf()).toMatchObject({ byProject: { "project-1": { tabs: [] } } });
  });
});
