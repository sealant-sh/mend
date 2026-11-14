import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { holdBy, parseState, relate, schemaProblems } from "./box.mjs";
import { exitCode, validateResult } from "./result.mjs";
import { runVerb } from "./verify.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migrations = execFileSync("node", [join(root, "scripts/mend-migrations.mjs")], {
  encoding: "utf8",
})
  .trim()
  .split("\n");

// What READ_STATE prints on a box running `revision`, with every migration this head has.
const boxSays = ({ live = "0", hold = "", revision = "a".repeat(40), applied = migrations } = {}) =>
  [
    "version=0.37.0-next.1.preview.1",
    `revision=${revision}`,
    "started=2026-11-14T20:00:00Z",
    `live=${live}`,
    `free=${40 * 1024 ** 3}`,
    `hold=${hold}`,
    "now=2026-11-14T22:00:00Z",
    ...applied.map((name) => `migration=${Number(name.slice(0, 4))}|${name.slice(5)}`),
  ].join("\n");

// A box that answers the read and records every script it was sent.
const fakeBox = (text) => {
  const scripts = [];
  const ssh = (script) => {
    scripts.push(script);
    if (script.includes("pg_dumpall")) return { code: 0, stdout: "141557760\n", stderr: "" };
    return { code: 0, stdout: text, stderr: "" };
  };
  return { ssh, scripts };
};

const box = (subverb, extra) =>
  runVerb(root, "box", { base: "origin/main", subverb, pr: "1700", ...extra });

test("the box's state is read with unknowns kept unknown", () => {
  const state = parseState(boxSays({ live: "" }));
  assert.equal(state.live, null, "a count that could not be read is not zero");
  assert.equal(state.revision, "a".repeat(40));
  assert.deepEqual(state.migrations, migrations);
  assert.equal(parseState("version=\nrevision=not-a-sha").revision, null);
});

test("a box schema this head cannot take is named, both ways", () => {
  const head = ["0001_a", "0002_b", "0004_d"];
  assert.deepEqual(schemaProblems(["0001_a", "0002_b"], head), []);
  assert.deepEqual(schemaProblems(["0001_a", "0002_b", "0003_c"], head), [
    "the box applied 0003_c, which this head lacks",
  ]);
  assert.deepEqual(schemaProblems(["0001_a", "0004_d"], head), [
    "this head's 0002_b is at or below the box's 4 and would never run",
  ]);
});

test("another check's hold counts until it lapses; this check's own never does", () => {
  const now = "2026-11-14T22:00:00Z";
  assert.equal(holdBy({ tag: "pr1600", at: "2026-11-14T20:00:00Z" }, now, "pr1700").tag, "pr1600");
  assert.equal(holdBy({ tag: "pr1600", at: "2026-11-14T15:00:00Z" }, now, "pr1700"), null);
  assert.equal(holdBy({ tag: "pr1700", at: "2026-11-14T21:00:00Z" }, now, "pr1700"), null);
  assert.equal(holdBy(null, now, "pr1700"), null);
});

test("without a box named, every box verb is blocked by a prerequisite", async () => {
  const saved = process.env.MEND_VERIFY_BOX_SSH;
  delete process.env.MEND_VERIFY_BOX_SSH;
  try {
    for (const subverb of ["plan", "prepare", "identity", "release"]) {
      const result = await box(subverb);
      assert.deepEqual(validateResult(result), [], subverb);
      assert.equal(result.status, "blocked_by_prerequisite", subverb);
      assert.equal(exitCode(result.status), 3);
      assert.match(result.next[0], /MEND_VERIFY_BOX_SSH/);
    }
  } finally {
    if (saved !== undefined) process.env.MEND_VERIFY_BOX_SSH = saved;
  }
});

test("plan says the box is held while sessions live or another check holds it", async () => {
  const free = await box("plan", { sshRunner: fakeBox(boxSays()).ssh });
  assert.deepEqual(validateResult(free), []);
  assert.equal(free.status, "passed");
  for (const text of [
    boxSays({ live: "2" }),
    boxSays({ live: "" }),
    boxSays({ hold: JSON.stringify({ tag: "pr1600", at: "2026-11-14T21:00:00Z" }) }),
  ]) {
    const held = await box("plan", { sshRunner: fakeBox(text).ssh });
    assert.equal(held.steps.find((step) => step.id === "free").status, "blocked_by_prerequisite");
  }
  const ahead = await box("plan", {
    sshRunner: fakeBox(boxSays({ applied: [...migrations, "9999_from_another_branch"] })).ssh,
  });
  assert.equal(ahead.steps.find((step) => step.id === "schema").status, "blocked_by_prerequisite");
});

