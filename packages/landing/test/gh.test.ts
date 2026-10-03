import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  anyForBranchArgv,
  anyWithCommitArgv,
  createArgv,
  createdUrl,
  editArgv,
  firstOnOrigin,
  ghWords,
  openForBranchArgv,
  parsePullRequest,
  parsePullRequests,
  pullRequestNumbersIn,
  pullRequestUrlsOpenedIn,
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
  headRefName: "mend/fix-login",
  headRefOid: "a".repeat(40),
  isCrossRepository: false,
  headRepositoryOwner: { login: "acme" },
  createdAt: "2026-10-03T09:00:00Z",
};

/** The same branch name, pushed to someone's fork. */
const forkWire = {
  ...wire,
  number: 367,
  url: "https://github.com/acme/api/pull/367",
  isCrossRepository: true,
  headRepositoryOwner: { login: "anna" },
};

const view = {
  number: 412,
  url: "https://github.com/acme/api/pull/412",
  state: "open",
  title: "Fix login",
  body: "Closes #12",
  headRefName: "mend/fix-login",
  headRefOid: "a".repeat(40),
  crossRepository: false,
  headOwner: "acme",
  createdAt: new Date("2026-10-03T09:00:00Z"),
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
      "--json=number,url,state,title,body,headRefName,headRefOid,isCrossRepository,headRepositoryOwner,createdAt",
    ]);
    expect(openForBranchArgv(repository, "mend/x")).toContain("--head=mend/x");
    expect(openForBranchArgv(repository, "mend/x")).toContain("--state=open");
    // A fork's pull request from a branch of the same name must not hide origin's.
    expect(openForBranchArgv(repository, "mend/x")).toContain("--limit=20");
  });

  it("looks a branch up in every state, and a commit up across every branch and fork", () => {
    expect(anyForBranchArgv(repository, "chore/bump")).toEqual(
      expect.arrayContaining(["--head=chore/bump", "--state=all", "--repo=acme/api"]),
    );
    expect(anyWithCommitArgv(repository, "b".repeat(40))).toEqual(
      expect.arrayContaining([`--search=${"b".repeat(40)}`, "--state=all", "--repo=acme/api"]),
    );
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
    expect(parsePullRequest(JSON.stringify(wire))).toEqual(view);
    expect(parsePullRequest(JSON.stringify({ ...wire, state: "MERGED" }))?.state).toBe("merged");
    expect(parsePullRequest(JSON.stringify({ ...wire, state: "CLOSED" }))?.state).toBe("closed");
  });

  it("is null for output that is not the JSON asked for", () => {
    expect(parsePullRequest("no pull requests found")).toBeNull();
    expect(parsePullRequest(JSON.stringify({ ...wire, state: "DRAFT" }))).toBeNull();
  });

  it("keeps the first pull request whose head is on origin, never a fork's", () => {
    expect(firstOnOrigin(JSON.stringify([forkWire, wire]))?.number).toBe(412);
    expect(firstOnOrigin(JSON.stringify([forkWire]))).toBeNull();
    expect(firstOnOrigin("[]")).toBeNull();
    expect(parsePullRequests(JSON.stringify([forkWire]))?.[0]).toMatchObject({
      crossRepository: true,
      headOwner: "anna",
    });
    expect(parsePullRequests("no pull requests")).toBeNull();
  });

  it("reads a gh that leaves the head fields out as origin's own branch", () => {
    const { headRefName, headRefOid, isCrossRepository, headRepositoryOwner, ...bare } = wire;
    expect([headRefName, headRefOid, isCrossRepository, headRepositoryOwner]).toBeDefined();
    expect(parsePullRequest(JSON.stringify(bare))).toMatchObject({
      crossRepository: false,
      headOwner: null,
      headRefName: "",
    });
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

const command = (title: string, text: string | null = null) => ({
  kind: "command-execution",
  title,
  text,
  data: null,
});
const message = (text: string) => ({ kind: "assistant-message", title: null, text, data: null });

describe("a turn that ran gh pr create", () => {
  it("reads the URLs from the whole turn, the agent's own message included", () => {
    expect(
      pullRequestUrlsOpenedIn([
        // Claude records the command in the tool call's input, not its output.
        {
          kind: "command-execution",
          title: "Bash",
          text: null,
          data: { input: { command: 'gh pr create --title "Fix login" --body-file /tmp/b.md' } },
        },
        message("Opened https://github.com/acme/api/pull/413 for the fix."),
      ]),
    ).toEqual(["https://github.com/acme/api/pull/413"]);
    expect(
      pullRequestUrlsOpenedIn([
        command("gh pr create --fill", "https://github.com/acme/api/pull/414\n"),
      ]),
    ).toEqual(["https://github.com/acme/api/pull/414"]);
  });

  it("is empty when no command ran gh pr create, however many URLs the turn names", () => {
    expect(
      pullRequestUrlsOpenedIn([
        command("gh pr view 400"),
        message("This is like https://github.com/acme/api/pull/400, and gh pr create would…"),
      ]),
    ).toEqual([]);
  });

  it("keeps the project's own pull requests, newest first", () => {
    expect(
      pullRequestNumbersIn(repository, [
        "https://github.com/acme/api/pull/400",
        "https://github.com/ACME/api/pull/413",
        "https://github.com/someone/else/pull/999",
        "https://github.com/acme/api-docs/pull/5",
      ]),
    ).toEqual([413, 400]);
  });
});
