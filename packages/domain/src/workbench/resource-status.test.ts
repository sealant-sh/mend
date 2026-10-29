import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  type ResourceInstanceObservation,
  resourceStatusLine,
  type ResourceStatusView,
} from "./resource-status.ts";
import { ProjectResourceDefinition, WorktreeResourceDefinition } from "./resource.ts";

const base = {
  preset: null,
  command: null,
  env: {},
  volumes: [{ name: "data", mountPath: "/data" }],
  ready: { kind: "tcp" },
  exports: {},
};

const project = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(ProjectResourceDefinition)({ ...base, scope: "project", ...fields });
const worktree = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(WorktreeResourceDefinition)({ ...base, scope: "worktree", ...fields });

const postgresOn = (image: string) =>
  project({
    name: "db",
    preset: "postgres",
    image,
    ports: [{ name: "postgres", port: 5432, protocol: "tcp" }],
    ready: { kind: "preset" },
  });
const db = postgresOn("postgres:17");
const queue = project({
  name: "queue",
  image: "rabbitmq:4-management",
  ports: [{ name: "amqp", port: 5672, protocol: "tcp" }],
  env: { RABBITMQ_DEFAULT_USER: "app", RABBITMQ_DEFAULT_PASS: "hunter2-literal" },
  exports: { URL: "amqp://app:{env.RABBITMQ_DEFAULT_PASS}@{host}:{port.amqp}/" },
});
const cache = project({
  name: "cache",
  preset: "redis",
  image: "redis:8",
  ports: [{ name: "redis", port: 6379, protocol: "tcp" }],
  ready: { kind: "preset" },
});
const mail = worktree({
  name: "mail",
  image: "axllent/mailpit:v1.21",
  ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
  env: { MP_UI_AUTH: { secret: "MAILPIT_UI_AUTH" } },
});
const dns = worktree({
  name: "dns",
  image: "coredns/coredns:1.12",
  ports: [{ name: "dns", port: 53, protocol: "udp" }],
  ready: { kind: "none" },
});

const now = new Date("2026-10-30T14:30:03Z");
const at = { now, timeZone: "UTC" };
const observedAt = new Date("2026-10-30T14:30:00Z");

const running = (check: string): ResourceInstanceObservation => ({
  kind: "running",
  probe: { kind: "answered", check },
  secret: "applied",
});
const stopped = (
  reason: Extract<ResourceInstanceObservation, { kind: "stopped" }>["reason"],
): ResourceInstanceObservation => ({ kind: "stopped", reason, secret: "applied" });

const ownCopy: ResourceStatusView = {
  kind: "observed",
  definition: db,
  use: {
    kind: "own",
    start: { kind: "copied", at: new Date("2026-10-30T14:02:00Z") },
    instance: running("SELECT 1"),
  },
  observedAt,
};

const sharedDb = (instance: ResourceInstanceObservation): ResourceStatusView => ({
  kind: "observed",
  definition: db,
  use: { kind: "shared", worktrees: 2, instance },
  observedAt,
});
const sharedQueue = (instance: ResourceInstanceObservation): ResourceStatusView => ({
  kind: "observed",
  definition: queue,
  use: { kind: "shared", worktrees: 3, instance },
  observedAt,
});
const ofMail = (instance: ResourceInstanceObservation): ResourceStatusView => ({
  kind: "observed",
  definition: mail,
  use: { kind: "worktree", instance },
  observedAt,
});

const WARNING = "any worktree on shared can change or drop its tables";

