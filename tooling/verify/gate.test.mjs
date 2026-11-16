import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decide, evaluate, WAIVER } from "./gate.mjs";
import { main as recheck, nextStep } from "./recheck.mjs";
import { createResult, saveResult } from "./result.mjs";
import { toMarkdown } from "./status.mjs";
import { runVerb } from "./verify.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));

// A repository with the real obligations map, a base on main and a PR branch, where receipts are
// printed by the real `verify status` the way an author prints them.
const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "mend-verify-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "gate fixture",
    GIT_AUTHOR_EMAIL: "gate@example.invalid",
    GIT_COMMITTER_NAME: "gate fixture",
    GIT_COMMITTER_EMAIL: "gate@example.invalid",
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const path of [
    "tooling/verify/obligations.json",
    "tooling/verify/allowed-skips.json",
    "tooling/verify/local-stack-limits.json",
    ".github/workflows/ci.yml",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repo, path), join(root, path));
  }
  write(".gitignore", ".verify/\n");
  write("apps/web/src/routes/a.tsx", "export const a = 1;\n");
  git("init", "-b", "main");
  git("add", "-A");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "work");
  const commit = (path, text = `${path}\n`) => {
    write(path, text);
    git("add", "-A");
    git("commit", "-m", `change ${path}`);
    return git("rev-parse", "HEAD");
  };
  const options = (extra = {}) => ({ base: "main", files: undefined, all: false, ...extra });
  /** The receipt an author prints for the current commit, judged and, unless `run` is false, run. */
  const receipt = async ({ self = false, run = true } = {}) => {
    const answer = join(root, ".verify/answer.json");
    write(
      ".verify/answer.json",
      JSON.stringify({
        where: "local",
        reason: "A web route; nothing needs Boat, old data or a real agent turn.",
        mustSee: ["Open Projects", "See the new row", "Reload and see it again"],
        ifBroken: "The row is missing",
      }),
    );
    const judged = await runVerb(root, "judge", options({ record: answer, self }));
    saveResult(root, judged);
    if (run)
      saveResult(
        root,
        createResult({
          verb: "evidence",
          head: judged.head,
          startedAt: new Date(),
          steps: [{ id: "verdict", title: "Write the verdict file", status: "passed" }],
          next: [],
        }),
      );
    return toMarkdown(await runVerb(root, "status", options()));
  };
  return { root, base, commit, receipt };
};

const pr = ({ body = "", sha, labels = [], ref = "work", login = "someone" }) => ({
  body,
  head: { sha, ref },
  user: { login },
  labels: labels.map((name) => ({ name })),
});

test("a PR that owes a run passes only with a receipt for its product change, judged and run", async (t) => {
  const { root, base, commit, receipt } = fixture(t);
  const first = commit("apps/web/src/routes/a.tsx", "export const a = 2;\n");
  const gate = (body, headSha) =>
    evaluate(root, { pr: pr({ body, sha: headSha }), headSha, baseSha: base });

  const none = gate("Just a description.", first);
  assert.equal(none.passed, false);
  assert.match(none.summary, /carries no receipt/);
  assert.match(none.summary, /pnpm verify judge --record/);
  assert.match(none.summary, /Editing the PR body is enough/);

  const unrun = await receipt({ run: false });
  assert.match(gate(unrun, first).summary, /`run-it` is skipped/);

  const body = `Why.\n\n${await receipt()}`;
  const passed = gate(body, first);
  assert.equal(passed.passed, true);
  assert.match(passed.summary, /judged by another agent/);

  // A push of tests and docs keeps the product change, so the earlier receipt still counts.
  const tested = commit("apps/web/src/routes/a.test.tsx");
  commit("docs/notes.md");
  const docs = commit("apps/web/README.md");
  assert.notEqual(docs, tested);
  const kept = gate(body, docs);
  assert.equal(kept.passed, true);
  assert.match(kept.summary, /same product change as the head/);

  // A push that changes product source needs a receipt of its own.
  const changed = commit("apps/web/src/routes/b.tsx");
  const stale = gate(body, changed);
  assert.equal(stale.passed, false);
  assert.match(stale.summary, /product-source change differs/);

  const self = await receipt({ self: true });
  assert.match(gate(self, changed).summary, /the author judged it/);
  // An older receipt left above the newest does not hide it.
  assert.equal(gate(`${body}\n${self}`, changed).passed, true);
});

