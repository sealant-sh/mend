import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  type ResourceInstanceObservation,
  resourceStatusLine,
  type ResourceStatusView,
} from "./resource-status.ts";
import { ResourceDefinition } from "./resource.ts";

const base = {
  preset: null,
  command: null,
  env: {},
  volumes: [{ name: "data", mountPath: "/data" }],
  ready: { kind: "tcp" },
  exports: {},
};

const project = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(ResourceDefinition)({ ...base, scope: "project", ...fields });
const worktree = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(ResourceDefinition)({ ...base, scope: "worktree", ...fields });

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
const running: ResourceInstanceObservation = { kind: "running" };

const observed = (
  definition: Extract<ResourceStatusView, { kind: "observed" }>["definition"],
  use: Extract<ResourceStatusView, { kind: "observed" }>["use"],
  instance: Extract<ResourceStatusView, { kind: "observed" }>["instance"] = running,
): ResourceStatusView => ({
  kind: "observed",
  definition,
  level:
    use.kind === "own" || use.kind === "worktree" || definition.name === "dns"
      ? "worktree"
      : "project",
  use,
  instance,
  observedAt,
});

const copiedAt = (iso: string) =>
  observed(db, { kind: "own", origin: { kind: "copied", at: new Date(iso) } });

const lines: ReadonlyArray<readonly [string, ResourceStatusView, string]> = [
  [
    "a worktree's own database copied from shared",
    copiedAt("2026-10-30T14:02:00Z"),
    "@db · running · worktree · own database · copied from shared 14:02 · observed 3 s ago",
  ],
  [
    "a worktree's own database begun empty",
    observed(db, { kind: "own", origin: { kind: "empty", at: new Date("2026-10-30T14:02:00Z") } }),
    "@db · running · worktree · own database · started empty 14:02 · observed 3 s ago",
  ],
  [
    "own before the worktree made its database",
    observed(db, { kind: "own", origin: null }, { kind: "starting" }),
    "@db · starting · worktree · own database · not made yet · observed 3 s ago",
  ],
  [
    "a shared database, and what shared means",
    observed(db, { kind: "shared" }),
    `@db · running · project · shared database · observed 3 s ago`,
  ],
  [
    "a shared image that is not a database",
    observed(queue, { kind: "shared" }),
    "@queue · running · project · observed 3 s ago",
  ],
  ["a worktree that has it off", observed(cache, { kind: "off" }), "@cache · off"],
  [
    "a worktree resource",
    observed(mail, { kind: "worktree" }),
    "@mail · running · worktree · observed 3 s ago",
  ],
  [
    "a stop a person made",
    observed(db, { kind: "shared" }, { kind: "stopped", reason: { kind: "person", by: "Maria" } }),
    `@db · stopped by Maria · project · shared database · observed 3 s ago`,
  ],
  [
    "an idle stop",
    observed(mail, { kind: "worktree" }, { kind: "stopped", reason: { kind: "idle" } }),
    "@mail · stopped · idle · worktree · observed 3 s ago",
  ],
  [
    "a start that failed, and why",
    observed(mail, { kind: "worktree" }, { kind: "failed", message: "image pull refused" }),
    "@mail · failed · image pull refused · worktree · observed 3 s ago",
  ],
  [
    "a project read, with who added it",
    observed(db, { kind: "project", addedBy: "Maria" }),
    "@db · postgres:17 · started by Maria · running · project · observed 3 s ago",
  ],
  [
    "a worktree resource read for the project",
    observed(dns, { kind: "project", addedBy: "Tom" }, { kind: "per-worktree", running: 2 }),
    "@dns · coredns:1 · started by Tom · one per worktree · 2 running · worktree · observed 3 s ago",
  ],
  [
    "a launch that went on while a person's stop holds",
    {
      kind: "launched-without",
      definition: db,
      instance: { kind: "stopped", reason: { kind: "person", by: "Maria" } },
    },
    "@db · stopped by Maria · this session starts without it",
  ],
  [
    "a launch that went on while the instance still started",
    { kind: "launched-without", definition: db, instance: { kind: "starting" } },
    "@db · starting · this session starts without it",
  ],
  [
    "a name the project sets itself",
    { kind: "env-left", definition: db, names: ["DATABASE_URL"] },
    "@db · DATABASE_URL left as the project sets it",
  ],
  [
    "names the project sets itself",
    { kind: "env-left", definition: db, names: ["DATABASE_URL", "PGHOST"] },
    "@db · DATABASE_URL, PGHOST left as the project sets them",
  ],
  [
    "an own database that could not be made",
    { kind: "own-not-made", definition: db, message: "pg_restore exited 1" },
    "@db · own database not made · pg_restore exited 1 · run mend resource start to try again",
  ],
  [
    "a mend.toml table settings hold otherwise",
    { kind: "definition-differs", definition: db, level: "project" },
    "@db · project · definition differs from this worktree",
  ],
  [
    "a switch to own, and the Services it restarted",
    {
      kind: "switched",
      definition: db,
      use: { kind: "own", origin: null },
      restarted: ["web", "api"],
    },
    "@db · own database · not made yet · restarted web, api · agents and shells keep their env until they restart",
  ],
  [
    "a switch with no Service running",
    { kind: "switched", definition: cache, use: { kind: "shared" }, restarted: [] },
    "@cache · no Service was running · agents and shells keep their env until they restart",
  ],
  [
    "a switch to off",
    { kind: "switched", definition: cache, use: { kind: "off" }, restarted: [] },
    "@cache · off · agents and shells keep their env until they restart",
  ],
  [
    "an own database reset, copied again, with the dump of what it held",
    {
      kind: "reset",
      definition: db,
      target: "own",
      origin: "copied",
      savedAt: new Date("2026-10-30T14:02:00Z"),
    },
    "@db · own database reset · copied from shared · previous data saved as a dump 14:02",
  ],
  [
    "a shared database reset that held nothing",
    { kind: "reset", definition: db, target: "shared", origin: "empty", savedAt: null },
    "@db · shared database reset · empty · it held no data to save",
  ],
  [
    "a Sealant that runs no resources",
    observed(db, { kind: "shared" }, { kind: "unsupported", runtime: "kubernetes" }),
    `@db · resources run on Docker; this Sealant runs kubernetes · project · shared database · observed 3 s ago`,
  ],
];