const lines: ReadonlyArray<readonly [string, ResourceStatusView, string]> = [
  [
    "a worktree's own database copied from shared, and what answered its check",
    ownCopy,
    "@db · postgres 17 · project · its own database · copied from shared 14:02 · running · answered SELECT 1 · observed 3 s ago",
  ],
  [
    "a shared instance and how many worktrees reach it",
    sharedQueue(running("TCP 5672")),
    "@queue · rabbitmq 4 · project · shared · reached by 3 worktrees · running · answered TCP 5672 · observed 3 s ago",
  ],
  [
    "a worktree resource",
    ofMail(running("TCP 1025")),
    "@mail · mailpit · worktree · running · answered TCP 1025 · observed 3 s ago",
  ],
  [
    "a UDP-only resource with no check",
    {
      kind: "observed",
      definition: dns,
      use: {
        kind: "worktree",
        instance: { kind: "running", probe: { kind: "not-probed" }, secret: "applied" },
      },
      observedAt,
    },
    "@dns · coredns 1 · worktree · running · not probed · observed 3 s ago",
  ],
  [
    "a declared instance",
    sharedQueue({ kind: "declared" }),
    "@queue · rabbitmq 4 · project · shared · reached by 3 worktrees · declared · observed 3 s ago",
  ],
  [
    "a definition waiting for approval",
    ofMail({ kind: "waiting-for-approval" }),
    "@mail · mailpit · worktree · waiting for approval · observed 3 s ago",
  ],
  [
    "an instance starting",
    ofMail({ kind: "starting" }),
    "@mail · mailpit · worktree · starting · observed 3 s ago",
  ],
  [
    "an instance stopping",
    ofMail({ kind: "stopping" }),
    "@mail · mailpit · worktree · stopping · observed 3 s ago",
  ],
  [
    "an instance stopped after its idle time",
    ofMail(stopped({ kind: "idle" })),
    "@mail · mailpit · worktree · stopped · idle · observed 3 s ago",
  ],
  [
    "an instance a person stopped",
    sharedDb(stopped({ kind: "person", by: "Maria" })),
    `@db · postgres 17 · project · shared database · reached by 2 worktrees · stopped by Maria · ${WARNING} · observed 3 s ago`,
  ],
  [
    "an instance stopped at its memory limit",
    sharedDb(stopped({ kind: "memory-limit" })),
    `@db · postgres 17 · project · shared database · reached by 2 worktrees · stopped · memory limit reached · ${WARNING} · observed 3 s ago`,
  ],
  [
    "an instance stopped at its disk limit",
    ofMail(stopped({ kind: "disk-limit" })),
    "@mail · mailpit · worktree · stopped · disk limit reached · observed 3 s ago",
  ],
  [
    "an instance whose data volume is missing",
    sharedDb({ kind: "blocked", reason: "data-volume-missing" }),
    `@db · postgres 17 · project · shared database · reached by 2 worktrees · blocked · data volume missing · ${WARNING} · observed 3 s ago`,
  ],
  [
    "an instance on a runtime without resources",
    ofMail({ kind: "blocked", reason: "needs-newer-sealant" }),
    "@mail · mailpit · worktree · blocked · resources need a newer Sealant on this runtime · observed 3 s ago",
  ],
  [
    "a secret changed and not applied",
    sharedQueue({
      kind: "running",
      probe: { kind: "answered", check: "TCP 5672" },
      secret: "changed-not-applied",
    }),
    "@queue · rabbitmq 4 · project · shared · reached by 3 worktrees · running · answered TCP 5672 · secret changed · not applied · consumers keep the applied one · observed 3 s ago",
  ],
  [
    "a worktree that runs its own infra",
    { kind: "observed", definition: cache, use: { kind: "off" }, observedAt },
    "@cache · redis 8 · project · off · observed 3 s ago",
  ],
  [
    "an own instance from a snapshot, labelled crash-consistent",
    {
      kind: "observed",
      definition: queue,
      use: {
        kind: "own",
        start: { kind: "snapshot", at: new Date("2026-10-30T09:15:00Z") },
        instance: running("TCP 5672"),
      },
      observedAt,
    },
    "@queue · rabbitmq 4 · project · its own instance · snapshot of shared 09:15 · crash-consistent · running · answered TCP 5672 · observed 3 s ago",
  ],
  [
    "a launch without an instance a person stopped",
    { kind: "launched-without", definition: db, because: { kind: "stopped-by", by: "Maria" } },
    "@db · stopped by Maria · this session starts without it",
  ],
  [
    "a launch on a runtime without resources",
    {
      kind: "launched-without",
      definition: db,
      because: { kind: "blocked", reason: "needs-newer-sealant" },
    },
    "@db · resources need a newer Sealant on this runtime · this session can run its own [service.db]",
  ],
  [
    "a launch without an instance whose data volume is missing",
    {
      kind: "launched-without",
      definition: db,
      because: { kind: "blocked", reason: "data-volume-missing" },
    },
    "@db · blocked · data volume missing · this session starts without it",
  ],
  [
    "a switch to the shared database that restarted a Service",
    {
      kind: "switched",
      definition: db,
      use: { kind: "shared", worktrees: 2, instance: running("SELECT 1") },
      restarted: ["web"],
      waitingFor: [],
    },
    `@db · shared database · running · answered SELECT 1 · restarted web · ${WARNING}`,
  ],
  [
    "a switch waiting for a terminal",
    {
      kind: "switched",
      definition: queue,
      use: { kind: "own", start: { kind: "empty" }, instance: { kind: "starting" } },
      restarted: [],
      waitingFor: ["mend claude, pid 4211"],
    },
    "@queue · its own instance · empty · starting · waiting for mend claude, pid 4211 to restart",
  ],
];

