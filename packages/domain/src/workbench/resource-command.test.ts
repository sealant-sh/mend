import { describe, expect, it } from "vitest";

import { WorktreeId } from "../ids.ts";
import { resourceAdditionOf, resourceAdditionDefinition } from "./resource-command.ts";
import { resourceDefinitionRefusals } from "./resource.ts";
import { worktreesByViewerActivity } from "./worktree.ts";

describe("resource add arguments", () => {
  it("parses a versioned preset and excludes selector values from the name", () => {
    expect(
      resourceAdditionOf([
        "--project-id",
        "p",
        "--preset",
        "postgres",
        "db",
        "--version",
        "17",
        "--worktree-id",
        "w",
      ]),
    ).toEqual({ ok: true, definition: { name: "db", preset: "postgres", version: "17" } });
  });
  it("parses image ports including UDP", () => {
    const result = resourceAdditionOf([
      "dns",
      "--image",
      "coredns/coredns:1.12",
      "--port",
      "dns=53/udp",
      "--port",
      "health=8080",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const spec = resourceAdditionDefinition(result.definition);
    expect(spec.ports).toEqual([
      { name: "dns", port: 53, protocol: "udp" },
      { name: "health", port: 8080, protocol: "tcp" },
    ]);
    expect(resourceDefinitionRefusals(spec)).toEqual([]);
  });
  it.each([
    ["db", "--scope", "project", "--preset", "postgres", "--version", "17"],
    ["db", "--preset", "postgres", "--version", "latest"],
    ["db", "--preset", "postgres", "--version", "17", "--image", "postgres:17"],
    ["db", "--image", "postgres:17", "--port", "db=65536"],
    ["db", "--image"],
  ])("refuses invalid arguments %#", (...args) => expect(resourceAdditionOf(args).ok).toBe(false));
});
const at = (n: number) => new Date(n);
it("orders the viewer's latest active worktrees first, ahead of others", () => {
  const a = WorktreeId.make("a"),
    b = WorktreeId.make("b"),
    c = WorktreeId.make("c");
  const worktrees = [
    { id: c, updatedAt: at(99) },
    { id: a, updatedAt: at(10) },
    { id: b, updatedAt: at(20) },
  ];
  expect(
    worktreesByViewerActivity(
      worktrees,
      [
        { worktreeId: a, ownerUserId: "me", updatedAt: at(30) },
        { worktreeId: b, ownerUserId: "me", updatedAt: at(40) },
        { worktreeId: c, ownerUserId: "other", updatedAt: at(100) },
      ],
      "me",
    ).map((row) => row.id),
  ).toEqual([b, a, c]);
});
