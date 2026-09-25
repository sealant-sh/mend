import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  assertDotfilesFacts,
  DOTFILES_SUBDIRECTORY,
  DOTFILES_WORKSPACE_IMAGE,
  dotfilesProbeFacts,
  dotfilesProbePaths,
  dotfilesProbeScript,
  dotfilesRepositoryFiles,
  dotfilesSnapshotFiles,
  expectedDotfilesFacts,
  sessionDotfilesEvidence,
} from "./packaged-dotfiles-acceptance.mjs";

const exec = promisify(execFile);
const marker = "dotfiles-test";

async function writeFiles(root, files) {
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, { mode: file.mode });
  }
}

/**
 * A home as a workspace would hold it after `apply`, laid out on this machine: `repository` is
 * what reached home from the repository (null = its clone failed), then the snapshot is copied
 * over it unless `snapshotFirst` applies it before the repository instead.
 */
async function appliedHome(t, { repository, snapshotFirst = false }) {
  const scratch = await mkdtemp(join(tmpdir(), "mend-dotfiles-probe-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const home = join(scratch, "home");
  await mkdir(home);
  const snapshot = () => writeFiles(home, dotfilesSnapshotFiles(marker));
  if (snapshotFirst) await snapshot();
  if (repository !== null) {
    const checkout = join(scratch, "checkout");
    await writeFiles(checkout, dotfilesRepositoryFiles(marker));
    await repository(checkout, home);
  }
  if (!snapshotFirst) await snapshot();
  return home;
}

/** sealantd's copy manager over the re-rooted archive, then the bootstrap with HOME set. */
async function copyWithBootstrap(checkout, home) {
  const tree = join(checkout, DOTFILES_SUBDIRECTORY);
  await cp(tree, home, { recursive: true });
  await exec("/bin/sh", ["-c", "./install.sh"], { cwd: tree, env: { ...process.env, HOME: home } });
}

async function probe(home) {
  const { stdout } = await exec(
    "/bin/sh",
    ["-c", dotfilesProbeScript(dotfilesProbePaths(marker), home)],
    {
      env: { ...process.env, HOME: home },
    },
  );
  // A PTY record carries CRLF; the parser must not care.
  return dotfilesProbeFacts(stdout.replaceAll("\n", "\r\n"));
}

/** The facts a home can show on this machine: everything but uid, login shell and zsh. */
function homeFacts(expected) {
  return new Map([...expected].filter(([key]) => !["uid", "shell", "zshrc"].includes(key)));
}

test("the repository is the alpha shape: dot entries beside package directories under dots/", () => {
  const files = dotfilesRepositoryFiles(marker);
  const topLevel = new Set(
    files.flatMap((file) => (file.home === null ? [] : [file.home.split("/")[0]])),
  );
  for (const entry of [
    ".config",
    ".gitconfig",
    ".tmux.conf",
    ".zshenv",
    "bin",
    "legacy",
    "Library",
    "Brewfile",
  ])
    assert.ok(topLevel.has(entry), `${entry} must be at the top of the home tree`);
  assert.ok(files.every((file) => file.home === null || file.path === `dots/${file.home}`));
  assert.deepEqual(
    files.filter((file) => file.home === null).map((file) => file.path),
    ["README.md"],
  );
  assert.ok(
    dotfilesSnapshotFiles(marker).some((file) => files.some((repo) => repo.home === file.path)),
    "The snapshot must share a path with the repository, so the override is observable",
  );
  assert.deepEqual(DOTFILES_WORKSPACE_IMAGE, {
    mode: "family",
    os: "ubuntu",
    packages: [],
    shell: "zsh",
    services: { docker: false },
  });
});

test("a home with both archives applied in order matches the expected facts", async (t) => {
  const home = await appliedHome(t, { repository: copyWithBootstrap });
  const facts = await probe(home);
  const expected = expectedDotfilesFacts(marker, { repository: true, home });
  assertDotfilesFacts(facts, homeFacts(expected), "test");
  assert.equal(facts.get("exec:bin/mend-proof"), "yes");
  assert.notEqual(facts.get("file:.zshrc"), "absent");
});

test("the synced .zshrc is what an interactive zsh of that home loads", async (t) => {
  try {
    await exec("zsh", ["-c", "true"]);
  } catch {
    t.skip("zsh is not installed here");
    return;
  }
  const home = await appliedHome(t, { repository: copyWithBootstrap });
  const facts = await probe(home);
  assert.equal(facts.get("zshrc"), marker);
  assert.deepEqual(
    (await readdir(home)).filter((name) => name.startsWith(".mend-dotfiles-zshrc")),
    [],
    "The probe must leave no file of its own in home",
  );
});

test("a home with only the snapshot matches the degraded facts, and not the full ones", async (t) => {
  const home = await appliedHome(t, { repository: null });
  const facts = await probe(home);
  assertDotfilesFacts(
    facts,
    homeFacts(expectedDotfilesFacts(marker, { repository: false, home })),
    "test",
  );
  assert.throws(
    () =>
      assertDotfilesFacts(
        facts,
        homeFacts(expectedDotfilesFacts(marker, { repository: true, home })),
        "test",
      ),
    /reported file:\.zshenv differently; expected the fixture.s contents/,
  );
});

test("the facts catch the ways a dotfiles apply went wrong", async (t) => {
  const cases = {
    // sealantd 0.18.1 auto on alpha: package directories stowed, every dot entry dropped.
    "stow drops the dot entries": [
      async (checkout, home) => {
        for (const entry of ["bin", "legacy", "Library"])
          await cp(join(checkout, DOTFILES_SUBDIRECTORY, entry), join(home, entry), {
            recursive: true,
          });
      },
      /reported file:\.zshenv differently/,
    ],
    "the archive is not re-rooted at the subdirectory": [
      (checkout, home) => cp(checkout, home, { recursive: true }),
      /reported file:(README\.md|\.zshenv) differently/,
    ],
    "the bootstrap did not run": [
      (checkout, home) => cp(join(checkout, DOTFILES_SUBDIRECTORY), home, { recursive: true }),
      /reported file:\.mend-bootstrap-proof differently/,
    ],
  };
  for (const [name, [repository, failure]] of Object.entries(cases))
    await t.test(name, async (subtest) => {
      const home = await appliedHome(subtest, { repository });
      const facts = await probe(home);
      assert.throws(
        () =>
          assertDotfilesFacts(
            facts,
            homeFacts(expectedDotfilesFacts(marker, { repository: true, home })),
            "test",
          ),
        failure,
      );
    });
  await t.test("the repository applied after the snapshot", async (subtest) => {
    const home = await appliedHome(subtest, { repository: copyWithBootstrap, snapshotFirst: true });
    const facts = await probe(home);
    assert.throws(
      () =>
        assertDotfilesFacts(
          facts,
          homeFacts(expectedDotfilesFacts(marker, { repository: true, home })),
          "test",
        ),
      /reported file:\.zshrc differently/,
    );
  });
});

test("probe facts come from prefixed lines only, and a record without done is refused", () => {
  const facts = dotfilesProbeFacts(
    [
      "noise mend-dotfiles-proof uid 7",
      "mend-dotfiles-proof uid 0\r",
      "mend-dotfiles-proof uid 0",
      "mend-dotfiles-proof shell /usr/bin/zsh",
      "mend-dotfiles-proof done 1",
    ].join("\n"),
  );
  assert.equal(facts.get("uid"), "0");
  assert.equal(facts.get("shell"), "/usr/bin/zsh");
  assert.throws(() => dotfilesProbeFacts("mend-dotfiles-proof uid 0\n"), /did not finish/);
  assert.throws(
    () =>
      dotfilesProbeFacts(
        "mend-dotfiles-proof uid 0\nmend-dotfiles-proof uid 1\nmend-dotfiles-proof done 1\n",
      ),
    /uid twice/,
  );
  assert.throws(
    () => assertDotfilesFacts(new Map([["uid", "0"]]), new Map([["shell", "/usr/bin/zsh"]]), "x"),
    /x: the workspace reported shell not at all; expected \/usr\/bin\/zsh/,
  );
});

test("the probe refuses paths a shell would interpret", () => {
  for (const path of ["a b", "$(id)", "a;b", "`x`"])
    assert.throws(() => dotfilesProbeScript([path]), /plain paths/);
  assert.throws(() => dotfilesProbeScript([".zshrc"], "/root; rm"), /plain paths/);
});

const session = (dotfiles) => ({ dotfiles });

test("session dotfiles evidence needs the tried repository, the applied snapshot and what was left out", () => {
  const url = "http://fixture:9080/dots.git";
  const sha = "a".repeat(40);
  const full = { repository: { url, ref: "dotfiles-proof" }, snapshotSha: sha, notApplied: [] };
  const expected = { url, ref: "dotfiles-proof", snapshotSha: sha, notApplied: [] };
  assert.equal(sessionDotfilesEvidence(session(full), expected), full);
  const degraded = {
    ...full,
    notApplied: [{ source: "repository", reason: "dotfiles clone of … failed" }],
  };
  assert.equal(
    sessionDotfilesEvidence(session(degraded), { ...expected, notApplied: ["repository"] }),
    degraded,
  );
  const refusals = {
    "no dotfiles recorded": [session(null), expected],
    "another ref": [session({ ...full, repository: { url, ref: null } }), expected],
    "another snapshot": [session({ ...full, snapshotSha: "b".repeat(40) }), expected],
    "a source left out where none was expected": [session(degraded), expected],
    "nothing left out where the repository was expected": [
      session(full),
      { ...expected, notApplied: ["repository"] },
    ],
    "the snapshot left out instead": [
      session({ ...full, notApplied: [{ source: "snapshot", reason: "x" }] }),
      { ...expected, notApplied: ["repository"] },
    ],
    "no reason": [
      session({ ...full, notApplied: [{ source: "repository", reason: "" }] }),
      { ...expected, notApplied: ["repository"] },
    ],
  };
  for (const [name, [input, wanted]] of Object.entries(refusals))
    assert.throws(() => sessionDotfilesEvidence(input, wanted), undefined, name);
});
