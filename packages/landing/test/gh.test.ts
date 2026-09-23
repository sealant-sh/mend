import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createArgv,
  createdUrl,
  editArgv,
  ghWords,
  openForBranchArgv,
  parseFirstPullRequest,
  parsePullRequest,
  viewArgv,
  writeFileArgv,
} from "../src/gh.ts";

const repository = { owner: "acme", name: "api", slug: "acme/api" };
const PREFIX = ["env", "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1", "gh"];

const wire = {
  number: 412,
  url: "https://github.com/acme/api/pull/412",
  state: "OPEN",
  title: "Fix login",
  body: "Closes #12",
};

describe("gh argv", () => {
  it("names the repository and both branches explicitly, values after '='", () => {
    expect(
      createArgv({
        repository,
        head: "mend/fix-login",
        base: "main",
        title: "--help me",
        bodyFile: "/tmp/body.md",
      }),
    ).toEqual([
      ...PREFIX,
      "pr",
      "create",
      "--repo=acme/api",
      "--head=mend/fix-login",
      "--base=main",
      "--title=--help me",
      "--body-file=/tmp/body.md",
    ]);
  });

  it("sends a title on edit only when given", () => {
    expect(editArgv({ repository, number: 412, title: null, bodyFile: "/tmp/b.md" })).toEqual([
      ...PREFIX,
      "pr",
      "edit",
      "412",
      "--repo=acme/api",
      "--body-file=/tmp/b.md",
    ]);
    expect(editArgv({ repository, number: 412, title: "New", bodyFile: "/tmp/b.md" }).at(-1)).toBe(
      "--title=New",
    );
  });

  it("asks for the fields Mend reads back", () => {
    expect(viewArgv(repository, 412)).toEqual([
      ...PREFIX,
      "pr",
      "view",
      "412",
      "--repo=acme/api",
      "--json=number,url,state,title,body",
    ]);
    expect(openForBranchArgv(repository, "mend/x")).toContain("--head=mend/x");
    expect(openForBranchArgv(repository, "mend/x")).toContain("--state=open");
  });
});

describe("writeFileArgv", () => {
  it("writes the exact bytes through sh, however long and whatever they hold", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-gh-body-"));
    try {
      const target = path.join(dir, "body.md");
      const content = `# Title\n\n$HOME \`whoami\` "quotes" 'single' ✓\n${"x".repeat(200_000)}\n`;
      const [command = "", ...args] = writeFileArgv(target, content);
      execFileSync(command, args);
      expect(fs.readFileSync(target, "utf8")).toBe(content);
      expect(fs.statSync(target).mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parsers", () => {
  it("reads a pull request and its state in Mend's words", () => {
    expect(parsePullRequest(JSON.stringify(wire))).toEqual({ ...wire, state: "open" });
    expect(parsePullRequest(JSON.stringify({ ...wire, state: "MERGED" }))?.state).toBe("merged");
    expect(parsePullRequest(JSON.stringify({ ...wire, state: "CLOSED" }))?.state).toBe("closed");
  });

  it("is null for output that is not the JSON asked for", () => {
    expect(parsePullRequest("no pull requests found")).toBeNull();
    expect(parsePullRequest(JSON.stringify({ ...wire, state: "DRAFT" }))).toBeNull();
  });

  it("takes the first of a list, null for an empty one", () => {
    expect(parseFirstPullRequest(JSON.stringify([wire]))?.number).toBe(412);
    expect(parseFirstPullRequest("[]")).toBeNull();
  });

  it("finds the URL gh pr create printed", () => {
    expect(
      createdUrl(
        "Creating pull request for mend/x into main in acme/api\n\nhttps://github.com/acme/api/pull/413\n",
      ),
    ).toBe("https://github.com/acme/api/pull/413");
    expect(createdUrl("nothing here")).toBeNull();
  });

  it("says a failure in gh's words", () => {
    expect(
      ghWords({
        exitCode: 1,
        stdout: "",
        stderr:
          "pull request create failed: GraphQL: No commits between main and mend/x (createPullRequest)\n",
      }),
    ).toBe(
      "pull request create failed: GraphQL: No commits between main and mend/x (createPullRequest)",
    );
    expect(ghWords({ exitCode: 4, stdout: "", stderr: "" })).toBe("gh exited 4");
  });
});
