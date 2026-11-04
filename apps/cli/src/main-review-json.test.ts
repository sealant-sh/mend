import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend } = mainTestFixtures();
const id = "11111111-1111-4111-8111-111111111111";
const session = {
  id,
  projectId: "project",
  worktree: "fix-login",
  worktreeId: "worktree",
  branch: "mend/fix-login",
  status: "completed",
};
const change = {
  id: "change",
  worktreeId: "worktree",
  projectId: "project",
  sessionId: id,
  branch: session.branch,
};
const checkpoint = (checkpointId: string, ordinal: number) => ({
  id: checkpointId,
  ordinal,
  sha: `sha-${ordinal}`,
  sessionId: null,
  sealantRunId: "run",
  seq: "12",
  trigger: "turn-boundary",
  createdAt: "2026-11-04T00:00:00Z",
});
const checkpointA = checkpoint("base", 0);
const checkpointB = checkpoint("end", 1);
const detail = { session, change, checkpoints: [checkpointA, checkpointB] };
const slice = {
  id: "slice",
  checkpointAId: "base",
  checkpointBId: "end",
  diffDigest: "digest",
  createdAt: "2026-11-04T00:00:00Z",
};
const file = {
  oldPath: "src/auth.ts",
  newPath: "src/auth.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  binary: false,
  hunks: [{ oldStart: 40, oldLines: 3, newStart: 40, newLines: 4, contextHash: "hunk-hash" }],
};
const pinned = {
  change,
  slice,
  checkpointA,
  checkpointB,
  files: [file],
  anchorFiles: [file],
  patch: "diff --git a/src/auth.ts b/src/auth.ts\n",
  worktreeChangedSinceSnapshot: false,
};
const comment = {
  id: "comment",
  changeId: "change",
  file: "src/auth.ts",
  line: 42,
  endLine: 42,
  authorKind: "reviewer",
  authorName: "Mira",
  body: "This swallows the error",
  kind: "note",
  suggestion: null,
  state: "open",
  evidence: [{ sealantRunId: "run", sequence: "9007199254740993", excerpt: "observed" }],
  sentToSessionId: null,
  anchor: {
    reviewSliceId: "slice",
    checkpointAId: "base",
    checkpointBId: "end",
    diffDigest: "digest",
    oldPath: file.oldPath,
    newPath: file.newPath,
    side: "new",
    startLine: 42,
    endLine: 42,
    hunkContextHash: "hunk-hash",
    mapping: "anchored",
  },
  createdAt: checkpointA.createdAt,
  updatedAt: checkpointA.createdAt,
};
const followUp = {
  id: "follow-up",
  reviewSliceId: "slice",
  checkpointAId: "base",
  checkpointBId: "end",
  diffDigest: "digest",
  commentIds: ["comment"],
  instruction: "Saved instruction",
  idempotencyKey: "persisted-key",
  status: "delivered",
  deliveryProcessId: "process",
  deliverySealantRunId: "run",
  deliveryError: null,
  deliveredAt: checkpointA.createdAt,
};

