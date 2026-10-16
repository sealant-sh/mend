import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { isDryRunVersion } from "./check-release-pins.mjs";
import { githubApi, npmDistTags, registryStandIn, writesIn } from "./fixtures/release-markers.mjs";

const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release-cli.yml", import.meta.url),
  "utf8",
);

// Inspect the checked-in job boundaries, not a second model of the release workflow.
function job(name) {
  const start = releaseWorkflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `Missing release job ${name}`);
  const remaining = releaseWorkflow.slice(start + 1);
  const next = remaining.slice(1).search(/^  [\w-]+:\s*$/m);
  return next < 0 ? remaining : remaining.slice(0, next + 1);
}

function dependencies(name) {
  const match = job(name).match(/^    needs: (.+)$/m);
  assert.ok(match, `${name} must declare its publication dependencies`);
  return match[1]
    .replaceAll("[", "")
    .replaceAll("]", "")
    .split(",")
    .map((value) => value.trim());
}

function shellStep(file, jobName, name) {
  const document = parse(readFileSync(new URL(file, import.meta.url), "utf8"));
  const step = document.jobs[jobName].steps.find((entry) => entry.name === name);
  assert.equal(typeof step?.run, "string", `Missing shell step ${name}`);
  return step.run;
}

// These commands only read/write the owned fixture. Unsupported operations fail without a real
// publication interface. JSON records preserve individual argv elements.
const recordingCommand = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(process.env.FIXTURE_STATE, "utf8"));
const save = () => writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
const refuse = () => { console.error("Unknown owned fixture argv", args); process.exit(79); };
if (process.env.FIXTURE_COMMAND === "gh" && args[0] === "release") {
  if (args[1] === "view") {
    if (!state.releaseExists) process.exit(1);
    if (args.length > 3) console.log(Object.keys(state.assets).join("\\n"));
    process.exit(0);
  }
  if (args[1] === "upload" && args.length === 4) {
    const name = args[3].split("/").at(-1);
    if (state.failAsset === name) process.exit(73);
    if (state.assets[name] !== undefined) process.exit(79);
    state.assets[name] = readFileSync(args[3], "utf8"); save(); process.exit(0);
  }
  if (args[1] === "create" && !state.releaseExists) {
    for (const source of state.sources) {
      if (args.includes(source)) state.assets[source.split("/").at(-1)] = readFileSync(source, "utf8");
    }
    state.releaseExists = true; save(); process.exit(0);
  }
} else if (process.env.FIXTURE_COMMAND === "docker" &&
           args[0] === "buildx" && args[1] === "imagetools") {
  if (args[2] === "inspect" && args.length === 4) {
    if (state.created && state.failInspect) process.exit(74);
    process.exit(state.imageExists ? 0 : 1);
  }
  if (args[2] === "create" && args[3] === "--metadata-file" && args[5] === "--tag") {
    if (state.failCreate) process.exit(73);
    state.imageExists = true; state.created = true; state.sources = args.slice(7);
    // What buildx writes: the pushed index's descriptor.
    writeFileSync(args[4], JSON.stringify({ "containerimage.descriptor": { digest: "sha256:" + "d".repeat(64) } }));
    save(); process.exit(0);
  }
}
refuse();
`;

function withPublicationFixture(command, initial, files, check) {
  const directory = mkdtempSync(path.join(tmpdir(), "mend-publication-"));
  try {
    for (const subdirectory of ["bin", "home", "tmp", "work"]) {
      mkdirSync(path.join(directory, subdirectory));
    }
    const binary = path.join(directory, "bin", command);
    writeFileSync(binary, recordingCommand);
    chmodSync(binary, 0o755);
    const stateFile = path.join(directory, "state.json");
    const callsFile = path.join(directory, "calls.jsonl");
    writeFileSync(stateFile, JSON.stringify(initial));
    writeFileSync(callsFile, "");
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(directory, "work", name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }
    const run = (script, environment) => {
      // Keep GitHub's bash -e behavior and disable local shell startup files. The image step
      // adds its own pipefail; fixture HOME and environment carry no publication credentials.
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
        cwd: path.join(directory, "work"),
        env: {
          PATH: `${path.join(directory, "bin")}:/usr/bin:/bin`,
          HOME: path.join(directory, "home"),
          TMPDIR: path.join(directory, "tmp"),
          FIXTURE_COMMAND: command,
          FIXTURE_STATE: stateFile,
          FIXTURE_CALLS: callsFile,
          RUNNER_TEMP: path.join(directory, "tmp"),
          ...environment,
        },
        encoding: "utf8",
        timeout: 5000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      const calls = readFileSync(callsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return { ...result, calls, state: JSON.parse(readFileSync(stateFile, "utf8")) };
    };
    check(run);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(existsSync(directory), false);
}

const setupSources = [
  "deploy/docker/compose.v2.yaml",
  "deploy/docker/postgres-init.sh",
  "deploy/docker/setup-contract.v2.json",
  "install.sh",
];
const setupFiles = {
  "deploy/docker/compose.v2.yaml": "new compose bytes\n",
  "deploy/docker/postgres-init.sh": "new postgres bytes\n",
  "deploy/docker/setup-contract.v2.json": "new setup contract bytes\n",
  "install.sh": "new install bytes\n",
  "release-notes.md": "owned release notes\n",
};

test("the actual release shell retries only missing assets and preserves published bytes", () => {
  const script = shellStep(
    "../.github/workflows/release-cli.yml",
    "github-release",
    "Create the release",
  );
  const published = {
    "compose.v2.yaml": "already published compose\n",
    "setup-contract.v2.json": "already published contract\n",
  };
  withPublicationFixture("gh", { releaseExists: true, assets: published }, setupFiles, (run) => {
    const first = run(script, { GITHUB_REF_NAME: "v1.2.3" });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.calls, [
      ["release", "view", "v1.2.3"],
      ["release", "view", "v1.2.3", "--json", "assets", "--jq", ".assets[].name"],
      ["release", "upload", "v1.2.3", "deploy/docker/postgres-init.sh"],
      ["release", "upload", "v1.2.3", "install.sh"],
    ]);
    assert.deepEqual(first.state.assets, {
      ...published,
      "postgres-init.sh": "new postgres bytes\n",
      "install.sh": "new install bytes\n",
    });
    const retry = run(script, { GITHUB_REF_NAME: "v1.2.3" });
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(retry.calls.slice(first.calls.length), [
      ["release", "view", "v1.2.3"],
      ["release", "view", "v1.2.3", "--json", "assets", "--jq", ".assets[].name"],
    ]);
    assert.deepEqual(retry.state.assets, first.state.assets);
  });
});

test("the actual release shell creates stable and prerelease assets with exact publication flags", () => {
  const script = shellStep(
    "../.github/workflows/release-cli.yml",
    "github-release",
    "Create the release",
  );
  for (const [tag, version, flags] of [
    ["v1.2.3", "1.2.3", []],
    ["cli-v1.2.4-next.1", "1.2.4-next.1", ["--prerelease"]],
  ]) {
    withPublicationFixture(
      "gh",
      { releaseExists: false, assets: {}, sources: setupSources },
      setupFiles,
      (run) => {
        const result = run(script, { GITHUB_REF_NAME: tag });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.calls, [
          ["release", "view", tag],
          [
            "release",
            "create",
            tag,
            ...flags,
            ...setupSources,
            "--title",
            `Mend ${version}`,
            "--notes-file",
            "release-notes.md",
            "--latest=false",
            "--verify-tag",
          ],
        ]);
        assert.deepEqual(result.state.assets, {
          "compose.v2.yaml": "new compose bytes\n",
          "postgres-init.sh": "new postgres bytes\n",
          "setup-contract.v2.json": "new setup contract bytes\n",
          "install.sh": "new install bytes\n",
        });
      },
    );
  }
});

test("the actual release shell propagates an upload refusal without uploading later assets", () => {
  const script = shellStep(
    "../.github/workflows/release-cli.yml",
    "github-release",
    "Create the release",
  );
  const assets = { "compose.v2.yaml": "published compose\n" };
  withPublicationFixture(
    "gh",
    { releaseExists: true, assets, failAsset: "postgres-init.sh" },
    setupFiles,
    (run) => {
      const result = run(script, { GITHUB_REF_NAME: "v1.2.3" });
      assert.equal(result.status, 73);
      assert.deepEqual(result.calls, [
        ["release", "view", "v1.2.3"],
        ["release", "view", "v1.2.3", "--json", "assets", "--jq", ".assets[].name"],
        ["release", "upload", "v1.2.3", "deploy/docker/postgres-init.sh"],
      ]);
      assert.deepEqual(result.state.assets, assets);
    },
  );
});

/** The calls, with the metadata file create was given (under $RUNNER_TEMP/index) named generically. */
const metadataNamed = (calls) =>
  calls.map((args) =>
    args.map((arg, at) => {
      if (args[at - 1] !== "--metadata-file") return arg;
      assert.match(arg, /\/tmp\/index\/create\.json$/);
      return "<metadata>";
    }),
  );

const mergeScript = () =>
  shellStep(
    "../.github/workflows/image.yml",
    "merge",
    "Create and inspect the multi-arch candidate",
  );
const RUN = { GITHUB_RUN_ID: "38923041738", GITHUB_RUN_ATTEMPT: "2" };
const createCall = (target, sources) => [
  "buildx",
  "imagetools",
  "create",
  "--metadata-file",
  "<metadata>",
  "--tag",
  target,
  ...sources,
];

test("the actual image merge shell stages a real version under its run's tag, never :<version>", () => {
  const digests = ["a".repeat(64), "b".repeat(64)];
  const sources = digests.map((digest) => `ghcr.invalid/fixture/mend@sha256:${digest}`);
  const staging = "ghcr.invalid/fixture/mend:staging-38923041738-2";
  for (const [version, exists] of [
    ["1.2.3", true],
    ["1.2.4-next.1", false],
    ["0.0.0-dryrun.1.1", false],
  ]) {
    withPublicationFixture(
      "docker",
      { imageExists: exists },
      { [digests[0]]: "", [digests[1]]: "" },
      (run) => {
        const result = run(mergeScript(), {
          REPOSITORY: "ghcr.invalid/fixture/mend",
          VERSION: version,
          ...RUN,
        });
        assert.equal(result.status, 0, result.stderr);
        // Whether :<version> exists is finalize-images' question; merge never asks or writes it.
        assert.deepEqual(metadataNamed(result.calls), [
          createCall(staging, sources),
          ["buildx", "imagetools", "inspect", staging],
        ]);
        assert.ok(
          result.calls.flat().every((arg) => !arg.endsWith(`:${version}`)),
          version,
        );
      },
    );
  }
});

test("the actual image merge shell keeps a dev or acceptance build's own mutable tag", () => {
  const digests = ["a".repeat(64), "b".repeat(64)];
  for (const version of ["0.0.0-dev.sha0123456789ab", "0.0.0-acceptance.601.1"]) {
    withPublicationFixture(
      "docker",
      { imageExists: true },
      { [digests[0]]: "", [digests[1]]: "" },
      (run) => {
        const result = run(mergeScript(), {
          REPOSITORY: "ghcr.invalid/fixture/mend",
          VERSION: version,
          ...RUN,
        });
        assert.equal(result.status, 0, result.stderr);
        const target = `ghcr.invalid/fixture/mend:${version}`;
        const sources = digests.map((digest) => `ghcr.invalid/fixture/mend@sha256:${digest}`);
        assert.deepEqual(metadataNamed(result.calls), [
          createCall(target, sources),
          ["buildx", "imagetools", "inspect", target],
        ]);
        assert.deepEqual(result.state.sources, sources);
      },
    );
  }
});

test("the actual image merge shell propagates create and final-inspection failures", () => {
  const staging = "ghcr.invalid/fixture/mend:staging-38923041738-2";
  for (const [failure, status] of [
    ["failCreate", 73],
    ["failInspect", 74],
  ]) {
    withPublicationFixture(
      "docker",
      { imageExists: false, [failure]: true },
      { ["a".repeat(64)]: "" },
      (run) => {
        const result = run(mergeScript(), {
          REPOSITORY: "ghcr.invalid/fixture/mend",
          VERSION: "1.2.3",
          ...RUN,
        });
        assert.equal(result.status, status);
        assert.deepEqual(metadataNamed(result.calls), [
          createCall(staging, [`ghcr.invalid/fixture/mend@sha256:${"a".repeat(64)}`]),
          ...(failure === "failInspect" ? [["buildx", "imagetools", "inspect", staging]] : []),
        ]);
      },
    );
  }
});

test("npm waits for verified images, this run's passed acceptance and public setup assets", () => {
  assert.ok(dependencies("npm").includes("images"));
  assert.ok(dependencies("npm").includes("acceptance"));
  assert.ok(dependencies("npm").includes("github-release"));
  assert.ok(dependencies("github-release").includes("images"));
  assert.ok(dependencies("github-release").includes("acceptance"));
  assert.ok(!dependencies("github-release").includes("npm"));
  assert.ok(dependencies("acceptance").includes("images"));
});

test("asset verification uses anonymous exact-version downloads and byte comparison", () => {
  const release = job("github-release");
  const verification = release.slice(release.indexOf("- name: Verify anonymous setup downloads"));
  assert.match(verification, /set -euo pipefail/);
  assert.match(verification, /curl -q --fail --location/);
  assert.match(verification, /releases\/download\/\$GITHUB_REF_NAME\/\$asset/);
  assert.match(verification, /cmp "\$source" "\$downloads\/\$asset"/);
  assert.doesNotMatch(verification, /GH_TOKEN|Authorization/);
  for (const asset of [
    "compose.v2.yaml",
    "postgres-init.sh",
    "setup-contract.v2.json",
    "install.sh",
  ]) {
    assert.ok(verification.includes(asset), `Verify required asset ${asset}`);
  }
});

test("release retries preserve already published assets", () => {
  const release = job("github-release");
  assert.match(release, /gh release view/);
  assert.match(release, /gh release upload/);
  assert.match(release, /--latest=false/);
  assert.doesNotMatch(release, /--clobber|gh release delete|--draft/);
});

test("stable latest promotion waits for npm and the GitHub release", () => {
  assert.ok(dependencies("promote-images").includes("npm"));
  assert.ok(dependencies("promote-images").includes("github-release"));
  const promotion = job("promote-images");
  const prereleaseGuard = promotion.indexOf('if [[ "$version" == *-* ]]; then exit 0; fi');
  assert.ok(prereleaseGuard >= 0);
  assert.ok(promotion.indexOf("docker buildx imagetools create") > prereleaseGuard);
  assert.ok(promotion.indexOf("gh release edit") > prereleaseGuard);
});

test("nothing builds or publishes before the pins are checked", () => {
  const pins = job("pins");
  assert.match(pins, /fetch-depth: 0/);
  assert.match(pins, /node scripts\/check-release-pins\.mjs "\$\{flags\[@\]\}" "v\$VERSION"/);
  assert.match(pins, /VERSION: \$\{\{ needs\.release\.outputs\.version \}\}/);
  // The only build is image.yml's, the CLI tarball included (its cli job): it needs the gate.
  assert.ok(dependencies("images").includes("pins"), "images must wait for checked pins");
  assert.equal(releaseJobs["npm-pack"], undefined);
  // npm, the GitHub release and the latest promotion all wait on images, so on the pins too.
  assert.ok(dependencies("github-release").includes("images"));
});

test("a next build is a GitHub prerelease on npm's next dist-tag, and never moves latest", () => {
  assert.match(job("npm"), /if \[\[ "\$version" == \*-\* \]\]; then channel=next; fi/);
  assert.match(
    job("github-release"),
    /if \[\[ "\$VERSION" == \*-\* \]\]; then flags\+=\(--prerelease\); fi/,
  );
  assert.match(job("github-release"), /A \\`next\\` build of Mend from main/);
});

test("image.yml pushes a version once, and only its own dispatch is held to main", async (t) => {
  const image = readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8");
  // A version is pushed once: release-cli.yml's finalize-images refuses one that exists at another
  // digest; image.yml only stages.
  assert.doesNotMatch(image, /a version is pushed once/);
  assert.match(job("finalize-images"), /Version \$VERSION is spent: cut a new one\./);

  // Run the commit step as written, with a stand-in `gh` that knows one tag.
  const step = image.slice(image.indexOf("- name: Choose the commit to build"));
  const script = step
    .slice(step.indexOf("run: |") + "run: |".length, step.indexOf("- name: Resolve one version"))
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const bin = mkdtempSync(`${tmpdir()}/image-dispatch-`);
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const tagCommit = "a".repeat(40);
  const tagObject = "b".repeat(40);
  // A stand-in `gh`: v0.36.0-next.60 is a lightweight tag, v0.36.0-next.61 an annotated one.
  writeFileSync(
    `${bin}/gh`,
    [
      "#!/bin/sh",
      'case "$2" in',
      `  */git/ref/tags/v0.36.0-next.60) echo "commit ${tagCommit}"; exit 0 ;;`,
      `  */git/ref/tags/v0.36.0-next.61) echo "tag ${tagObject}"; exit 0 ;;`,
      `  */git/tags/${tagObject}) echo ${tagCommit}; exit 0 ;;`,
      "esac",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(`${bin}/gh`, 0o755);
  const run = (event, workflow, ref, version = "") => {
    const output = `${bin}/output-${Math.random()}`;
    writeFileSync(output, "");
    const status = spawnSync("bash", ["-c", script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: event,
        GITHUB_REPOSITORY: "sealant-sh/Mend",
        GITHUB_WORKFLOW_REF: `sealant-sh/Mend/.github/workflows/${workflow}@${ref}`,
        GITHUB_REF: ref,
        GITHUB_SHA: "f".repeat(40),
        GITHUB_OUTPUT: output,
        OVERRIDE_VERSION: version,
      },
    }).status;
    return { status, commit: /commit=(\w+)/.exec(readFileSync(output, "utf8"))?.[1] };
  };
  // The Version PR's pre-tag acceptance: release-acceptance.yml dispatched on its branch, calling image.yml.
  assert.deepEqual(
    run("workflow_dispatch", "release-acceptance.yml", "refs/heads/changeset-release/main"),
    {
      status: 0,
      commit: "f".repeat(40),
    },
  );
  // A release tag's own run builds its commit.
  assert.deepEqual(run("push", "release-cli.yml", "refs/tags/v0.36.0-next.60"), {
    status: 0,
    commit: "f".repeat(40),
  });
  assert.equal(run("workflow_dispatch", "image.yml", "refs/heads/feature").status, 1);
  assert.deepEqual(run("workflow_dispatch", "image.yml", "refs/heads/main"), {
    status: 0,
    commit: "f".repeat(40),
  });
  assert.equal(
    run("workflow_dispatch", "image.yml", "refs/heads/main", "0.0.0-dev.sha0123456789ab").status,
    0,
  );
  // A dispatched tagged version builds the tag's commit, not main's head.
  assert.deepEqual(run("workflow_dispatch", "image.yml", "refs/heads/main", "0.36.0-next.60"), {
    status: 0,
    commit: tagCommit,
  });
  assert.equal(run("workflow_dispatch", "image.yml", "refs/heads/main", "0.36.0").status, 1);
  // Only a tag resolves: the lookup names refs/tags/, so a branch called v<version> never does.
  assert.deepEqual(run("workflow_dispatch", "image.yml", "refs/heads/main", "0.36.0-next.61"), {
    status: 0,
    commit: tagCommit,
  });
  assert.match(image, /git\/ref\/tags\/v\$OVERRIDE_VERSION/);
  assert.match(image, /ref: \$\{\{ needs\.version\.outputs\.commit \}\}/);
});

test("npm publishes this run's accepted tarball as it is, with no repository code", () => {
  const npm = job("npm");
  // The credential job checks out nothing and installs nothing; image.yml's cli job, which holds no
  // token, packed the tarball.
  assert.doesNotMatch(npm, /actions\/checkout/);
  assert.match(npm, /id-token: write/);
  const downloads = releaseJobs.npm.steps.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.deepEqual(
    downloads.map((step) => step.with),
    [
      { name: "mend-cli", path: "cli" },
      { name: "release-manifest", path: "release" },
    ],
  );
  // The republish block (run against a stub registry by republish.test.mjs) does the publishing:
  // the manifest's sha512, the already-normalized check, the file itself, then the integrity.
  assert.match(npm, /# --- republish ---/);
  assert.match(
    npm,
    /publish_release "\$\{flags\[@\]\}" "\$GITHUB_WORKSPACE\/cli" "\$GITHUB_WORKSPACE\/release" \\\n\s+"@sealant\/mend" "\$version" "\$GITHUB_SHA" "\$channel" --provenance/,
  );
  assert.match(
    npm,
    /npm publish "\$tarball" --tag "\$channel" --access public --ignore-scripts "\$@"/,
  );
  assert.match(npm, /npm view "\$1@\$2" dist\.integrity/);
  assert.match(npm, /::error::INCIDENT/);
  // Nothing repacks: no npm pack, no rewritten package.json.
  assert.doesNotMatch(npm, /npm pack|writeFileSync|rebuild_tarball|publish_rebuilt/);
  // npm's own pacote, nothing installed: no unpinned code loads beside the credential.
  assert.doesNotMatch(npm, /npm install|pacote@/);
});

// --- the dry run ---

const releaseDocument = parse(releaseWorkflow);
const releaseJobs = releaseDocument.jobs;
const imageDocument = parse(
  readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8"),
);
const resolveStep = releaseJobs.release.steps.find((step) => step.id === "resolve");

/**
 * A repository scripts/next-version.mjs allocates in, as the dispatched commit's checkout: apps/cli
 * released as 0.35.1 (its tag), then one commit with a minor changeset, so main's next is
 * 0.36.0-next.2. `broken` leaves apps/cli/package.json out, so the allocator fails.
 */
const allocatorRepository = (broken = false) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-allocator-"));
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (...args) => spawnSync("git", args, { cwd: directory, env: environment });
  git("init", "-q", "-b", "main");
  for (const dir of ["apps/cli", ".changeset", "scripts"])
    mkdirSync(path.join(directory, dir), { recursive: true });
  writeFileSync(
    path.join(directory, "scripts/next-version.mjs"),
    readFileSync(new URL("./next-version.mjs", import.meta.url)),
  );
  writeFileSync(path.join(directory, ".changeset/config.json"), "{}");
  if (!broken)
    writeFileSync(
      path.join(directory, "apps/cli/package.json"),
      '{"name":"@sealant/mend","version":"0.35.1"}',
    );
  writeFileSync(path.join(directory, "README.md"), "fixture");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("tag", "v0.35.1");
  writeFileSync(
    path.join(directory, ".changeset/change.md"),
    '---\n"@sealant/mend": minor\n---\n\nA change.\n',
  );
  git("add", "-A");
  git("commit", "-qm", "change");
  return directory;
};
const allocator = allocatorRepository();
const brokenAllocator = allocatorRepository(true);
process.on("exit", () => {
  for (const directory of [allocator, brokenAllocator])
    rmSync(directory, { recursive: true, force: true });
});

const resolve = (environment, cwd = allocator) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-resolve-"));
  const output = path.join(directory, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", resolveStep.run], {
    cwd,
    encoding: "utf8",
    env: {
      // node and git for scripts/next-version.mjs; nothing else of this machine's.
      PATH: `${path.dirname(process.execPath)}:${path.dirname(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim())}:/usr/bin:/bin`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GITHUB_RUN_ID: "38700000001",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_OUTPUT: output,
      ...environment,
    },
  });
  const values = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")),
  );
  rmSync(directory, { recursive: true, force: true });
  return { status: result.status, stderr: result.stdout + result.stderr, ...values };
};

test("a dispatch is a dry run or nothing, and its version is always derived from the run", () => {
  assert.deepEqual(releaseDocument.on.workflow_dispatch.inputs, {
    dry_run: {
      description: "Build, accept and check a release without publishing anything",
      required: true,
      type: "boolean",
    },
  });
  assert.equal(resolveStep.env.DRY_RUN, "${{ inputs.dry_run }}");
  const dispatch = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature" };
  const dry = resolve({ ...dispatch, DRY_RUN: "true" });
  assert.equal(dry.status, 0, dry.stderr);
  // scripts/next-version.mjs on the dispatched commit gives 0.36.0-next.2.
  assert.equal(dry.version, "0.36.0-next.2.dryrun.38700000001.2");
  assert.ok(isDryRunVersion(dry.version));
  assert.equal(dry.target, "archive");
  // When the allocator cannot give the commit a next version, the dry run has no version.
  const unallocated = resolve({ ...dispatch, DRY_RUN: "true" }, brokenAllocator);
  assert.equal(unallocated.status, 1);
  assert.match(unallocated.stderr, /next-version\.mjs could not give this commit a next version/);
  assert.equal(unallocated.version, undefined);
  // Nothing the dispatcher controls names the version: not the ref, not a tag-shaped ref name.
  assert.equal(
    resolve({
      ...dispatch,
      DRY_RUN: "true",
      GITHUB_REF: "refs/tags/v0.37.0",
      GITHUB_REF_NAME: "v0.37.0",
      VERSION: "0.37.0",
    }).version,
    "0.36.0-next.2.dryrun.38700000001.2",
  );
  for (const value of ["false", "", "1"]) {
    const refused = resolve({ ...dispatch, DRY_RUN: value });
    assert.equal(refused.status, 1, value);
    assert.match(refused.stderr, /only dry-runs a release/);
    assert.equal(refused.version, undefined);
  }
  // A tag push releases its tag, to ghcr.
  const tag = resolve({
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/tags/v0.37.0-next.4",
    GITHUB_REF_NAME: "v0.37.0-next.4",
    DRY_RUN: "",
  });
  assert.deepEqual([tag.status, tag.version, tag.target], [0, "0.37.0-next.4", "ghcr"]);
  assert.equal(
    resolve({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" })
      .status,
    1,
  );
  assert.equal(resolve({ GITHUB_EVENT_NAME: "schedule" }).status, 1);
  // Pins and image.yml take that version, and image.yml the target that goes with it.
  assert.deepEqual(releaseJobs.images.with, {
    version: "${{ needs.release.outputs.version }}",
    target: "${{ needs.release.outputs.target }}",
  });
  assert.ok(releaseJobs.pins.needs.includes("release"));
});

/** A job that publishes or writes: an environment, or any write permission. */
const writes = (definition) =>
  definition.environment !== undefined ||
  Object.values(definition.permissions ?? {}).some((level) => level === "write");

test("on a dispatch, no job that publishes, writes, holds an environment or mints an id-token runs", () => {
  const publishing = Object.entries(releaseJobs).filter(
    ([, definition]) => !definition.uses && writes(definition),
  );
  assert.deepEqual(publishing.map(([name]) => name).toSorted(), [
    "finalize-images",
    "github-release",
    "npm",
    "promote-images",
  ]);
  for (const [name, definition] of publishing)
    assert.equal(
      definition.if,
      "github.event_name == 'push'",
      `${name} must run on a tag push only`,
    );
  // image.yml's call keeps the packages: write ceiling (GitHub checks it at startup), but on a dry
  // run its target is archive, and every image.yml job holding packages: write runs for ghcr only.
  for (const [name, definition] of Object.entries(imageDocument.jobs))
    if (Object.values(definition.permissions ?? {}).includes("write"))
      assert.equal(definition.if, "inputs.target == 'ghcr'", `image.yml ${name}`);
  // Nothing in this workflow can delete or rewrite artifacts or runs.
  for (const [name, definition] of Object.entries(releaseJobs))
    assert.notEqual(definition.permissions?.actions, "write", name);
  assert.deepEqual(releaseDocument.permissions, { contents: "read" });
});

test("the acceptance gate passes only on the acceptance this run's target ran", () => {
  const gate = releaseJobs.acceptance;
  assert.deepEqual(gate.permissions, {});
  const [step] = gate.steps;
  assert.equal(step.env.ACCEPTED, "${{ needs.images.outputs.accepted }}");
  assert.equal(step.env.EXPECTED, "${{ needs.release.outputs.target }}");
  const run = (ACCEPTED, EXPECTED) =>
    spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
      env: { PATH: "/usr/bin:/bin", ACCEPTED, EXPECTED },
    }).status;
  assert.equal(run("ghcr", "ghcr"), 0);
  assert.equal(run("archive", "archive"), 0);
  // A call whose jobs all skipped reports nothing; an archive acceptance never gates a publish.
  assert.equal(run("", "ghcr"), 1);
  assert.equal(run("archive", "ghcr"), 1);
  assert.equal(run("", ""), 1);
  // image.yml reports an acceptance only from the step after the acceptance itself.
  assert.equal(
    imageDocument.on.workflow_call.outputs.accepted.value,
    "${{ jobs.packaged-smoke.outputs.accepted || jobs.archive-acceptance.outputs.accepted }}",
  );
  for (const [name, target] of [
    ["packaged-smoke", "ghcr"],
    ["archive-acceptance", "archive"],
  ]) {
    const { steps } = imageDocument.jobs[name];
    const accepted = steps.findIndex((entry) => entry.id === "accepted");
    assert.equal(imageDocument.jobs[name].outputs.accepted, "${{ steps.accepted.outputs.target }}");
    assert.equal(steps[accepted - 1].run, "node scripts/check-packaged-server.mjs");
    assert.equal(steps[accepted].run, `echo "target=${target}" >>"$GITHUB_OUTPUT"`);
    assert.equal(steps[accepted].if, undefined);
  }
});

const indexOf = (image) => `sha256:${createHash("sha256").update(image).digest("hex")}`;
const promoted = (image) => `ghcr.io/sealant-ci/${image}`;

/**
 * promote-images' step as written, against a stand-in docker and gh over a fixture registry, a stub
 * npm dist-tags endpoint, a stub GitHub API, and the real jq. `markers` are the floor's three: npm's
 * latest, GitHub's latest release tag, and each image's :latest version label; `tags` and `labels`
 * add registry state.
 */
const promote = async (
  t,
  {
    version = "1.2.3",
    tags = {},
    manifest = {},
    npm = { tags: {} },
    github = {},
    labels = {},
    unreadable = [],
  } = {},
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "mend-promote-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = registryStandIn(directory, { tags, versions: labels, unreadable });
  const npmStub = await npmDistTags(t, npm);
  const githubStub = await githubApi(t, github);
  const file = path.join(directory, "release-manifest.json");
  writeFileSync(
    file,
    JSON.stringify({
      version,
      commit: "f".repeat(40),
      images: Object.fromEntries(
        ["mend", "mend-before", "mend-api", "mend-web"].map((image) => [
          image,
          { index: indexOf(image) },
        ]),
      ),
      ...manifest,
    }),
  );
  const step = releaseJobs["promote-images"].steps.find(
    (entry) => entry.name === "Update latest after release publication",
  );
  const child = spawn("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
    env: {
      PATH: `${registry.bin}:${process.env.PATH}`,
      HOME: directory,
      GITHUB_REF_NAME: `v${version}`,
      GITHUB_SHA: "f".repeat(40),
      GITHUB_REPOSITORY: "sealant-sh/Mend",
      GITHUB_REPOSITORY_OWNER: "sealant-ci",
      GITHUB_API_URL: githubStub.url,
      NPM_CONFIG_REGISTRY: npmStub.url,
      MANIFEST: file,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((done) => child.on("close", done));
  return {
    status,
    output,
    calls: registry.calls(),
    writes: writesIn(registry.calls()),
    registry: registry.registry(),
  };
};

const IMAGES = ["mend", "mend-api", "mend-web"];
const atVersion = (version) =>
  Object.fromEntries(IMAGES.map((image) => [`${promoted(image)}:${version}`, indexOf(image)]));
const latestAt = (
  version,
  digest = (image) => `sha256:${createHash("sha256").update(`old ${image}`).digest("hex")}`,
) => ({
  tags: Object.fromEntries(IMAGES.map((image) => [`${promoted(image)}:latest`, digest(image)])),
  labels: Object.fromEntries(IMAGES.map((image) => [`${promoted(image)}:latest`, version])),
});
const promotion = (image) => [
  "docker",
  "buildx",
  "imagetools",
  "create",
  "--tag",
  `${promoted(image)}:latest`,
  `${promoted(image)}@${indexOf(image)}`,
];
const releaseEdit = ["gh", "release", "edit", "v1.2.3", "--repo", "sealant-sh/Mend", "--latest"];

test("below a lower floor, latest moves to the manifest's index digests, every read first", async (t) => {
  assert.deepEqual(
    releaseJobs["promote-images"].steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    ).with,
    { name: "release-manifest", path: "release" },
  );
  const old = latestAt("1.2.2");
  const result = await promote(t, {
    tags: { ...atVersion("1.2.3"), ...old.tags },
    labels: old.labels,
    npm: { tags: { latest: "1.2.2", next: "1.3.0-next.4" } },
    github: { latest: "v1.2.2" },
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.writes, [...IMAGES.map(promotion), releaseEdit]);
  const firstWrite = result.calls.findIndex((call) => writesIn([call]).length > 0);
  assert.ok(
    result.calls.slice(firstWrite).every((call) => writesIn([call]).length > 0),
    "no read after the first write",
  );
  assert.match(result.output, /Stable floor: 1\.2\.2 /);
  // No marker at all is no floor.
  const fresh = await promote(t, { tags: atVersion("1.2.3"), github: {} });
  assert.equal(fresh.status, 0, fresh.output);
  assert.deepEqual(fresh.writes, [...IMAGES.map(promotion), releaseEdit]);
});

test("a higher floor from any one marker refuses the promotion and moves nothing", async (t) => {
  const old = latestAt("1.2.2");
  const base = {
    tags: { ...atVersion("1.2.3"), ...old.tags },
    labels: old.labels,
    npm: { tags: { latest: "1.2.2" } },
    github: { latest: "v1.2.2" },
  };
  for (const [marker, change, named] of [
    ["npm latest", { npm: { tags: { latest: "1.3.0" } } }, /npm:@sealant\/mend@latest/],
    ["GitHub's latest release", { github: { latest: "v1.10.0" } }, /github:sealant-sh\/Mend/],
    [
      "one image's :latest",
      { labels: { ...old.labels, [`${promoted("mend-web")}:latest`]: "2.0.0" } },
      /ghcr\.io\/sealant-ci\/mend-web:latest/,
    ],
  ]) {
    const result = await promote(t, { ...base, ...change });
    assert.equal(result.status, 1, marker);
    assert.match(result.output, /is below the stable floor/, marker);
    assert.match(result.output, named, marker);
    assert.match(result.output, /backport such as 0\.35\.2 after 0\.36\.0 is refused on purpose/);
    assert.deepEqual(result.writes, [], marker);
  }
});

test("mixed markers: the highest one is the floor, compared as numbers", async (t) => {
  const old = latestAt("1.2.2");
  const result = await promote(t, {
    tags: { ...atVersion("1.2.3"), ...old.tags },
    labels: { ...old.labels, [`${promoted("mend-api")}:latest`]: "1.10.0" },
    npm: { tags: { latest: "1.9.0" } },
    github: { latest: "v1.2.10" },
  });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /below the stable floor 1\.10\.0 \(ghcr\.io\/sealant-ci\/mend-api:latest\)/,
  );
  assert.deepEqual(result.writes, []);
});

test("at the floor, a retry moves only the :latest not yet this run's index", async (t) => {
  // mend's :latest already moved in an earlier attempt; mend-api's and mend-web's did not.
  const result = await promote(t, {
    tags: {
      ...atVersion("1.2.3"),
      [`${promoted("mend")}:latest`]: indexOf("mend"),
      [`${promoted("mend-api")}:latest`]: `sha256:${"a".repeat(64)}`,
    },
    labels: {
      [`${promoted("mend")}:latest`]: "1.2.3",
      [`${promoted("mend-api")}:latest`]: "1.2.2",
    },
    npm: { tags: { latest: "1.2.3" } },
    github: { latest: "v1.2.2" },
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1\.2\.3 may retry/);
  assert.deepEqual(result.writes, [promotion("mend-api"), promotion("mend-web"), releaseEdit]);
});

test("an unreadable or malformed marker fails the promotion, writing nothing", async (t) => {
  const old = latestAt("1.2.2");
  const base = {
    tags: { ...atVersion("1.2.3"), ...old.tags },
    labels: old.labels,
    npm: { tags: { latest: "1.2.2" } },
    github: { latest: "v1.2.2" },
  };
  for (const [label, change, problem] of [
    ["npm answers 500", { npm: { status: 500 } }, /the registry answered 500/],
    ["GitHub answers 500", { github: { status: 500 } }, /GitHub answered 500/],
    ["GitHub answers 403", { github: { status: 403 } }, /GitHub answered 403/],
    [
      "a :latest unreadable",
      { unreadable: [`${promoted("mend-api")}:latest`] },
      /Could not read ghcr\.io\/sealant-ci\/mend-api:latest/,
    ],
    [
      "npm latest a prerelease",
      { npm: { tags: { latest: "1.3.0-next.2" } } },
      /not a plain X\.Y\.Z/,
    ],
    [
      "a latest release tag not vX.Y.Z",
      { github: { latest: "v1.2" } },
      /tagged "v1\.2", not vX\.Y\.Z/,
    ],
    ["a release tag without v", { github: { latest: "1.2.2" } }, /tagged "1\.2\.2", not vX\.Y\.Z/],
    [
      "a label not X.Y.Z",
      { labels: { ...old.labels, [`${promoted("mend")}:latest`]: "latest" } },
      /carries no single plain X\.Y\.Z/,
    ],
    [
      "platforms that disagree",
      { labels: { ...old.labels, [`${promoted("mend")}:latest`]: ["1.2.2", "1.2.1"] } },
      /carries no single plain X\.Y\.Z org\.opencontainers\.image\.version/,
    ],
    [
      "a missing label",
      { labels: { ...old.labels, [`${promoted("mend")}:latest`]: null } },
      /carries no single plain X\.Y\.Z org\.opencontainers\.image\.version/,
    ],
  ]) {
    const result = await promote(t, { ...base, ...change });
    assert.equal(result.status, 1, label);
    assert.match(result.output, problem, label);
    assert.deepEqual(result.writes, [], label);
  }
});

/**
 * Markers that are present but malformed, the audit's cases among them: each fails the floor, never
 * reads as absent or as the version it starts with. `labels` is the label to give mend's :latest.
 */
const MALFORMED = [
  ["a label with trailing text", { label: "1.2.2 invalid" }, /mend:latest carries no single plain/],
  ["a label with a trailing newline", { label: "1.2.2\n" }, /mend:latest carries no single plain/],
  ["a GitHub tag of only v", { github: "v" }, /tagged "v", not vX\.Y\.Z/],
  ["a GitHub tag that is not a string", { github: 5 }, /tagged 5, not vX\.Y\.Z/],
  ["npm latest null", { npm: { latest: null } }, /latest is null, not a plain/],
  ["npm latest empty", { npm: { latest: "" } }, /latest is "", not a plain/],
  ["npm latest not a string", { npm: { latest: 122 } }, /latest is 122, not a plain/],
  ["npm dist-tags a list", { npm: [] }, /dist-tags is not a JSON object/],
  ["npm dist-tags not an object", { npm: "1.2.2" }, /dist-tags is not a JSON object/],
  // Past 9 digits a part could overflow Bash's 64-bit arithmetic: refused as not plain.
  [
    "a part past 64 bits",
    { label: "9223372036854775808.0.0" },
    /mend:latest carries no single plain/,
  ],
  ["a part of 10 digits", { github: "v1234567890.0.0" }, /not vX\.Y\.Z/],
];

test("a present marker that is malformed fails the promotion, writing nothing", async (t) => {
  const old = latestAt("1.2.2");
  for (const [label, { label: imageLabel, github, npm }, problem] of MALFORMED) {
    const result = await promote(t, {
      tags: { ...atVersion("1.2.3"), ...old.tags },
      labels:
        imageLabel === undefined
          ? old.labels
          : { ...old.labels, [`${promoted("mend")}:latest`]: imageLabel },
      npm: { tags: npm ?? { latest: "1.2.2" } },
      github: { latest: github ?? "v1.2.2" },
    });
    assert.equal(result.status, 1, label);
    assert.match(result.output, problem, label);
    assert.deepEqual(result.writes, [], label);
  }
  // The largest part accepted still compares as a number, above the release.
  const top = await promote(t, {
    tags: { ...atVersion("1.2.3"), ...old.tags },
    labels: { ...old.labels, [`${promoted("mend-web")}:latest`]: "999999999.0.0" },
    npm: { tags: { latest: "1.2.2" } },
    github: { latest: "v1.2.2" },
  });
  assert.equal(top.status, 1);
  assert.match(top.output, /below the stable floor 999999999\.0\.0/);
  assert.deepEqual(top.writes, []);
});

test("a :<version> that moved since acceptance, or another release's manifest, moves nothing", async (t) => {
  const moved = await promote(t, {
    tags: { ...atVersion("1.2.3"), [`${promoted("mend-web")}:1.2.3`]: `sha256:${"e".repeat(64)}` },
  });
  assert.equal(moved.status, 1);
  assert.match(moved.output, /resolves to sha256:e{64}, not .*latest stays/);
  assert.deepEqual(moved.writes, []);
  for (const manifest of [{ version: "1.2.2" }, { commit: "a".repeat(40) }, { images: {} }]) {
    const refused = await promote(t, { tags: atVersion("1.2.3"), manifest });
    assert.equal(refused.status, 1, JSON.stringify(manifest));
    assert.deepEqual(refused.writes, []);
  }
  // A next build moves nothing at all, and reads nothing.
  const next = await promote(t, { version: "1.2.4-next.3", tags: atVersion("1.2.4-next.3") });
  assert.equal(next.status, 0);
  assert.deepEqual(next.calls, []);
});

test("a dry-run-shaped tag is refused before any build; a push only ever builds to ghcr", () => {
  // The audit's bypass: a pushed v0.0.0-dryrun tag built for ghcr, and pins relaxed by its shape.
  for (const name of [
    "v0.0.0-dryrun.9.1",
    "v0.36.0-next.988.dryrun.38931186422.1",
    "v0.37.0-dryrun.1",
    "v1.0.0-next.1-dryrun",
  ]) {
    const pushed = resolve({
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: `refs/tags/${name}`,
      GITHUB_REF_NAME: name,
    });
    assert.equal(pushed.status, 1, name);
    assert.match(pushed.stderr, /is a dry-run version; a dry run is a dispatch, never a tag/);
    assert.equal(pushed.version, undefined);
    assert.equal(pushed.target, undefined);
  }
  // Every accepted resolution pairs a push with ghcr and a dispatch with archive, nothing else.
  for (const [environment, target] of [
    [
      { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.37.0", GITHUB_REF_NAME: "v0.37.0" },
      "ghcr",
    ],
    [
      {
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/tags/v0.37.0-next.4",
        GITHUB_REF_NAME: "v0.37.0-next.4",
      },
      "ghcr",
    ],
    [
      { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/v0.37.0", DRY_RUN: "true" },
      "archive",
    ],
    [
      { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/x", DRY_RUN: "true" },
      "archive",
    ],
  ])
    assert.equal(resolve(environment).target, target, JSON.stringify(environment));
  assert.match(resolveStep.run, /push\/ghcr \| workflow_dispatch\/archive\) ;;/);
});

test("pins gets --dry-run only on a dispatch building to archives", (t) => {
  const step = releaseJobs.pins.steps.find((entry) => entry.name === "Check the pins");
  assert.deepEqual(step.env, {
    VERSION: "${{ needs.release.outputs.version }}",
    TARGET: "${{ needs.release.outputs.target }}",
  });
  const directory = mkdtempSync(path.join(tmpdir(), "release-pins-step-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = path.join(directory, "calls");
  // A stand-in node: the step's argv is what matters; the script itself has its own tests.
  writeFileSync(
    path.join(directory, "node"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(calls)}\n`,
    { mode: 0o755 },
  );
  const run = (GITHUB_EVENT_NAME, TARGET) => {
    writeFileSync(calls, "");
    const status = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
      env: { PATH: `${directory}:/usr/bin:/bin`, GITHUB_EVENT_NAME, TARGET, VERSION: "1.2.3" },
    }).status;
    return { status, argv: readFileSync(calls, "utf8").trim() };
  };
  assert.deepEqual(run("push", "ghcr"), {
    status: 0,
    argv: "scripts/check-release-pins.mjs v1.2.3",
  });
  assert.deepEqual(run("workflow_dispatch", "archive"), {
    status: 0,
    argv: "scripts/check-release-pins.mjs --dry-run v1.2.3",
  });
  assert.deepEqual(run("workflow_dispatch", "ghcr"), { status: 1, argv: "" });
  // A push never relaxes the pins, whatever the target says.
  assert.equal(run("push", "archive").argv, "scripts/check-release-pins.mjs v1.2.3");
});

