import { QueuedSessionId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { parseAttempt } from "./adoptions.ts";
import type { QueuedSessionDto } from "./api.ts";
import { queuedRows } from "./inbox.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 9, minute));

const queued = (
  id: string,
  state: QueuedSessionDto["state"],
  extra: {
    readonly prompt?: string;
    readonly failure?: QueuedSessionDto["failure"];
    readonly minute?: number;
  } = {},
): QueuedSessionDto => ({
  id: QueuedSessionId.make(id),
  state,
  projectName: "mobile-app",
  clone: null,
  failure: extra.failure ?? null,
  sessionId: null,
  session: { harness: "codex", label: null, name: null, base: null, autoLand: null },
  launch: extra.prompt === undefined ? {} : { prompt: extra.prompt },
  createdAt: at(0),
  updatedAt: at(extra.minute ?? 0),
});

const ids = {
  a: "5c0ffee0-1b2c-4d3e-8f4a-5b6c7d8e9f01",
  b: "5c0ffee0-1b2c-4d3e-8f4a-5b6c7d8e9f02",
  c: "5c0ffee0-1b2c-4d3e-8f4a-5b6c7d8e9f03",
  d: "5c0ffee0-1b2c-4d3e-8f4a-5b6c7d8e9f04",
};

describe("queuedRows", () => {
  it("waits under Running, fails under To review in red with why, and drops a started one", () => {
    const rows = queuedRows([
      queued(ids.a, "waiting", { prompt: "Lazy-load the order history\nThe profile shows it." }),
      queued(ids.b, "starting", { minute: 1 }),
      queued(ids.c, "failed", {
        minute: 2,
        failure: { step: "clone", message: "git couldn't reach the repository." },
      }),
      queued(ids.d, "started", { minute: 3 }),
    ]);
    expect(rows.map((row) => [row.id, row.group, row.status.word, row.status.failed])).toEqual([
      [ids.c, "review", "Failed", true],
      [ids.b, "running", "Starting", false],
      [ids.a, "running", "Waiting for the clone", false],
    ]);
    expect(rows[0]?.failure).toEqual({
      step: "clone",
      message: "git couldn't reach the repository.",
    });
  });

  it("titles a row with the task's first line, or New session with no task", () => {
    const [titled, untitled] = queuedRows([
      queued(ids.a, "waiting", {
        prompt: "  Lazy-load the order history\nThe profile.",
        minute: 1,
      }),
      queued(ids.b, "waiting"),
    ]);
    expect(titled?.title).toBe("Lazy-load the order history");
    expect(untitled?.title).toBe("New session");
  });
});

describe("parseAttempt", () => {
  it("reads what the app stored, and nothing else", () => {
    expect(parseAttempt(JSON.stringify({ id: "k", name: "mobile-app", startedAt: 1 }))).toEqual({
      id: "k",
      name: "mobile-app",
      startedAt: 1,
      source: null,
      visibility: null,
    });
    expect(parseAttempt(JSON.stringify({ id: "k" }))).toBeNull();
    expect(parseAttempt("not json")).toBeNull();
    expect(parseAttempt(null)).toBeNull();
  });
});
