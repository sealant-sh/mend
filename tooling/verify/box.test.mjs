import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { holdBy, parseState, relate, schemaProblems } from "./box.mjs";
import { exitCode, validateResult } from "./result.mjs";
import { parseArgs, runVerb } from "./verify.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migrations = execFileSync("node", [join(root, "scripts/mend-migrations.mjs")], {
  encoding: "utf8",
})
  .trim()
  .split("\n");

// What READ_STATE prints on a box running `revision`, with every migration this head has.
const boxSays = ({
  live = "0",
  hold = "",
  revision = "a".repeat(40),
  applied = migrations,
  free = 40 * 1024 ** 3,
} = {}) =>
  [
    "version=0.37.0-next.1.preview.1",
    `revision=${revision}`,
    "started=2026-11-14T20:00:00Z",
    `live=${live}`,
    `free=${free}`,
    `hold=${hold}`,
    "now=2026-11-14T22:00:00Z",
    ...applied.map((name) => `migration=${Number(name.slice(0, 4))}|${name.slice(5)}`),
  ].join("\n");

const GB = 1024 ** 3;
const sha = (n) => `sha256:${String(n).padStart(64, "0")}`;
// What LIST_BOX prints: previews 1 to 5 with 5 running, a 7 GB workspace image, and two dumps.
const boxLists = ({ free = 40 * GB } = {}) =>
  [
    `free=${free}`,
    "now=2026-11-14T22:00:00Z",
    ...[1, 2, 3, 4, 5].map(
      (run) =>
        `image=${sha(run)}|["ghcr.io/sealant-sh/mend:0.37.0-next.1.preview.${run}"]|[]|2026-11-1${run}T00:00:00Z|2026-11-1${run}T00:00:00Z|${3 * GB}|{}`,
    ),
    `image=${sha(9)}|["sealant-workspace-ubuntu:latest"]|[]|2026-11-14T00:00:00Z|2026-11-14T00:00:00Z|${7 * GB}|null`,
    `container=${sha(5)}|/mend-mend-1|running`,
    'cache={"BuildCache":[]}',
    "dump=1794700000|300000000|/root/backups/pre-pr1600.sql",
  ].join("\n");

