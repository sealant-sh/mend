import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { flagRefusal } from "./flag-gate.ts";
import { findCommand } from "./help.ts";
import { mainTestFixtures } from "./main-test-fixtures.ts";

const { startCli, spawning } = mainTestFixtures();
const scratch = mkdtempSync(join(tmpdir(), "mend-skill-install-test-"));
afterAll(() => {
  readdirSync(scratch);
  rmSync(scratch, { recursive: true });
});
const bundled = readFileSync(new URL("./agent-skill.md", import.meta.url), "utf8");
const homeFor = (name: string, paths: ReadonlyArray<string>) => {
  const home = join(scratch, name);
  mkdirSync(home);
  for (const path of paths) mkdirSync(join(home, path), { recursive: true });
  return home;
};

describe("agent skill installation without a server or terminal", spawning, () => {
  it("installs identical skill text into every detected home, then returns unchanged on retry", async () => {
    const home = homeFor("all", [".claude", ".codex", ".pi/agent"]);
    for (const state of ["installed", "unchanged"]) {
      const cli = startCli("http://127.0.0.1:1", ["agent", "install", "--json"], { HOME: home });
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: {
          installs: [
            { agent: "claude", path: join(home, ".claude/skills/mend/SKILL.md"), state },
            { agent: "codex", path: join(home, ".codex/skills/mend/SKILL.md"), state },
            { agent: "pi", path: join(home, ".pi/agent/skills/mend/SKILL.md"), state },
          ],
        },
      });
    }
    for (const runtime of [".claude", ".codex", ".pi/agent"])
      expect(readFileSync(join(home, runtime, "skills/mend/SKILL.md"), "utf8")).toBe(bundled);
  });

  it("updates a managed skill and leaves absent agent homes absent", async () => {
    const home = homeFor("one", [".codex/skills/mend"]);
    const target = join(home, ".codex/skills/mend/SKILL.md");
    writeFileSync(target, "<!-- mend-managed-skill:v1 -->\nOld managed skill");
    const cli = startCli("http://127.0.0.1:1", ["agent", "install", "--json"], { HOME: home });
    expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
    expect(JSON.parse(cli.stdout())).toMatchObject({
      data: { installs: [{ agent: "codex", state: "updated" }] },
    });
    expect(readFileSync(target, "utf8")).toBe(bundled);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".pi"))).toBe(false);
  });

  it("preserves a custom skill before writing to any home", async () => {
    const home = homeFor("custom", [".claude", ".codex/skills/mend"]);
    const target = join(home, ".codex/skills/mend/SKILL.md");
    writeFileSync(target, "My personal Mend workflow");
    const cli = startCli("http://127.0.0.1:1", ["agent", "install", "--json"], { HOME: home });
    expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 2 });
    expect(JSON.parse(cli.stdout())).toMatchObject({
      v: 1,
      error: { code: "needs_input", fix: expect.stringContaining(target) },
    });
    expect(readFileSync(target, "utf8")).toBe("My personal Mend workflow");
    expect(existsSync(join(home, ".claude/skills/mend/SKILL.md"))).toBe(false);
  });

  it("names the fix when no supported home exists", async () => {
    const home = homeFor("none", []);
    const cli = startCli("http://127.0.0.1:1", ["agent", "install", "--json"], { HOME: home });
    expect(await cli.exited).toEqual({ kind: "exit", code: 2 });
    expect(JSON.parse(cli.stdout())).toMatchObject({
      v: 1,
      error: {
        code: "needs_input",
        fix: expect.stringContaining("Start Claude Code, Codex or pi once"),
      },
    });
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("the shipped skill command examples", () => {
  it("covers the twelve approved stories and only invokes installed commands and flags", () => {
    const stories = [...bundled.matchAll(/^## (\d+)\./gm)].map((match) => Number(match[1]));
    expect(stories).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const examples = [...bundled.matchAll(/```sh\n([\s\S]*?)```/g)]
      .flatMap((match) => (match[1] ?? "").split("\n"))
      .filter((line) => line.startsWith("mend "));
    expect(examples.length).toBeGreaterThan(25);
    for (const line of examples) {
      const words = (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) =>
        word.replace(/^(["'])(.*)\1$/, "$2"),
      );
      const redirect = words.indexOf("<");
      const argv = words.slice(1, redirect < 0 ? undefined : redirect);
      const page = findCommand(argv);
      expect(page, line).not.toBeNull();
      expect(page?.agentContract, line).toBe(true);
      expect(argv, line).toContain("--json");
      expect(flagRefusal(argv), line).toBeNull();
    }
  });
});