test("prepare changes nothing without --yes, and with it dumps and holds", async () => {
  const dry = fakeBox(boxSays());
  const plan = await box("prepare", { sshRunner: dry.ssh });
  assert.deepEqual(validateResult(plan), []);
  assert.equal(plan.status, "skipped");
  assert.deepEqual(plan.next, ["pnpm verify box prepare --yes --pr 1700"]);
  assert.ok(!dry.scripts.some((script) => script.includes("pg_dumpall")));

  const held = fakeBox(boxSays({ live: "1" }));
  assert.equal(
    (await box("prepare", { sshRunner: held.ssh, yes: true })).status,
    "blocked_by_prerequisite",
  );
  assert.ok(
    !held.scripts.some((script) => script.includes("pg_dumpall")),
    "a busy box is left alone",
  );

  const real = fakeBox(boxSays());
  const done = await box("prepare", { sshRunner: real.ssh, yes: true });
  assert.deepEqual(validateResult(done), []);
  assert.equal(done.status, "passed");
  const dump = real.scripts.find((script) => script.includes("pg_dumpall"));
  assert.match(dump, /dump complete/);
  assert.match(dump, /"tag":"pr1700"/);
  assert.equal(done.cleanup.status, "left");
});

test("cli stages nothing without --yes, and refuses a tree that is not the commit", async (t) => {
  const { cwd } = history(t);
  const run = (_command, args) => {
    writeFileSync(join(args.at(-1), "sealant-mend-0.0.0.tgz"), "tarball");
    return { status: 0, stderr: "" };
  };
  const remote = fakeBox(boxSays());
  const options = { base: "main", subverb: "cli", pr: "1700", sshRunner: remote.ssh, run };
  const clean = await runVerb(cwd, "box", options);
  assert.deepEqual(validateResult(clean), []);
  assert.equal(clean.status, "skipped");
  assert.deepEqual(clean.next, ["pnpm verify box cli --yes --pr 1700"]);
  assert.equal(remote.scripts.length, 0, "the box is untouched");

  writeFileSync(join(cwd, "uncommitted.txt"), "x\n");
  const dirty = await runVerb(cwd, "box", options);
  assert.equal(dirty.status, "blocked_by_prerequisite");
});

// A repository with main, this change, another branch, a preview merge of the two, and the change
// squashed onto main.
const history = (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mend-verify-relate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "f",
    GIT_AUTHOR_EMAIL: "f@example.invalid",
    GIT_COMMITTER_NAME: "f",
    GIT_COMMITTER_EMAIL: "f@example.invalid",
  };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const commit = (file, text) => {
    writeFileSync(join(cwd, file), text);
    git("add", "-A");
    git("commit", "-qm", file);
    return git("rev-parse", "HEAD");
  };
  git("init", "-qb", "main");
  const base = commit("a.txt", "a\n");
  git("checkout", "-qb", "change");
  const change = commit("change.txt", "the change\n");
  git("checkout", "-qb", "other", base);
  commit("other.txt", "another check\n");
  git("merge", "-q", "--no-edit", "change");
  const preview = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  git("merge", "-q", "--squash", "change");
  git("commit", "-qm", "squash");
  const squash = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", base);
  const unrelated = commit("b.txt", "unrelated\n");
  return { cwd, head: { sha: change, mergeBase: base }, preview, squash, unrelated };
};

test("identity finds this change by commit, by descent, or by patch id, and says when it is absent", (t) => {
  const { cwd, head, preview, squash, unrelated } = history(t);
  assert.equal(relate(cwd, { head, revision: head.sha }).relation, "exact");
  const merged = relate(cwd, { head, revision: preview });
  assert.equal(merged.relation, "descendant", "a preview merge keeps the change's commit");
  const squashed = relate(cwd, { head, revision: squash });
  assert.equal(squashed.relation, "patch");
  assert.equal(squashed.via, squash);
  const absent = relate(cwd, { head, revision: unrelated });
  assert.equal(absent.relation, "none");
  assert.equal(absent.contains, false);
});