// --- finalize-images ---

/**
 * finalize-images' step as written, against a stand-in docker over a registry held in a JSON file:
 * `tags` maps a reference to its digest, `unreadable` lists references whose read fails for a
 * reason other than not found, and `onCreate` says what a create does: `land` (the tag gets the
 * source's digest), `other` (another digest lands), `vanish` (the tag becomes unreadable), with an
 * optional exit code. `answers` replaces a reference's read with exact stdout, stderr and exit
 * (only its first read, with `once`).
 */
const finalize = (
  t,
  { tags = {}, unreadable = [], onCreate = {}, manifest = {}, answers = {} } = {},
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "mend-finalize-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const calls = path.join(directory, "calls.jsonl");
  const state = path.join(directory, "registry.json");
  writeFileSync(calls, "");
  writeFileSync(state, JSON.stringify({ tags, unreadable, onCreate, answers }));
  writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const registry = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => writeFileSync(${JSON.stringify(state)}, JSON.stringify(registry));
if (args.slice(0, 3).join(" ") === "buildx imagetools inspect" && args[4] === "--format") {
  const ref = args[3];
  const answer = registry.answers[ref];
  if (answer !== undefined) {
    if (answer.once) {
      delete registry.answers[ref];
      save();
    }
    process.stdout.write(answer.stdout ?? "");
    process.stderr.write(answer.stderr ?? "");
    process.exit(answer.exit ?? 1);
  }
  if (registry.unreadable.includes(ref)) {
    console.error("ERROR: failed to do request: Head \\"https://ghcr.io/v2/x\\": unauthorized");
    process.exit(1);
  }
  if (!(ref in registry.tags)) { console.error("ERROR: " + ref + ": not found"); process.exit(1); }
  console.log(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", digest: registry.tags[ref] }));
  process.exit(0);
}
if (args.slice(0, 4).join(" ") === "buildx imagetools create --tag" && args.length === 6) {
  const [target, source] = args.slice(4);
  const effect = registry.onCreate[target] ?? { land: true };
  if (effect.land) registry.tags[target] = source.split("@")[1];
  if (effect.other) registry.tags[target] = "sha256:" + "e".repeat(64);
  if (effect.vanish) registry.unreadable.push(target);
  save();
  process.exit(effect.exit ?? 0);
}
process.exit(79);
`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  const file = path.join(directory, "release-manifest.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: "1.2.3",
      commit: "f".repeat(40),
      images: Object.fromEntries(
        ["mend", "mend-before", "mend-api", "mend-web"].map((image) => [
          image,
          { index: indexOf(image) },
        ]),
      ),
      ...manifest,
    }),
  );
  const step = releaseJobs["finalize-images"].steps.find(
    (entry) => entry.name === "Publish each accepted index as its version",
  );
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: directory,
      GITHUB_SHA: "f".repeat(40),
      GITHUB_REPOSITORY_OWNER: "sealant-ci",
      MANIFEST: file,
      VERSION: "1.2.3",
    },
  });
  return {
    ...result,
    output: result.stdout + result.stderr,
    registry: JSON.parse(readFileSync(state, "utf8")),
    calls: readFileSync(calls, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
};
const FINAL = ["mend", "mend-api", "mend-web"];
const finalRef = (image) => `${promoted(image)}:1.2.3`;
const ours = Object.fromEntries(FINAL.map((image) => [finalRef(image), indexOf(image)]));
const creates = (result) => result.calls.filter((args) => args[2] === "create");

test("finalize creates each absent :<version> from the accepted index, after reading every one", (t) => {
  const result = finalize(t);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(
    creates(result),
    FINAL.map((image) => [
      "buildx",
      "imagetools",
      "create",
      "--tag",
      finalRef(image),
      `${promoted(image)}@${indexOf(image)}`,
    ]),
  );
  for (const image of FINAL) assert.equal(result.registry.tags[finalRef(image)], indexOf(image));
  const firstCreate = result.calls.findIndex((args) => args[2] === "create");
  assert.equal(firstCreate, FINAL.length, "every tag is read before any is written");
});

test("finalize is done when :<version> already names this run's index: a rerun of failed jobs", (t) => {
  const result = finalize(t, { tags: ours });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(creates(result), []);
  assert.match(result.output, /is already this run's sha256:/);
});

test("finalize refuses a version that exists at another digest, before writing any tag", (t) => {
  const result = finalize(t, {
    tags: { [finalRef("mend-web")]: `sha256:${"e".repeat(64)}` },
  });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /::error::.*mend-web:1\.2\.3 exists at sha256:e{64}.*is spent: cut a new one/,
  );
  assert.deepEqual(creates(result), []);
});

test("finalize fails without writing on a read that is not a not-found", (t) => {
  const result = finalize(t, { unreadable: [finalRef("mend-api")] });
  assert.equal(result.status, 1);
  assert.match(result.output, /::error::Could not read .*mend-api:1\.2\.3; nothing was written/);
  assert.deepEqual(creates(result), []);
});

test("finalize reads absent only from buildx's sole not-found line, and fails on anything else", (t) => {
  const ref = finalRef("mend");
  // The audit's case: not found plus another error is a failed read, not an absent tag.
  for (const [label, answer] of [
    [
      "mixed lines",
      { stderr: `ERROR: ${ref}: not found\nERROR: unauthorized: authentication required\n` },
    ],
    ["an error before it", { stderr: `WARNING: retrying\nERROR: ${ref}: not found\n` }],
    ["a changed format", { stderr: `error: ${ref}: not found\n` }],
    ["another reference", { stderr: `ERROR: ${ref}-other: not found\n` }],
    ["output beside it", { stdout: "{}\n", stderr: `ERROR: ${ref}: not found\n` }],
  ]) {
    const result = finalize(t, { answers: { [ref]: answer } });
    assert.equal(result.status, 1, label);
    assert.match(result.output, /Could not read .*mend:1\.2\.3; nothing was written/, label);
    assert.deepEqual(creates(result), [], label);
  }
  // The exact sole line, however many trailing newlines, is absent: the tag is created. Its
  // re-read after the create is the ordinary one.
  const result = finalize(t, {
    answers: { [ref]: { stderr: `ERROR: ${ref}: not found\n\n`, once: true } },
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(creates(result).length, 1 + 2);
  assert.deepEqual(creates(result)[0].slice(4), [ref, `${promoted("mend")}@${indexOf("mend")}`]);
});

test("finalize: a create that reported an error but left this run's digest is a success", (t) => {
  const result = finalize(t, { onCreate: { [finalRef("mend")]: { land: true, exit: 1 } } });
  assert.equal(result.status, 0, result.output);
  assert.match(
    result.output,
    /::warning::The create reported exit 1, but .*mend:1\.2\.3 resolves to/,
  );
  assert.equal(creates(result).length, 3);
});

test("finalize refuses when the tag shows another digest after its create", (t) => {
  const result = finalize(t, { onCreate: { [finalRef("mend-api")]: { other: true } } });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /mend-api:1\.2\.3 resolves to sha256:e{64} after the create.*is spent/,
  );
  // mend-web is not written after the refusal.
  assert.deepEqual(
    creates(result).map((args) => args[4]),
    [finalRef("mend"), finalRef("mend-api")],
  );
});

test("finalize fails when the tag is unreadable, or still absent, after its create", (t) => {
  const vanished = finalize(t, { onCreate: { [finalRef("mend")]: { vanish: true } } });
  assert.equal(vanished.status, 1);
  assert.match(vanished.output, /mend:1\.2\.3 is unreadable after the create/);
  const missing = finalize(t, { onCreate: { [finalRef("mend")]: { exit: 1 } } });
  assert.equal(missing.status, 1);
  assert.match(missing.output, /mend:1\.2\.3 does not exist after the create \(exit 1\)/);
});

test("finalize refuses another release's manifest or a missing index, writing nothing", (t) => {
  for (const manifest of [{ version: "1.2.2" }, { commit: "a".repeat(40) }, { images: {} }]) {
    const result = finalize(t, { manifest });
    assert.equal(result.status, 1, JSON.stringify(manifest));
    assert.deepEqual(creates(result), []);
  }
});

test("finalize gates npm and promotion, and the three queue on one release channel", () => {
  const finalizeJob = releaseJobs["finalize-images"];
  assert.equal(finalizeJob.if, "github.event_name == 'push'");
  assert.deepEqual(finalizeJob.permissions, { contents: "read", packages: "write" });
  assert.equal(finalizeJob["runs-on"], "ubuntu-24.04");
  assert.ok(finalizeJob.needs.includes("acceptance"));
  assert.deepEqual(
    finalizeJob.steps.find((step) => step.uses?.startsWith("actions/download-artifact@")).with,
    { name: "release-manifest", path: "release" },
  );
  for (const name of ["npm", "promote-images"])
    assert.ok(releaseJobs[name].needs.includes("finalize-images"), name);
  for (const name of ["finalize-images", "npm", "promote-images"])
    assert.deepEqual(
      releaseJobs[name].concurrency,
      { group: "mend-release-channel", "cancel-in-progress": false, queue: "max" },
      name,
    );
});

test("on a real version, only finalize-images writes :<version>", () => {
  // Every registry write in image.yml and release-cli.yml, its continuation lines joined, and what
  // it tags. merge's shell is run above: a real version is staged.
  const registryWrites = [];
  for (const [file, document] of [
    ["image.yml", imageDocument],
    ["release-cli.yml", releaseDocument],
  ])
    for (const [name, definition] of Object.entries(document.jobs))
      for (const entry of definition.steps ?? []) {
        for (const line of (entry.run ?? "").replace(/\\\n\s*/g, " ").split("\n"))
          if (/docker buildx imagetools create|docker push|skopeo copy/.test(line))
            registryWrites.push({ at: `${file} ${name}`, line: line.trim(), entry });
        if (/push=true/.test(entry.with?.outputs ?? ""))
          registryWrites.push({ at: `${file} ${name}`, line: entry.with.outputs, entry });
      }
  // archive-merge writes only to the registry it starts on loopback.
  const loopback = registryWrites.filter(({ at }) => at === "image.yml archive-merge");
  assert.ok(loopback.length >= 2);
  for (const { entry } of loopback)
    assert.equal(entry.env.REPOSITORY, "127.0.0.1:5000/${{ matrix.image.name }}");
  const ghcr = registryWrites.filter(({ at }) => at !== "image.yml archive-merge");
  const tagged = (pattern) => ghcr.filter(({ line }) => pattern.test(line)).map(({ at }) => at);
  assert.deepEqual(tagged(/\$(VERSION|version)\b/), ["release-cli.yml finalize-images"]);
  assert.deepEqual(tagged(/:\$tag"/), ["image.yml merge"]);
  assert.deepEqual(tagged(/:latest"/), ["release-cli.yml promote-images"]);
  // The build pushes by digest only: no tag at all.
  for (const { line } of ghcr.filter(({ at }) => at === "image.yml build"))
    assert.match(line, /push-by-digest=true/);
  assert.deepEqual(ghcr.map(({ at }) => at).toSorted(), [
    "image.yml build",
    "image.yml merge",
    "release-cli.yml finalize-images",
    "release-cli.yml promote-images",
  ]);
});

test("the release job refuses, early, a stable tag below the highest stable tag", (t) => {
  const step = releaseJobs.release.steps.find(
    (entry) => entry.name === "Refuse a stable tag below the highest stable tag",
  );
  assert.equal(step.if, "github.event_name == 'push'");
  assert.deepEqual(releaseJobs.release.permissions, { contents: "read" });
  const directory = mkdtempSync(path.join(tmpdir(), "release-tags-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const refs = [
    "refs/tags/v0.9.0",
    "refs/tags/v0.36.0",
    "refs/tags/v0.37.0-next.9",
    "refs/tags/v1.0.0-rc.1",
    "refs/tags/vscode-v9.0.0",
    "refs/tags/v0.35.1",
  ];
  // A stand-in gh: the repository's v* tags, as `gh api --jq '.[].ref'` prints them.
  writeFileSync(path.join(directory, "gh"), `#!/bin/sh\nprintf '%s\\n' ${refs.join(" ")}\n`, {
    mode: 0o755,
  });
  const run = (VERSION) =>
    spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
      encoding: "utf8",
      env: { PATH: `${directory}:/usr/bin:/bin`, VERSION, GITHUB_REPOSITORY: "sealant-sh/Mend" },
    });
  // Compared as numbers: 0.36.0 is the highest stable tag, above 0.9.0 and 0.35.1.
  const backport = run("0.35.2");
  assert.equal(backport.status, 1);
  assert.match(backport.stdout, /v0\.35\.2 is below v0\.36\.0, the highest stable tag/);
  assert.equal(run("0.10.0").status, 1);
  for (const version of ["0.36.0", "0.36.1", "0.37.0", "1.0.0"])
    assert.equal(run(version).status, 0, version);
  // A next build is not this check's: the next order is the pins job's.
  assert.equal(run("0.30.0-next.1").status, 0);
  // sort -n compares parts of any length: a 64-bit-overflowing tag is still the highest.
  writeFileSync(
    path.join(directory, "gh"),
    `#!/bin/sh\nprintf '%s\\n' refs/tags/v0.36.0 refs/tags/v9223372036854775808.0.0\n`,
    { mode: 0o755 },
  );
  const overflow = run("1.0.0");
  assert.equal(overflow.status, 1);
  assert.match(overflow.stdout, /below v9223372036854775808\.0\.0/);
});