describe("the status line", () => {
  it.each(lines)("says %s", (_, view, line) => {
    expect(resourceStatusLine(view, at)).toBe(line);
  });

  it("never prints a credential or a verdict", () => {
    for (const [, view] of lines) {
      const line = resourceStatusLine(view, at);
      expect(line).not.toContain("hunter2-literal");
      expect(line).not.toContain("MAILPIT_UI_AUTH");
      expect(line).not.toMatch(/healthy|safe|ready to/i);
    }
  });

  it.each([
    ["postgres:17", "postgres 17"],
    ["pgvector/pgvector:pg17", "postgres pgvector 17"],
    ["pgvector/pgvector:0.8.0-pg17", "postgres pgvector 17"],
    ["postgis/postgis:17-3.5", "postgres postgis 17"],
  ])("names a preset on %s as %s", (image, engine) => {
    const view: ResourceStatusView = {
      kind: "observed",
      definition: postgresOn(image),
      use: { kind: "off" },
      observedAt,
    };
    expect(resourceStatusLine(view, at)).toBe(`@db · ${engine} · project · off · observed 3 s ago`);
  });

  it("cannot be built for a use its definition's scope does not have", () => {
    const views: ReadonlyArray<ResourceStatusView> = [
      // @ts-expect-error A worktree resource has its own instance and no shared use.
      {
        kind: "observed",
        definition: mail,
        use: { kind: "shared", worktrees: 2, instance: running("TCP 1025") },
        observedAt,
      },
      // @ts-expect-error A project resource is reached through a worktree's selection.
      {
        kind: "observed",
        definition: queue,
        use: { kind: "worktree", instance: running("TCP 5672") },
        observedAt,
      },
      // @ts-expect-error A worktree resource has no selection to switch.
      { kind: "switched", definition: mail, use: { kind: "off" }, restarted: [], waitingFor: [] },
    ];
    expect(views).toHaveLength(3);
  });
});

describe("clock times in the status line", () => {
  const copiedAt = (time: string): ResourceStatusView => ({
    ...ownCopy,
    use: {
      kind: "own",
      start: { kind: "copied", at: new Date(time) },
      instance: running("SELECT 1"),
    },
  });

  it("reads them in the reader's time zone", () => {
    expect(resourceStatusLine(ownCopy, { now, timeZone: "Europe/Athens" })).toContain(
      "copied from shared 16:02",
    );
  });

  it("dates a time that is not today", () => {
    expect(resourceStatusLine(copiedAt("2026-10-27T14:02:00Z"), at)).toContain(
      "copied from shared 27 Oct 14:02",
    );
  });

  it("dates a time by the reader's day, not the server's", () => {
    const view = copiedAt("2026-10-29T22:30:00Z");
    expect(resourceStatusLine(view, { now, timeZone: "Europe/Athens" })).toContain(
      "copied from shared 00:30 ·",
    );
    expect(resourceStatusLine(view, at)).toContain("copied from shared 29 Oct 22:30");
  });

  it("gives the year of a time in another year", () => {
    expect(resourceStatusLine(copiedAt("2025-12-31T23:00:00Z"), at)).toContain(
      "copied from shared 31 Dec 2025 23:00",
    );
  });

  it("needs the reader's time zone", () => {
    // @ts-expect-error The server's zone is never a reader's default.
    expect(resourceStatusLine(ownCopy, { now })).toContain("@db");
  });
});