describe("shell review without a terminal", spawning, () => {
  it.each([["change"], ["diff"], ["comment", "add"], ["comment", "send"], ["land"]])(
    "returns usage and a fix for missing inputs %j",
    async (...words) => {
      const cli = startCli("http://127.0.0.1:1", [...words, "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 2 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "usage",
        error: { code: "needs_input", fix: expect.any(String) },
      });
    },
  );

  it("reads files, immutable checkpoints and draft findings with record evidence", async () => {
    const keys: Array<string> = [];
    const fake = await startFakeMend(async (req, res) => {
      if (req.url?.endsWith("/reviews/open")) {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        keys.push(JSON.parse(body).idempotencyKey);
        return json(res, { slice, checkpointA, checkpointB });
      }
      if (req.url?.endsWith("/diff")) return json(res, pinned);
      if (req.url?.endsWith("/comments"))
        return json(res, [
          { ...comment, state: "draft", authorKind: "mend", privateMetadata: "never-print-this" },
        ]);
      if (req.url?.endsWith("/passes"))
        return json(res, [
          {
            kind: "read",
            status: "completed",
            detail: null,
            findings: 1,
            startedAt: checkpointA.createdAt,
            finishedAt: checkpointA.createdAt,
          },
        ]);
      if (req.url?.endsWith("/tour"))
        return json(res, {
          summary: "An inferred reading",
          approach: null,
          diffDigest: "older-digest",
          createdAt: checkpointA.createdAt,
          stops: [],
        });
      json(res, detail);
    });
    try {
      for (let n = 0; n < 2; n += 1) {
        const cli = startCli(fake.url, ["change", id, "--json"]);
        expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
        expect(JSON.parse(cli.stdout())).toMatchObject({
          v: 1,
          status: "done",
          data: {
            changeId: "change",
            slice,
            stats: { files: 1, additions: 2, deletions: 1 },
            comments: [{ state: "draft", evidence: [{ sequence: "9007199254740993" }] }],
            tour: { matchesSlice: false },
          },
        });
        expect(cli.stdout()).not.toContain("never-print-this");
      }
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
    } finally {
      await fake.close();
    }
  });

  it("reuses an explicit slice and prints just its patch", async () => {
    const routes: Array<string | undefined> = [];
    const fake = await startFakeMend((req, res) => {
      routes.push(req.url);
      json(res, req.url?.endsWith("/diff") ? pinned : detail);
    });
    try {
      const cli = startCli(fake.url, ["diff", id, "--slice", "slice"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(cli.stdout()).toBe(pinned.patch);
      expect(routes).toContain("/api/changes/change/reviews/slice/diff");
      expect(routes.some((route) => route?.endsWith("/reviews/open"))).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("reads an immutable checkpoint range and exposes omitted patches", async () => {
    const routes: Array<string | undefined> = [];
    const fake = await startFakeMend((req, res) => {
      routes.push(req.url);
      json(
        res,
        req.url?.includes("/worktrees/worktree/diff?")
          ? {
              worktreeId: "worktree",
              from: checkpointA,
              to: checkpointB,
              fromSha: "sha-0",
              diff: pinned.patch,
              files: [file],
              truncated: true,
              omitted: ["large.ts"],
              listingCut: false,
            }
          : detail,
      );
    });
    try {
      const cli = startCli(fake.url, ["diff", id, "--from", "base", "--to", "end", "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        data: { from: { id: "base" }, to: { id: "end" }, truncated: true, omitted: ["large.ts"] },
      });
      expect(routes).toContain("/api/worktrees/worktree/diff?to=end&from=base");
    } finally {
      await fake.close();
    }
  });

  it.each(["new", "old"])("anchors a remark to the canonical %s-side hunk", async (side) => {
    const writes: Array<unknown> = [];
    const fake = await startFakeMend(async (req, res) => {
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        writes.push(JSON.parse(body));
        return json(res, comment);
      }
      json(res, req.url?.endsWith("/diff") ? pinned : detail);
    });
    try {
      const cli = startCli(
        fake.url,
        [
          "comment",
          "add",
          id,
          "src/auth.ts:41-42",
          "-",
          "--slice",
          "slice",
          "--side",
          side,
          "--json",
        ],
        {},
        undefined,
        "This swallows the error\n",
      );
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: { comment: { id: "comment" } },
      });
      expect(writes).toEqual([
        {
          body: "This swallows the error\n",
          target: {
            oldPath: file.oldPath,
            newPath: file.newPath,
            side,
            startLine: 41,
            endLine: 42,
            hunkContextHash: "hunk-hash",
          },
        },
      ]);
    } finally {
      await fake.close();
    }
  });

  it("refuses an anchor outside the viewed slice before saving", async () => {
    const writes: Array<string> = [];
    const fake = await startFakeMend((req, res) => {
      if (req.method === "POST") writes.push(req.url ?? "");
      json(res, req.url?.endsWith("/diff") ? pinned : detail);
    });
    try {
      const cli = startCli(fake.url, [
        "comment",
        "add",
        id,
        "src/auth.ts:99",
        "remark",
        "--slice",
        "slice",
        "--json",
      ]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 2 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        error: { code: "comment_target_not_found", fix: expect.any(String) },
      });
      expect(writes).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("sends open remarks, excludes draft findings and never attaches", async () => {
    let submitted: unknown;
    const fake = await startFakeMend(async (req, res) => {
      if (req.url?.endsWith("/follow-up/deliver")) {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        submitted = JSON.parse(body);
        return json(res, followUp);
      }
      if (req.url?.endsWith("/follow-up")) return json(res, null);
      if (req.url?.endsWith("/comments"))
        return json(res, [comment, { ...comment, id: "draft", state: "draft" }]);
      json(res, req.url?.endsWith("/diff") ? pinned : detail);
    });
    try {
      const cli = startCli(fake.url, ["comment", "send", id, "--slice", "slice", "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: { status: "delivered", requestKey: "persisted-key", processId: "process" },
      });
      expect(submitted).toMatchObject({
        reviewSliceId: "slice",
        checkpointAId: "base",
        checkpointBId: "end",
        diffDigest: "digest",
        commentIds: ["comment"],
        instruction: expect.stringContaining(comment.body),
        idempotencyKey: expect.stringMatching(/^cli-review-send:/),
      });
      expect(fake.upgradeCount()).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it("reconciles a pending bundle with its saved instruction and key", async () => {
    let submitted: unknown;
    const fake = await startFakeMend(async (req, res) => {
      if (req.url?.endsWith("/follow-up/deliver")) {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        submitted = JSON.parse(body);
        return json(res, { ...followUp, status: "delivering" });
      }
      json(res, req.url?.endsWith("/follow-up") ? { ...followUp, status: "delivering" } : detail);
    });
    try {
      const cli = startCli(fake.url, ["comment", "send", id, "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "failed",
        error: { code: "follow_up_unconfirmed" },
        data: { requestKey: "persisted-key" },
      });
      expect(submitted).toEqual({
        reviewSliceId: "slice",
        checkpointAId: "base",
        checkpointBId: "end",
        diffDigest: "digest",
        commentIds: ["comment"],
        instruction: "Saved instruction",
        idempotencyKey: "persisted-key",
      });
    } finally {
      await fake.close();
    }
  });

  it.each([true, false])("reports landing observations with pushed=%s", async (pushed) => {
    const landing = {
      remoteBranch: "mend/fix-login",
      pushedSha: pushed ? "sha-pushed" : null,
      commitSha: null,
      checkpointSha: "sha-checkpoint",
      outcome: pushed ? "pull-request" : "refused",
      message: pushed ? null : "Origin refused this push",
      pullRequest: pushed
        ? {
            number: 412,
            url: "https://github.com/acme/repo/pull/412",
            state: "open",
            observedAt: checkpointA.createdAt,
          }
        : null,
    };
    const fake = await startFakeMend((req, res) =>
      json(res, req.url?.endsWith("/land") ? { landing, pullRequest: { _tag: "off" } } : detail),
    );
    try {
      const cli = startCli(fake.url, ["land", id, "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: pushed ? 0 : 1 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: pushed ? "done" : "failed",
        data: { landing },
      });
    } finally {
      await fake.close();
    }
  });

  it("resolves a worktree inside the explicitly selected landing project", async () => {
    const routes: Array<string | undefined> = [];
    const fake = await startFakeMend((req, res) => {
      routes.push(req.url);
      if (req.url === "/api/projects") return json(res, [{ id: "project", name: "mend" }]);
      if (req.url?.startsWith("/api/projects/project?"))
        return json(res, {
          sessions: [
            { ...session, harness: "claude", label: null, createdAt: checkpointA.createdAt },
          ],
        });
      if (req.url?.endsWith("/pull-request/check"))
        return json(res, { outcome: "observed", reason: null, landing: null });
      json(res, detail);
    });
    try {
      const cli = startCli(fake.url, [
        "land",
        "fix-login",
        "--project",
        "mend",
        "--check",
        "--json",
      ]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        data: { sessionId: id, outcome: "observed" },
      });
      expect(routes).toContain("/api/projects/project?deadEnds=include");
      expect(routes.some((route) => route?.endsWith("/land"))).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("keeps a successful push visible when the pull request step fails", async () => {
    const landing = {
      remoteBranch: "mend/fix-login",
      pushedSha: "sha-pushed",
      commitSha: null,
      checkpointSha: "checkpoint",
      outcome: "pushed",
      message: null,
      pullRequest: null,
    };
    const fake = await startFakeMend((req, res) =>
      json(
        res,
        req.url?.endsWith("/land")
          ? {
              landing,
              pullRequest: {
                _tag: "failed",
                message: "GitHub was unavailable",
                metadata: "never-print-this",
              },
            }
          : detail,
      ),
    );
    try {
      const cli = startCli(fake.url, ["land", id, "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "failed",
        data: { landing: { pushedSha: "sha-pushed" }, pullRequest: { status: "failed" } },
        error: { code: "landing_failed", message: "GitHub was unavailable" },
      });
      expect(cli.stdout()).not.toContain("never-print-this");
    } finally {
      await fake.close();
    }
  });
});
