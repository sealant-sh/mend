import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { OtlpTracer } from "effect/observability";
import { describe, expect, it } from "vitest";

import { enrichSpan } from "./enrich.ts";
import { AREAS, SPAN_NAMES } from "./span-names.ts";

type Span = OtlpTracer.TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number];

/** `mend.<area>.<operation>`, lower snake case. */
const NAME = /^mend\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;
/** The words of a function's shape, not of an operation's. */
const CODE_WORDS = new Set([
  "as",
  "do",
  "engine",
  "for",
  "if",
  "impl",
  "in",
  "live",
  "maybe",
  "needed",
  "now",
  "of",
  "once",
  "repo",
  "require",
  "unresolved",
  "with",
]);
/** Lower-case words: letters, digits, and the hyphen, dot and apostrophe of `mend.toml`, `change's`. */
const DESCRIPTION = /^[a-z0-9][a-z0-9.'-]*(?: [a-z0-9][a-z0-9.'-]*)*$/;

/** What is wrong with `name` described as `description`, by the convention; none when it holds. */
const breaches = (name: string, description: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  const match = NAME.exec(name);
  if (match === null) return [`${name} is not mend.<area>.<operation>`];
  const [, area = "", operation = ""] = match;
  if (!AREAS.has(area)) found.push(`${name}: area ${area} is not one of AREAS`);
  for (const word of operation.split("_"))
    if (CODE_WORDS.has(word)) found.push(`${name}: "${word}" names code, not an operation`);
  if (!DESCRIPTION.test(description))
    found.push(`${name}: "${description}" is not lower-case words`);
  const count = description.split(" ").length;
  if (count < 2 || count > 5) found.push(`${name}: "${description}" is not two to five words`);
  if (description === operation.split("_").at(-1))
    found.push(`${name}: "${description}" only repeats the name`);
  return found;
};

const spanOf = (name: string, kind = 1, attributes: Record<string, string> = {}): Span => ({
  traceId: "0".repeat(31) + "1",
  spanId: "0".repeat(15) + "1",
  parentSpanId: undefined,
  name,
  kind,
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  attributes: Object.entries(attributes).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  })),
  droppedAttributesCount: 0,
  events: [],
  droppedEventsCount: 0,
  status: { code: 1 },
  links: [],
  droppedLinksCount: 0,
});

const read = (span: Span): Readonly<Record<string, string | undefined>> => ({
  name: span.name,
  ...Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue])),
});

const ROOT = join(import.meta.dirname, "../../..");

/** Every span name the repo's server code writes as a literal: `Effect.fn("…")`, `withSpan("…")`. */
const sourceSpanNames = (): ReadonlyMap<string, string> => {
  const SPAN_CALL =
    /(?:Effect\.fn|withSpan|makeSpan|useSpan)\(\s*"([^"]+)"|\.span\(\{\s*name:\s*"([^"]+)"/g;
  const names = new Map<string, string>();
  for (const top of ["apps", "packages"]) {
    for (const project of readdirSync(join(ROOT, top))) {
      const src = join(ROOT, top, project, "src");
      if (!existsSync(src)) continue;
      for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
        const path = join(entry.parentPath, entry.name);
        if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name))
          continue;
        for (const match of readFileSync(path, "utf8").matchAll(SPAN_CALL)) {
          const name = match[1] ?? match[2];
          if (name !== undefined) names.set(name, path.slice(ROOT.length + 1));
        }
      }
    }
  }
  return names;
};

describe("the span catalog", () => {
  it("names every span by the convention", () => {
    const found = Object.values(SPAN_NAMES).flatMap(([name, description]) =>
      breaches(name, description),
    );
    expect(found).toEqual([]);
  });

  it("gives no two names one description, and each name one description", () => {
    const byName = new Map<string, Set<string>>();
    const byDescription = new Map<string, Set<string>>();
    for (const [name, description] of Object.values(SPAN_NAMES)) {
      byName.set(name, (byName.get(name) ?? new Set()).add(description));
      byDescription.set(description, (byDescription.get(description) ?? new Set()).add(name));
    }
    expect([...byName].filter(([, descriptions]) => descriptions.size > 1)).toEqual([]);
    expect([...byDescription].filter(([, names]) => names.size > 1)).toEqual([]);
  });

  it("holds every span the source names, and no span it no longer does", () => {
    const source = sourceSpanNames();
    expect(source.size).toBeGreaterThan(250);
    const missing = [...source].filter(([name]) => SPAN_NAMES[name] === undefined);
    expect(missing, "add each to SPAN_NAMES in span-names.ts").toEqual([]);
    const stale = Object.keys(SPAN_NAMES).filter((name) => !source.has(name));
    expect(stale, "remove each from SPAN_NAMES in span-names.ts").toEqual([]);
  });

  it("is what reaches Sentry: each span's name, operation and words", () => {
    for (const [codeName, [name, description]] of Object.entries(SPAN_NAMES)) {
      if (name === "mend.job.process") continue;
      const span = read(enrichSpan(spanOf(codeName)));
      expect(span).toMatchObject({
        name,
        "sentry.op": name.split(".").slice(0, 2).join("."),
        "sentry.description": description,
      });
      expect(span["code.function.name"]).toBe(codeName === name ? undefined : codeName);
    }
  });
});

describe("the names a library or router makes", () => {
  it.each([
    [
      "a tRPC procedure, by its path in snake case",
      spanOf("mend.web.sessions.inboxRow", 2, {
        "rpc.system": "trpc",
        "rpc.method": "sessions.inboxRow",
      }),
      {
        name: "mend.web.sessions.inbox_row",
        "sentry.op": "rpc.server",
        "sentry.description": "sessions.inboxRow",
      },
    ],
    [
      "a call to the t3 gateway, by its method in snake case",
      spanOf("mend.gateway.rpc.orchestration.getSnapshot", 2, {
        "rpc.system.name": "effect_rpc",
        "rpc.method": "orchestration.getSnapshot",
      }),
      {
        name: "mend.gateway.orchestration.get_snapshot",
        "sentry.op": "rpc.server",
        "sentry.description": "orchestration.getSnapshot",
      },
    ],
    [
      "an MCP call, as the operation it asks for",
      spanOf("McpServer.tools/call", 2, {
        "rpc.system.name": "effect_rpc",
        "rpc.method": "tools/call",
      }),
      { name: "mend.mcp.call_tool", "sentry.op": "rpc.server", "sentry.description": "tools/call" },
    ],
    [
      "a database transaction",
      spanOf("sql.transaction", 1, { "db.system.name": "postgresql" }),
      {
        name: "mend.db.transaction",
        "sentry.op": "db.sql.transaction",
        "sentry.description": "database transaction",
      },
    ],
    [
      "a migration",
      spanOf("Migrator 0095_process_first_output"),
      { name: "mend.db.migrate", "sentry.op": "mend.db", "sentry.description": "migrate database" },
    ],
  ])("names %s", (_, span, expected) => {
    expect(read(enrichSpan(span))).toMatchObject(expected);
  });
});