test("what owes no receipt passes untouched, and a damaged receipt is named", async (t) => {
  const { root, base, commit } = fixture(t);
  const docs = commit("docs/a.md");
  const owesNothing = evaluate(root, { pr: pr({ sha: docs }), headSha: docs, baseSha: base });
  assert.equal(owesNothing.passed, true);
  assert.match(owesNothing.summary, /owes neither/);

  const sha = "a".repeat(40);
  const owed = (fields) =>
    decide({ pr: pr({ sha, ...fields }), owes: true, headSha: sha, headPatchId: null });
  assert.match(owed({ ref: "changeset-release/main" }).summary, /Version Packages/);
  assert.match(owed({ login: "dependabot[bot]" }).summary, /Dependabot/);
  assert.match(owed({ labels: [WAIVER] }).summary, /waived by a person/);
  assert.equal(owed({ labels: ["unrelated"] }).passed, false);
  const moved = decide({
    pr: pr({ sha: "b".repeat(40) }),
    owes: true,
    headSha: sha,
    headPatchId: null,
  });
  assert.equal(moved.passed, true, "an older head's run leaves the decision to the head's own run");

  const damaged = owed({ body: "```json verify-receipt\n{ not json\n```\n" });
  assert.equal(damaged.passed, false);
  assert.match(damaged.summary, /a damaged receipt: the block is not JSON/);
});

test("an edit re-runs receipt only once its run has finished and receipt alone failed", async () => {
  const job = (name, status, conclusion = null, id = name.length) => ({
    name,
    status,
    conclusion,
    id,
  });
  const running = { status: "in_progress" };
  const finished = { status: "completed" };
  assert.match(nextStep(undefined, []).done, /no CI run/);
  assert.match(nextStep(running, [job("static", "in_progress")]).done, /has not started/);
  assert.match(nextStep(running, [job("receipt", "queued")]).done, /has not started/);
  assert.deepEqual(nextStep(running, [job("receipt", "completed", "failure")]), { wait: true });
  const ran = [job("static", "completed", "success"), job("formal", "completed", "skipped")];
  assert.match(
    nextStep(finished, [...ran, job("receipt", "completed", "success")]).done,
    /success/,
  );
  assert.match(
    nextStep(finished, [
      job("static", "completed", "failure"),
      job("receipt", "completed", "failure"),
    ]).done,
    /static failure would fail checks again/,
  );
  assert.deepEqual(
    nextStep(finished, [
      ...ran,
      job("receipt", "completed", "failure", 77),
      job("checks", "completed", "failure"),
    ]),
    { rerun: 77 },
  );

  // Through the API: it waits out a run whose receipt has run, then re-runs that job once.
  const calls = [];
  let looks = 0;
  const call = async (path, method = "GET") => {
    calls.push(`${method} ${path}`);
    if (path === "/pulls/9") return { head: { sha: "f".repeat(40) } };
    if (path.startsWith("/actions/workflows/ci.yml/runs"))
      return {
        workflow_runs: [
          { id: 1, run_number: 3 },
          { id: 2, run_number: 4 },
        ],
      };
    if (path === "/actions/runs/2") {
      looks += 1;
      return {
        id: 2,
        run_attempt: 1,
        html_url: "run-2",
        status: looks < 2 ? "in_progress" : "completed",
      };
    }
    if (path.startsWith("/actions/runs/2/attempts/1/jobs"))
      return { jobs: [...ran, job("receipt", "completed", "failure", 5)] };
    return null;
  };
  const said = await recheck({ env: { PR_NUMBER: "9" }, call, wait: async () => {} });
  assert.match(said, /re-ran receipt/);
  assert.deepEqual(
    calls.filter((line) => line.startsWith("POST")),
    ["POST /actions/jobs/5/rerun"],
  );
  assert.ok(
    calls.every((line) => !line.includes("/runs/1")),
    "the newest run is the head's",
  );
});
