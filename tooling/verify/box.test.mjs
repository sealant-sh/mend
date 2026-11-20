import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { frontOnly } from "./box-front.mjs";
import {
  boxIdentity,
  boxPlan,
  boxPrepare,
  holdBy,
  parseState,
  relate,
  restoreScript,
  saveScript,
  schemaProblems,
  startScript,
  storeLoadScript,
} from "./box.mjs";
import { boxFlows, loadFlows } from "./flows.mjs";
import { exitCode, validateResult } from "./result.mjs";
import { parseArgs, runVerb } from "./verify.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migrations = execFileSync("node", [join(root, "scripts/mend-migrations.mjs")], {
  encoding: "utf8",
})
  .trim()
  .split("\n");

// The generation the box runs before a check, and the one a check's deploy makes.
const OWNERS = "generations/gen-11111111-1111-4111-8111-111111111111";
const CHECKS = "generations/gen-22222222-2222-4222-8222-222222222222";

// What READ_STATE prints on a box running `revision`, with every migration this head has.
const boxSays = ({
  live = "0",
  hold = "",
  revision = "a".repeat(40),
  applied = migrations,
  free = 40 * 1024 ** 3,
  webapp,
  version = "0.37.0-next.1.preview.1",
  running = "true",
  active = OWNERS,
} = {}) =>
  [
    `version=${version}`,
    `revision=${revision}`,
    ...(webapp === undefined ? [] : [`webapp=${webapp}`]),
    "started=2026-11-14T20:00:00Z",
    `running=${running}`,
    `live=${live}`,
    `free=${free}`,
    `hold=${hold}`,
    `active=${active}`,
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
const fakeBox = (
  text,
  {
    listing = boxLists(),
    after = 40 * GB,
    restored = "restore=done\n",
    afterRestore = text,
    saved = { code: 0, stdout: "store=168417566 8\nsave=373315461\n" },
    stored = "extracted=/root/main-run/world.store.tgz\nmissing=\nstore=done\n",
    started = "putback=done\n",
    afterStart = afterRestore,
  } = {},
) => {
  const scripts = [];
  let restoredYet = false;
  let startedYet = false;
  const ssh = (script) => {
    scripts.push(script);
    if (script.includes("# save-data")) return { stderr: "", ...saved };
    if (script.includes("# store-load")) return { code: 0, stdout: stored, stderr: "" };
    if (script.includes("# put-back")) {
      startedYet = true;
      return { code: 0, stdout: started, stderr: "" };
    }
    if (script.includes("# restore-dump")) {
      restoredYet = true;
      return { code: 0, stdout: restored, stderr: "" };
    }
    if (startedYet && script.includes("mend_migrations"))
      return { code: 0, stdout: afterStart, stderr: "" };
    if (restoredYet && script.includes("mend_migrations"))
      return { code: 0, stdout: afterRestore, stderr: "" };
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

// Main carries every migration this head has unless a test says otherwise: no git fetch in tests.
const box = (subverb, extra) =>
  runVerb(root, "box", {
    base: "origin/main",
    subverb,
    pr: "1700",
    readMain: () => migrations,
    // Never this checkout's own new web app check: release would scan and remove it.
    front: { read: () => null, scan: () => 0, end: () => null },
    ...extra,
  });

test("the box's state is read with unknowns kept unknown", () => {
  const state = parseState(boxSays({ live: "" }));
  assert.equal(state.live, null, "a count that could not be read is not zero");
  assert.equal(state.revision, "a".repeat(40));
  assert.deepEqual(state.migrations, migrations);
  assert.equal(parseState("version=\nrevision=not-a-sha").revision, null);
});

test("a preview of today's app leaves the after-cut-over flows; a preview of the new app runs them", async () => {
  // Images from before the label, and every release, serve today's app.
  for (const webapp of [undefined, "", "web-old", "something-else"])
    assert.equal(parseState(boxSays({ webapp })).webApp, "web-old", String(webapp));
  assert.equal(parseState(boxSays({ webapp: "web" })).webApp, "web");

  const { flows } = loadFlows(root);
  const later = flows.filter((flow) => flow.afterCutOver);
  assert.ok(later.length > 0 && later.length < flows.length, "flows.md marks some flows, not all");
  assert.deepEqual(boxFlows(flows, "web-old"), {
    run: flows.filter((flow) => !flow.afterCutOver),
    afterCutOver: later,
  });
  assert.deepEqual(boxFlows(flows, "web"), { run: flows, afterCutOver: [] });

  const today = await box("plan", { sshRunner: fakeBox(boxSays()).ssh });
  const todayFlows = today.steps.find((step) => step.id === "flows");
  assert.equal(todayFlows.status, "passed");
  assert.equal(
    todayFlows.detail,
    `it serves apps/web-old: ${flows.length - later.length} flows run, and the ${later.length} marked after cut-over are reported as not run · after cut-over`,
  );
  const next = await box("plan", { sshRunner: fakeBox(boxSays({ webapp: "web" })).ssh });
  assert.equal(
    next.steps.find((step) => step.id === "flows").detail,
    `it serves apps/web (a preview built with web_app=web): all ${flows.length} flows run, the ${later.length} marked after cut-over included`,
  );
  // Nothing else in the plan depends on which app the box serves.
  const without = (result) => result.steps.filter((step) => step.id !== "flows");
  assert.deepEqual(without(next), without(today));
  assert.equal(next.status, today.status);
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
  assert.match(
    done.steps.find((step) => step.id === "tidy").detail,
    /free .* before, 40\.0 GiB after/,
  );
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
  assert.match(plan.steps.find((step) => step.id === "tidy").detail, /Would remove 2 images/);
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

const heldWithDump = JSON.stringify({
  tag: "pr1700",
  head: "b".repeat(40),
  at: "2026-11-14T21:00:00Z",
  dump: "/root/backups/pre-pr1700-20261114T210000Z.sql",
});
const fromPr = [...migrations, "9999_from_a_pr"];
const onMain = () => migrations;
const restores = (scripts) => scripts.filter((script) => script.includes("# restore-dump"));
const lifts = (scripts) =>
  scripts.filter((script) => script.includes("rm -f /var/lib/mend-box-check/hold.json"));

test("release puts back the data when the check left a migration main lacks", async () => {
  const dry = fakeBox(boxSays({ hold: heldWithDump, applied: fromPr }));
  const plan = await box("release", { sshRunner: dry.ssh, readMain: onMain });
  assert.equal(plan.steps[0].id, "restore");
  assert.equal(plan.steps[0].status, "skipped");
  assert.match(plan.steps[0].detail, /Would restore \/root\/backups\/pre-pr1700-.*9999_from_a_pr/);
  assert.deepEqual(restores(dry.scripts), [], "nothing restored without --yes");

  const real = fakeBox(boxSays({ hold: heldWithDump, applied: fromPr }), {
    afterRestore: boxSays({ hold: heldWithDump }),
  });
  const done = await box("release", { sshRunner: real.ssh, readMain: onMain, yes: true });
  assert.deepEqual(validateResult(done), []);
  assert.equal(done.status, "passed");
  assert.match(done.steps[0].detail, /9999_from_a_pr undone; Mend is stopped/);
  const [restore] = restores(real.scripts);
  assert.match(restore, /dump='\/root\/backups\/pre-pr1700-20261114T210000Z\.sql'/);
  assert.ok(
    real.scripts.indexOf(restore) < real.scripts.indexOf(tidies(real.scripts)[0]),
    "the data goes back before the tidy",
  );
  assert.equal(lifts(real.scripts).length, 1);
});

test("a restore that fails or leaves the migration keeps the hold", async () => {
  for (const options of [
    { restored: "restore=could not stop mend-mend-1\n" },
    { restored: 'error=ERROR:  relation "x" does not exist\nrestore=done\n' },
    { restored: "restore=done\n" },
  ]) {
    const real = fakeBox(boxSays({ hold: heldWithDump, applied: fromPr }), options);
    const done = await box("release", { sshRunner: real.ssh, readMain: onMain, yes: true });
    assert.equal(done.status, "failed", options.restored);
    assert.match(done.steps[0].detail, /the hold stays/);
    assert.deepEqual(lifts(real.scripts), [], "the hold is not lifted");
    assert.deepEqual(tidies(real.scripts), [], "nothing is tidied");
  }
});

test("release restores nothing when main has every migration, or with --no-restore", async () => {
  const plain = fakeBox(boxSays({ hold: heldWithDump }));
  const done = await box("release", { sshRunner: plain.ssh, readMain: onMain, yes: true });
  assert.equal(done.steps[0].status, "passed");
  assert.match(done.steps[0].detail, /no migration main lacks/);
  assert.deepEqual(restores(plain.scripts), []);

  const kept = fakeBox(boxSays({ hold: heldWithDump, applied: fromPr }));
  const left = await box("release", {
    sshRunner: kept.ssh,
    readMain: onMain,
    yes: true,
    noRestore: true,
  });
  assert.equal(left.steps[0].status, "skipped");
  assert.match(left.steps[0].detail, /--no-restore: the box applied 9999_from_a_pr/);
  assert.deepEqual(restores(kept.scripts), []);
  assert.equal(lifts(kept.scripts).length, 1);
});

test("release refuses to restore from a dump the hold does not name", async () => {
  const bare = fakeBox(boxSays({ hold: ours, applied: fromPr }));
  const done = await box("release", { sshRunner: bare.ssh, readMain: onMain, yes: true });
  assert.equal(done.status, "failed");
  assert.match(done.steps[0].detail, /names no dump/);
  assert.deepEqual(restores(bare.scripts), []);
  assert.deepEqual(lifts(bare.scripts), []);
});

test("--no-restore parses", () => {
  assert.equal(parseArgs(["box", "release", "--no-restore"]).options.noRestore, true);
});

const WORLD = "/root/main-run/world.sql";
// The daily run's box: the owner's build and data, and a hold of his that lapsed.
const lapsed = { tag: "owner-onboarding", head: "c".repeat(40), at: "2026-11-13T11:05:17Z" };
const ownersBox = (extra = {}) =>
  boxSays({ version: "0.37.0-next.1.preview.9", hold: JSON.stringify(lapsed), ...extra });
const holdOf = (scripts) =>
  JSON.parse(
    scripts
      .find((script) => script.includes("pg_dumpall") && script.includes("hold.json"))
      .match(/printf '%s' '(\{.*\})' > /)[1],
  );
const run = { pr: undefined, tag: "main-c374a10430f2" };

test("--load and --save take a .sql path under /root, and nothing else", () => {
  assert.equal(parseArgs(["box", "prepare", "--load", WORLD]).options.load, WORLD);
  assert.equal(parseArgs(["box", "release", "--save", WORLD]).options.save, WORLD);
  for (const path of ["/tmp/world.sql", "/root/world.txt", "/root/../etc/x.sql", "/root/a b.sql"])
    assert.throws(() => parseArgs(["box", "prepare", "--load", path]), /\.sql path under \/root/);
});

test("with --load, the box's own schema never holds the check up", async () => {
  const ahead = fakeBox(ownersBox({ applied: [...migrations, "9999_from_a_redesign_branch"] }));
  const plan = await box("plan", { sshRunner: ahead.ssh, ...run, load: WORLD });
  const schema = plan.steps.find((step) => step.id === "schema");
  assert.equal(schema.status, "passed");
  assert.match(schema.detail, /loads \/root\/main-run\/world\.sql and deploys over that/);
  assert.equal(plan.steps.find((step) => step.id === "free").status, "passed", "the hold lapsed");
});

test("prepare --load dumps, holds with what to put back, then loads the check's own data", async () => {
  const dry = fakeBox(ownersBox());
  const plan = await box("prepare", { sshRunner: dry.ssh, ...run, load: WORLD });
  assert.equal(plan.status, "skipped");
  assert.match(
    plan.steps.at(-1).detail,
    /then load \/root\/main-run\/world\.sql .* put back 0\.37\.0-next\.1\.preview\.9 \(generations\/gen-1{8}.*\) and the hold owner-onboarding/,
  );
  assert.deepEqual(plan.next, [
    "pnpm verify box prepare --yes --tag main-c374a10430f2 --load /root/main-run/world.sql",
  ]);
  assert.deepEqual(restores(dry.scripts), []);

  const real = fakeBox(ownersBox(), { afterRestore: boxSays({ active: OWNERS }) });
  const done = await box("prepare", { sshRunner: real.ssh, ...run, load: WORLD, yes: true });
  assert.deepEqual(validateResult(done), []);
  assert.equal(done.status, "passed");
  const hold = holdOf(real.scripts);
  assert.equal(hold.tag, "main-c374a10430f2");
  assert.deepEqual(hold.putBack, {
    active: OWNERS,
    version: "0.37.0-next.1.preview.9",
    hold: lapsed,
  });
  const dump = real.scripts.find((script) => script.includes("pg_dumpall"));
  assert.match(
    dump,
    /\[ -s '\/root\/main-run\/world\.sql' \]/,
    "the load is checked before anything",
  );
  const [load] = restores(real.scripts);
  assert.match(load, /dump='\/root\/main-run\/world\.sql'/);
  assert.ok(
    real.scripts.indexOf(dump) < real.scripts.indexOf(load),
    "its own data is dumped first",
  );
  const load_ = done.steps.find((step) => step.id === "load");
  assert.match(load_.detail, /all in this head; Mend is stopped until the deploy/);
  const store = done.steps.at(-1);
  assert.equal(store.id, "store");
  assert.match(store.detail, /extracted \/root\/main-run\/world\.store\.tgz; every repository/);
  const extract = real.scripts.find((script) => script.includes("# store-load"));
  assert.match(extract, /archive='\/root\/main-run\/world\.store\.tgz'/);
  assert.ok(real.scripts.indexOf(load) < real.scripts.indexOf(extract), "the store after the data");
});

test("prepare --load refuses a box with no generation to put back, and fails on data the head cannot take", async () => {
  const bare = fakeBox(ownersBox({ active: "" }));
  const refused = await box("prepare", { sshRunner: bare.ssh, ...run, load: WORLD, yes: true });
  assert.equal(refused.status, "failed");
  assert.match(refused.steps.at(-1).detail, /names no generation.*Nothing was changed/);
  assert.ok(!bare.scripts.some((script) => script.includes("pg_dumpall")));

  const odd = fakeBox(ownersBox(), {
    afterRestore: boxSays({ applied: [...migrations, "9999_only_in_that_dump"] }),
  });
  const failed = await box("prepare", { sshRunner: odd.ssh, ...run, load: WORLD, yes: true });
  assert.equal(failed.status, "failed");
  assert.match(failed.steps.at(-1).detail, /9999_only_in_that_dump.*the hold stays/);
  assert.deepEqual(failed.next, ["pnpm verify box release --yes --tag main-c374a10430f2"]);
});

const loadedHold = JSON.stringify({
  tag: "main-c374a10430f2",
  head: "b".repeat(40),
  at: "2026-11-14T21:00:00Z",
  dump: "/root/backups/pre-main-c374a10430f2-20261114T210000Z.sql",
  putBack: { active: OWNERS, version: "0.37.0-next.1.preview.9", hold: lapsed },
});
// The box at release: the check's preview runs on the check's data, in the check's generation.
const checksBox = () =>
  boxSays({ hold: loadedHold, version: "0.37.0-next.2.preview.10", active: CHECKS });
const putBack = boxSays({ version: "0.37.0-next.1.preview.9", active: OWNERS });

test("release after prepare --load saves the check's data, puts the box's own back and starts its build", async () => {
  const dry = fakeBox(checksBox());
  const plan = await box("release", { sshRunner: dry.ssh, ...run, save: WORLD });
  assert.equal(plan.status, "skipped");
  assert.deepEqual(
    plan.steps.map((step) => [step.id, step.status]),
    [
      ["save", "skipped"],
      ["put-back", "skipped"],
      ["tidy", "skipped"],
      ["release", "skipped"],
    ],
  );
  assert.match(plan.steps.at(-1).detail, /write back the hold owner-onboarding/);
  assert.equal(
    dry.scripts.filter((script) => /# (save-data|restore-dump|put-back)/.test(script)).length,
    0,
  );

  const real = fakeBox(checksBox(), { afterStart: putBack });
  const done = await box("release", { sshRunner: real.ssh, ...run, save: WORLD, yes: true });
  assert.deepEqual(validateResult(done), []);
  assert.equal(done.status, "passed");
  const order = ["# save-data", "# restore-dump", "# put-back", "exit 9", "hold.json"].map((mark) =>
    real.scripts.findLastIndex((script) => script.includes(mark)),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "save, restore, start, tidy, hold",
  );
  assert.match(
    real.scripts.find((script) => script.includes("# save-data")),
    /dest='\/root\/main-run\/world\.sql'/,
  );
  assert.match(
    restores(real.scripts)[0],
    /dump='\/root\/backups\/pre-main-c374a10430f2-20261114T210000Z\.sql'/,
  );
  const start = real.scripts.find((script) => script.includes("# put-back"));
  assert.match(start, /target='generations\/gen-1{8}-/);
  assert.match(start, /\/root\/box-main-c374a10430f2-cli\/node_modules\/\.bin\/mend/);
  assert.match(start, /server start --offline/);
  assert.match(done.steps[1].detail, /0\.37\.0-next\.1\.preview\.9 runs/);
  assert.equal(lifts(real.scripts).length, 0, "the hold it found is written back, not removed");
  assert.equal(
    real.scripts.at(-1),
    `printf '%s' '${JSON.stringify(lapsed)}' > /var/lib/mend-box-check/hold.json`,
  );
});

test("release after prepare --load keeps the hold while the box's own data or build is not back", async () => {
  for (const options of [
    { restored: "restore=could not stop mend-mend-1\n" },
    { started: "putback=mend server start exited 1\n" },
    { afterStart: boxSays({ version: "0.37.0-next.2.preview.10", active: OWNERS }) },
    {
      afterStart: boxSays({ version: "0.37.0-next.1.preview.9", active: OWNERS, running: "false" }),
    },
  ]) {
    const real = fakeBox(checksBox(), { afterStart: putBack, ...options });
    const done = await box("release", { sshRunner: real.ssh, ...run, yes: true });
    assert.equal(done.status, "failed", JSON.stringify(options));
    assert.match(done.steps.at(-1).detail, /the hold stays/);
    assert.ok(
      !real.scripts.some((script) => script.includes("hold.json") && !script.includes("cat ")),
    );
    assert.deepEqual(tidies(real.scripts), []);
  }

  const unsaved = fakeBox(checksBox(), {
    afterStart: putBack,
    saved: { code: 1, stdout: "save=pg_dumpall failed\n" },
  });
  const done = await box("release", { sshRunner: unsaved.ssh, ...run, save: WORLD, yes: true });
  assert.equal(done.status, "failed", "a save that failed is reported");
  assert.match(
    done.steps[0].detail,
    /pg_dumpall failed; \/root\/main-run\/world\.sql and \/root\/main-run\/world\.store\.tgz are left as they were/,
  );
  assert.equal(done.steps[1].status, "passed", "the box's own data and build go back anyway");
});

test("the scripts release sends the box are bash it can parse, whatever the path", () => {
  for (const script of [
    saveScript(WORLD),
    startScript(OWNERS, "/root/box-main-c374a10430f2-cli"),
    restoreScript(WORLD),
    storeLoadScript(WORLD),
  ])
    execFileSync("bash", ["-n"], { input: script });
  assert.match(saveScript("/root/it's.sql"), /dest='\/root\/it'\\''s\.sql'/);
});

test("prepare --load fails, keeping the hold, when the store lacks a repository the data names", async () => {
  const bare = fakeBox(ownersBox(), {
    afterRestore: boxSays({ active: OWNERS }),
    stored: "missing=3f1f00fe-0f6b-4d1c-939c-dc2ec8d466f5/repo.git\nstore=done\n",
  });
  const done = await box("prepare", { sshRunner: bare.ssh, ...run, load: WORLD, yes: true });
  assert.equal(done.status, "failed");
  const store = done.steps.at(-1);
  assert.match(
    store.detail,
    /lacks 1 repositories .*3f1f00fe.*\(no \/root\/main-run\/world\.store\.tgz\).*the hold stays/,
  );
  assert.deepEqual(done.next, ["pnpm verify box release --yes --tag main-c374a10430f2"]);
});

test("release --save refuses data a migration main lacks touched, and still puts the box's own back", async () => {
  const pr = fakeBox(
    boxSays({
      hold: loadedHold,
      version: "0.37.0-next.2.preview.10",
      active: CHECKS,
      applied: fromPr,
    }),
    { afterStart: putBack },
  );
  const done = await box("release", {
    sshRunner: pr.ssh,
    ...run,
    save: WORLD,
    yes: true,
    readMain: onMain,
  });
  assert.equal(done.status, "failed");
  const save = done.steps[0];
  assert.equal(save.id, "save");
  assert.match(save.detail, /carries 9999_from_a_pr, which origin\/main lacks/);
  assert.match(save.detail, /left as they were\. The agent logins .* may need the owner/);
  assert.equal(pr.scripts.filter((script) => script.includes("# save-data")).length, 0);
  assert.equal(done.steps[1].status, "passed", "the box's own data and build go back");
});

test("release refuses --no-restore after prepare --load, and --save without it", async () => {
  const kept = fakeBox(checksBox());
  const refused = await box("release", { sshRunner: kept.ssh, ...run, yes: true, noRestore: true });
  assert.equal(refused.status, "failed");
  assert.match(refused.steps[0].detail, /always puts the box's own data back/);
  assert.deepEqual(restores(kept.scripts), []);

  const plain = fakeBox(boxSays({ hold: heldWithDump }));
  const nothing = await box("release", {
    sshRunner: plain.ssh,
    readMain: onMain,
    yes: true,
    save: WORLD,
  });
  assert.equal(nothing.status, "failed");
  assert.match(nothing.steps[0].detail, /no loaded data to save/);
  assert.equal(plain.scripts.filter((script) => script.includes("# save-data")).length, 0);
});

// A checkout whose change is the new web app's alone, and the builds a box might run: the
// branch's base, main after it, and a server from another line that lacks the base.
const frontHistory = (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mend-verify-front-"));
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
  const write = (file, text) => {
    mkdirSync(join(cwd, dirname(file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  };
  const commit = (files) => {
    for (const [file, text] of Object.entries(files)) write(file, text);
    git("add", "-A");
    git("commit", "-qm", Object.keys(files).join(" "));
    return git("rev-parse", "HEAD");
  };
  git("init", "-qb", "main");
  const first = commit({
    "tooling/verify/obligations.json": readFileSync(
      join(root, "tooling/verify/obligations.json"),
      "utf8",
    ),
    "packages/db/src/migrations.ts": readFileSync(
      join(root, "packages/db/src/migrations.ts"),
      "utf8",
    ),
    "apps/api/src/server.ts": "export const v = 0;\n",
    "apps/web/src/route.tsx": "export const r = 0;\n",
  });
  const base = commit({ "apps/api/src/server.ts": "export const v = 1;\n" });
  git("checkout", "-qb", "route");
  const front = commit({
    "apps/web/src/route.tsx": "export const r = 1;\n",
    "packages/ui/src/kit.tsx": "export const k = 1;\n",
    ".agents/skills/verify/recipes/new-web-route.mjs": "export default async () => {};\n",
  });
  git("checkout", "-qb", "server");
  const server = commit({ "apps/api/src/server.ts": "export const v = 2;\n" });
  git("checkout", "-q", "main");
  const later = commit({ "apps/api/src/server.ts": "export const v = 3;\n" });
  git("checkout", "-qb", "elsewhere", first);
  const other = commit({ "apps/api/src/server.ts": "export const v = 4;\n" });
  git("checkout", "-q", "route");
  return {
    cwd,
    checkout: (branch) => git("checkout", "-q", branch),
    head: { sha: front, mergeBase: base, dirty: false },
    serverHead: { sha: server, mergeBase: base, dirty: false },
    base,
    later,
    other,
  };
};

// Named as `verify` names results, so the newest sorts last: the newest drive of a recipe counts.
let drives = 0;
const droveOnBox = (cwd, head, revision, status = "passed") => {
  mkdirSync(join(cwd, ".verify/results"), { recursive: true });
  drives += 1;
  writeFileSync(
    join(cwd, ".verify/results", `drive-new-web-20261118T${String(drives).padStart(6, "0")}Z.json`),
    JSON.stringify({
      verb: "drive new-web",
      status,
      head: { sha: head.sha, dirty: false },
      drive: {
        surface: "new-web",
        recipe: "new-web-route",
        out: join(cwd, "out"),
        box: { web: "https://box.example.test", revision, version: "0.37.0-next.1.preview.9" },
      },
    }),
  );
};

const identityOn = (cwd, head, revision) =>
  boxIdentity(cwd, { head, ssh: fakeBox(boxSays({ revision })).ssh });

test("a change that is the new web app's alone is found by its drive on the box, not by a deploy", (t) => {
  const { cwd, checkout, head, serverHead, base, later, other } = frontHistory(t);
  assert.deepEqual(
    { ...frontOnly(cwd, { head, revision: base }), product: undefined },
    { front: true, product: undefined, outside: [], server: "same" },
  );
  assert.equal(frontOnly(cwd, { head, revision: later }).server, "later");
  assert.equal(frontOnly(cwd, { head, revision: other }).server, "other");

  const undriven = identityOn(cwd, head, base);
  assert.equal(undriven.steps[0].status, "failed");
  assert.match(undriven.steps[0].detail, /no passing drive new-web --box of this clean head/);

  droveOnBox(cwd, head, later, "failed");
  assert.equal(identityOn(cwd, head, later).steps[0].status, "failed", "a failed drive is none");
  droveOnBox(cwd, head, base);
  const driven = identityOn(cwd, head, base);
  assert.equal(driven.steps[0].status, "passed");
  assert.equal(driven.identity.relation, "front");
  assert.match(driven.steps[0].detail, /served from this checkout by drive new-web --box/);
  assert.equal(
    identityOn(cwd, head, later).steps[0].status,
    "failed",
    "a drive in front of another build does not count",
  );
  droveOnBox(cwd, head, later);
  assert.equal(identityOn(cwd, head, later).steps[0].status, "passed");
  assert.equal(
    identityOn(cwd, head, base).steps[0].status,
    "failed",
    "the box now runs a build the newest drive did not meet",
  );

  droveOnBox(cwd, head, other);
  const elsewhere = identityOn(cwd, head, other);
  assert.equal(elsewhere.steps[0].status, "failed");
  assert.match(elsewhere.steps[0].detail, /differs from this branch's base/);

  // Like plan, it reads the change of the checkout it runs in.
  checkout("server");
  assert.deepEqual(frontOnly(cwd, { head: serverHead, revision: base }).outside, [
    "apps/api/src/server.ts",
  ]);
  droveOnBox(cwd, serverHead, base);
  const server = identityOn(cwd, serverHead, base);
  assert.equal(server.steps[0].status, "failed", "a server change needs a preview of its head");
  assert.equal(server.identity.relation, "none");
});

test("plan says a new web app check needs no deploy, and that a stopped Mend needs one first", (t) => {
  const { cwd, head, base } = frontHistory(t);
  const front = (running) =>
    boxPlan(cwd, {
      head,
      tag: "pr1700",
      ssh: fakeBox(`${boxSays({ revision: base })}\nrunning=${running}`).ssh,
    }).steps.find((step) => step.id === "front");
  assert.equal(front("true").status, "passed");
  assert.match(front("true").detail, /no preview deploy is needed/);
  assert.equal(front("false").status, "blocked_by_prerequisite");
  assert.match(front("false").detail, /Mend is stopped there/);
  const prepared = boxPrepare(cwd, {
    head,
    tag: "pr1700",
    yes: false,
    stamp: "x",
    ssh: fakeBox(`${boxSays({ revision: base })}\nrunning=false`).ssh,
  });
  assert.equal(
    prepared.steps.at(-1).id,
    "dump",
    "a stopped Mend never refuses the dump: the deploy comes after it",
  );
});

test("release scans the new web app check's evidence and removes its sign-in, only with --yes", async () => {
  const run = { private: "/p", evidence: "/e" };
  const seen = [];
  const front = {
    read: () => (seen.includes("end") ? null : run),
    scan: () => (seen.push("scan"), 0),
    end: () => seen.push("end"),
  };
  const dry = fakeBox(boxSays({ hold: ours }));
  const shown = await box("release", { sshRunner: dry.ssh, front });
  assert.match(
    shown.steps.find((step) => step.id === "front").detail,
    /Would scan \/e and remove \/p/,
  );
  assert.deepEqual(seen, []);
  const real = fakeBox(boxSays({ hold: ours }));
  const done = await box("release", { sshRunner: real.ssh, yes: true, front });
  assert.deepEqual(seen, ["scan", "end"]);
  assert.equal(done.steps.find((step) => step.id === "front").status, "passed");
});