/** The `# --- floor ---` block a step carries. */
const floorOf = (run) =>
  run.slice(run.indexOf("# --- floor ---"), run.indexOf("# --- end floor ---"));

test("each stable guard reads the floor inside the release channel's lock, before any write", () => {
  const channel = { group: "mend-release-channel", "cancel-in-progress": false, queue: "max" };
  const npmStep = releaseJobs.npm.steps.find((entry) => entry.name === "Publish to npm").run;
  const promoteStep = releaseJobs["promote-images"].steps.find(
    (entry) => entry.name === "Update latest after release publication",
  ).run;
  // One floor, carried byte for byte by both jobs.
  assert.ok(floorOf(npmStep).length > 1000);
  assert.equal(floorOf(npmStep), floorOf(promoteStep));
  for (const [name, run, writeCommands] of [
    ["npm", npmStep, [/publish_release "\$\{flags\[@\]\}"/]],
    ["promote-images", promoteStep, [/docker buildx imagetools create/, /gh release edit/]],
  ]) {
    assert.deepEqual(releaseJobs[name].concurrency, channel, name);
    const body = run.slice(run.indexOf("# --- end floor ---"));
    const floor = body.indexOf('floor=$(stable_floor "@sealant/mend" "$GITHUB_REPOSITORY_OWNER")');
    const guard = body.indexOf('guard=$(stable_guard "$version" "$floor")');
    assert.ok(floor > 0 && guard > floor, name);
    for (const write of writeCommands) assert.ok(body.search(write) > guard, `${name}: ${write}`);
  }
  // promote-images reads every tag before it writes any.
  const body = promoteStep.slice(promoteStep.indexOf("# --- end floor ---"));
  const lastRead = body.lastIndexOf("tag_digest ");
  assert.ok(lastRead > 0 && lastRead < body.indexOf("docker buildx imagetools create"));
});