// A box that answers the read, the listing and a tidy, and records every script it was sent.
const fakeBox = (text, { listing = boxLists(), after = 40 * GB } = {}) => {
  const scripts = [];
  const ssh = (script) => {
    scripts.push(script);
    if (script.includes("pg_dumpall")) return { code: 0, stdout: "141557760\n", stderr: "" };
    if (script.includes("# tidy-listing")) return { code: 0, stdout: listing, stderr: "" };
    if (script.includes("exit 9")) {
      const removed = [...script.matchAll(/echo "removed=([^"]+)"/g)].map((m) => `removed=${m[1]}`);
      return { code: 0, stdout: ["before=1", ...removed, `after=${after}`].join("\n"), stderr: "" };
    }
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

test("a --tag names the check in its hold, its dump and the command to rerun", async () => {
  const dry = fakeBox(boxSays());
  const plan = await box("prepare", {
    sshRunner: dry.ssh,
    pr: undefined,
    tag: "main-c374a10430f2",
  });
  assert.deepEqual(plan.next, ["pnpm verify box prepare --yes --tag main-c374a10430f2"]);

  const real = fakeBox(boxSays());
  const done = await box("prepare", {
    sshRunner: real.ssh,
    pr: undefined,
    tag: "main-c374a10430f2",
    yes: true,
  });
  assert.equal(done.status, "passed");
  const dump = real.scripts.find((script) => script.includes("pg_dumpall"));
  assert.match(dump, /\/root\/backups\/pre-main-c374a10430f2-/);
  assert.match(dump, /"tag":"main-c374a10430f2"/);

  const ours = fakeBox(
    boxSays({ hold: JSON.stringify({ tag: "main-c374a10430f2", at: "2026-11-14T20:00:00Z" }) }),
  );
  const released = await box("release", {
    sshRunner: ours.ssh,
    pr: undefined,
    tag: "main-c374a10430f2",
    yes: true,
  });
  assert.equal(released.status, "passed");
  assert.ok(
    ours.scripts.some((script) => script.includes("rm -f /var/lib/mend-box-check/hold.json")),
  );
});

test("--tag takes a name no PR or commit check uses, and not beside --pr", () => {
  assert.equal(
    parseArgs(["box", "plan", "--tag", "main-c374a10430f2"]).options.tag,
    "main-c374a10430f2",
  );
  for (const argv of [
    ["box", "plan", "--tag", "pr1700"],
    ["box", "plan", "--tag", "sha-c374a10430f2"],
    ["box", "plan", "--tag", "Main Run"],
    ["box", "plan", "--tag"],
    ["box", "plan", "--tag", "main-x", "--pr", "1700"],
  ])
    assert.throws(() => parseArgs(argv), /--tag|--pr/, argv.join(" "));
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

const ours = JSON.stringify({ tag: "pr1700", head: "b".repeat(40), at: "2026-11-14T21:00:00Z" });
const tidies = (scripts) => scripts.filter((script) => script.includes("exit 9"));

test("release tidies while it still holds the box, then lifts the hold", async () => {
  const real = fakeBox(boxSays({ hold: ours }));
  const done = await box("release", { sshRunner: real.ssh, yes: true });
  assert.deepEqual(validateResult(done), []);
  assert.equal(done.status, "passed");
  const tidy = tidies(real.scripts);
  assert.equal(tidy.length, 1);
  assert.match(tidy[0], /docker image rm 'ghcr.io\/sealant-sh\/mend:0.37.0-next.1.preview.1'/);
  assert.doesNotMatch(
    tidy[0],
    /preview\.[345]'|workspace/,
    "never the newest three or a workspace image",
  );
  const lift = real.scripts.findIndex((script) =>
    script.includes("rm -f /var/lib/mend-box-check/hold.json"),
  );
  assert.ok(real.scripts.indexOf(tidy[0]) < lift, "the tidy runs before the hold is lifted");
  assert.deepEqual(
    done.tidy.removed.images.map((image) => image.ref),
    [
      "ghcr.io/sealant-sh/mend:0.37.0-next.1.preview.2",
      "ghcr.io/sealant-sh/mend:0.37.0-next.1.preview.1",
    ],
  );
  assert.equal(done.tidy.after, 40 * GB);
  assert.match(done.steps[0].detail, /free .* before, 40\.0 GiB after/);
});

test("release removes nothing without its own hold, nor without --yes", async () => {
  const theirs = fakeBox(
    boxSays({ hold: JSON.stringify({ tag: "pr1600", at: "2026-11-14T21:00:00Z" }) }),
  );
  await box("release", { sshRunner: theirs.ssh, yes: true });
  assert.deepEqual(tidies(theirs.scripts), []);
  const dry = fakeBox(boxSays({ hold: ours }));
  const plan = await box("release", { sshRunner: dry.ssh });
  assert.equal(plan.status, "skipped");
  assert.match(plan.steps[0].detail, /Would remove 2 images/);
  assert.deepEqual(tidies(dry.scripts), []);
  assert.ok(!dry.scripts.some((script) => script.includes("rm -f")));
});

test("plan refuses, with the reason, a box short of room for one deploy", async () => {
  const short = fakeBox(boxSays({ free: 8 * GB }), { listing: boxLists({ free: 8 * GB }) });
  const plan = await box("plan", { sshRunner: short.ssh });
  const disk = plan.steps.find((step) => step.id === "disk");
  assert.equal(disk.status, "blocked_by_prerequisite");
  assert.match(
    disk.detail,
    /8\.0 GiB free .* one deploy needs 10\.3 GiB \(image 3\.0 GiB, dump 0\.3 GiB, workspace image 7\.0 GiB/,
  );
  assert.match(disk.detail, /a tidy would remove 2 images/);
  assert.deepEqual(tidies(short.scripts), [], "plan only reads");
});

test("prepare on a short box holds it and tidies; it goes on only when that made room", async () => {
  const roomy = fakeBox(boxSays({ free: 8 * GB }), {
    listing: boxLists({ free: 8 * GB }),
    after: 14 * GB,
  });
  const done = await box("prepare", { sshRunner: roomy.ssh, yes: true });
  assert.deepEqual(validateResult(done), []);
  assert.equal(done.status, "passed");
  const held = roomy.scripts.findIndex((script) => /printf '%s' '\{"tag":"pr1700"/.test(script));
  const tidy = roomy.scripts.indexOf(tidies(roomy.scripts)[0]);
  const dump = roomy.scripts.findIndex((script) => script.includes("pg_dumpall"));
  assert.ok(held >= 0 && held < tidy && tidy < dump, "hold, then tidy, then dump");

  const still = fakeBox(boxSays({ free: 8 * GB }), {
    listing: boxLists({ free: 8 * GB }),
    after: 9 * GB,
  });
  const refused = await box("prepare", { sshRunner: still.ssh, yes: true });
  assert.equal(refused.status, "blocked_by_prerequisite");
  assert.match(
    refused.steps.find((step) => step.id === "disk").detail,
    /after tidying, 9\.0 GiB; one deploy needs 10\.3 GiB/,
  );
  assert.ok(!still.scripts.some((script) => script.includes("pg_dumpall")));
  assert.ok(
    still.scripts.at(-1).includes("rm -f /var/lib/mend-box-check/hold.json"),
    "its hold is lifted",
  );

  const busy = fakeBox(boxSays({ free: 8 * GB, live: "1" }), {
    listing: boxLists({ free: 8 * GB }),
  });
  await box("prepare", { sshRunner: busy.ssh, yes: true });
  assert.deepEqual(tidies(busy.scripts), [], "a box in use by another check is never tidied");
});
