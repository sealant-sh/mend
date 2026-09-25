import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { gitAuthorConfigArgv } from "./git-author.ts";

describe("gitAuthorConfigArgv", () => {
  it("writes the author as system config, below the user's own config", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-git-author-"));
    const system = path.join(home, "gitconfig-system");
    const env = { ...process.env, HOME: home, GIT_CONFIG_SYSTEM: system, GIT_CONFIG_NOSYSTEM: "" };
    const author = { name: `Anna "The" O'Brien $(touch pwned)`, email: "anna@example.com" };
    const [command = "", ...args] = gitAuthorConfigArgv(author);
    const written = spawnSync(command, args, { env, cwd: home, encoding: "utf8" });
    expect(written.status).toBe(0);
    expect(fs.existsSync(path.join(home, "pwned"))).toBe(false);
    const read = (key: string) =>
      spawnSync("git", ["config", key], { env, cwd: home, encoding: "utf8" }).stdout.trim();
    expect(read("user.name")).toBe(author.name);
    expect(read("user.email")).toBe("anna@example.com");

    // A dotfiles ~/.gitconfig decides over it.
    fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\temail = anna@home.example\n");
    expect(read("user.email")).toBe("anna@home.example");
    expect(read("user.name")).toBe(author.name);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