describe("the one status line", () => {
  it.each(lines)("says %s", (_, view, line) => {
    expect(resourceStatusLine(view, at)).toBe(line);
  });

  it("names a preset with its image when the image is not the preset's own", () => {
    const view = observed(postgresOn("pgvector/pgvector:pg17"), { kind: "project", addedBy: "A" });
    expect(resourceStatusLine(view, at)).toContain("@db · postgres pgvector:17");
  });

  it("never prints an env value, a literal secret among them", () => {
    expect(
      resourceStatusLine(observed(queue, { kind: "project", addedBy: "A" }), at),
    ).not.toContain("hunter2");
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
    expect(resourceStatusLine(copiedAt("2026-10-30T14:02:00Z"), { now })).toContain("@db");
  });
});

describe("file and differing server views", () => {
  it("describes a definition without settings or a fixed level", () => {
    expect(resourceStatusLine({ kind: "defined", definition: mail }, at)).toBe(
      "@mail · mailpit · in .mend/mend.toml · not started",
    );
  });
  it("names the own database's actual server and this file's requested version", () => {
    expect(
      resourceStatusLine(
        {
          kind: "own-on-differing-server",
          definition: postgresOn("postgres:16"),
          requested: postgresOn("postgres:17"),
        },
        at,
      ),
    ).toBe(
      "@db · own database on the project server (postgres:16) · this worktree's file asks postgres:17",
    );
  });
});
