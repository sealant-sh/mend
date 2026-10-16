import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("the actual image merge shell refuses existing immutable versions before any create", () => {
  const script = shellStep(
    "../.github/workflows/image.yml",
    "merge",
    "Create and inspect the multi-arch candidate",
  );
  for (const version of ["1.2.3", "1.2.4-next.1"]) {
    withPublicationFixture(
      "docker",
      { imageExists: true },
      { ["a".repeat(64)]: "", ["b".repeat(64)]: "" },
      (run) => {
        const result = run(script, { REPOSITORY: "ghcr.invalid/fixture/mend", VERSION: version });
        assert.equal(result.status, 1);
        assert.deepEqual(result.calls, [
          ["buildx", "imagetools", "inspect", `ghcr.invalid/fixture/mend:${version}`],
        ]);
        assert.equal(result.state.created, undefined);
      },
    );
  }
});

test("the actual image merge shell creates exact digest sources for new and rebuildable versions", () => {
  const script = shellStep(
    "../.github/workflows/image.yml",
    "merge",
    "Create and inspect the multi-arch candidate",
  );
  const digests = ["a".repeat(64), "b".repeat(64)];
  for (const [version, exists] of [
    ["1.2.3", false],
    ["0.0.0-dev.sha0123456789ab", true],
    ["0.0.0-acceptance.601", true],
  ]) {
    withPublicationFixture(
      "docker",
      { imageExists: exists },
      { [digests[0]]: "", [digests[1]]: "" },
      (run) => {
        const result = run(script, { REPOSITORY: "ghcr.invalid/fixture/mend", VERSION: version });
        assert.equal(result.status, 0, result.stderr);
        const target = `ghcr.invalid/fixture/mend:${version}`;
        const sources = digests.map((digest) => `ghcr.invalid/fixture/mend@sha256:${digest}`);
        assert.deepEqual(metadataNamed(result.calls), [
          ...(exists ? [] : [["buildx", "imagetools", "inspect", target]]),
          [
            "buildx",
            "imagetools",
            "create",
            "--metadata-file",
            "<metadata>",
            "--tag",
            target,
            ...sources,
          ],
          ["buildx", "imagetools", "inspect", target],
        ]);
        assert.deepEqual(result.state.sources, sources);
      },
    );
  }
});

test("the actual image merge shell propagates create and final-inspection failures", () => {
  const script = shellStep(
    "../.github/workflows/image.yml",
    "merge",
    "Create and inspect the multi-arch candidate",
  );
  for (const [failure, status] of [
    ["failCreate", 73],
    ["failInspect", 74],
  ]) {
    withPublicationFixture(
      "docker",
      { imageExists: false, [failure]: true },
      { ["a".repeat(64)]: "" },
      (run) => {
        const result = run(script, { REPOSITORY: "ghcr.invalid/fixture/mend", VERSION: "1.2.3" });
        assert.equal(result.status, status);
        assert.deepEqual(metadataNamed(result.calls), [
          ["buildx", "imagetools", "inspect", "ghcr.invalid/fixture/mend:1.2.3"],
          [
            "buildx",
            "imagetools",
            "create",
            "--metadata-file",
            "<metadata>",
            "--tag",
            "ghcr.invalid/fixture/mend:1.2.3",
            `ghcr.invalid/fixture/mend@sha256:${"a".repeat(64)}`,
          ],
          ...(failure === "failInspect"
            ? [["buildx", "imagetools", "inspect", "ghcr.invalid/fixture/mend:1.2.3"]]
            : []),
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
  assert.match(pins, /node scripts\/check-release-pins\.mjs "v\$VERSION"/);
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
  const merge = image.slice(image.indexOf("Create and inspect the multi-arch candidate"));
  const refusal = merge.indexOf("already exists; a version is pushed once");
  assert.ok(refusal > 0);
  assert.ok(merge.indexOf("docker buildx imagetools create") > refusal);

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
    /publish_release "\$GITHUB_WORKSPACE\/cli" "\$GITHUB_WORKSPACE\/release" "@sealant\/mend" \\\n\s+"\$version" "\$GITHUB_SHA" "\$channel" --provenance/,
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
const resolve = (environment) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-resolve-"));
  const output = path.join(directory, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", resolveStep.run], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
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
  assert.equal(dry.version, "0.0.0-dryrun.38700000001.2");
  assert.equal(dry.target, "archive");
  // Nothing the dispatcher controls names the version: not the ref, not a tag-shaped ref name.
  assert.equal(
    resolve({
      ...dispatch,
      DRY_RUN: "true",
      GITHUB_REF: "refs/tags/v0.37.0",
      GITHUB_REF_NAME: "v0.37.0",
      VERSION: "0.37.0",
    }).version,
    "0.0.0-dryrun.38700000001.2",
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

/** A recorded call's imagetools verb (`docker buildx imagetools <verb>`). */
const verb = ([, , , action]) => action;

/** promote-images' step as written, against stand-in docker and gh, and the real jq. */
const promote = (t, { version = "1.2.3", tags = {}, manifest = {} } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), "mend-promote-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const calls = path.join(directory, "calls.jsonl");
  writeFileSync(calls, "");
  const command = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const name = require("node:path").basename(process.argv[1]);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([name, ...args]) + "\\n");
const tags = ${JSON.stringify(tags)};
if (name === "docker" && args[2] === "inspect") {
  if (!(args[3] in tags)) process.exit(1);
  console.log(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", digest: tags[args[3]] }));
}
`;
  for (const name of ["docker", "gh"]) {
    writeFileSync(path.join(bin, name), command);
    chmodSync(path.join(bin, name), 0o755);
  }
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
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REF_NAME: `v${version}`,
      GITHUB_SHA: "f".repeat(40),
      GITHUB_REPOSITORY: "sealant-sh/Mend",
      GITHUB_REPOSITORY_OWNER: "sealant-ci",
      MANIFEST: file,
    },
  });
  return {
    ...result,
    calls: readFileSync(calls, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
};

test("latest moves only to the index digests this run's manifest records, all checked first", (t) => {
  assert.deepEqual(
    releaseJobs["promote-images"].steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    ).with,
    { name: "release-manifest", path: "release" },
  );
  const images = ["mend", "mend-api", "mend-web"];
  const current = Object.fromEntries(
    images.map((image) => [`${promoted(image)}:1.2.3`, indexOf(image)]),
  );
  const result = promote(t, { tags: current });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.calls.filter((call) => verb(call) === "create"),
    images.map((image) => [
      "docker",
      "buildx",
      "imagetools",
      "create",
      "--tag",
      `${promoted(image)}:latest`,
      `${promoted(image)}@${indexOf(image)}`,
    ]),
  );
  // Every tag is checked before latest moves at all.
  assert.ok(
    result.calls.findLastIndex((call) => verb(call) === "inspect") <
      result.calls.findIndex((call) => verb(call) === "create"),
  );
  assert.deepEqual(result.calls.at(-1), [
    "gh",
    "release",
    "edit",
    "v1.2.3",
    "--repo",
    "sealant-sh/Mend",
    "--latest",
  ]);
  // A version tag that moved since acceptance: latest stays, for every image.
  const moved = promote(t, {
    tags: { ...current, [`${promoted("mend-web")}:1.2.3`]: `sha256:${"e".repeat(64)}` },
  });
  assert.equal(moved.status, 1);
  assert.match(moved.stdout + moved.stderr, /resolves to sha256:e{64}, not .*latest stays/);
  assert.ok(moved.calls.every((call) => call[0] === "docker" && verb(call) === "inspect"));
  // Another release's manifest, or one without an index, moves nothing.
  for (const manifest of [{ version: "1.2.2" }, { commit: "a".repeat(40) }, { images: {} }]) {
    const refused = promote(t, { tags: current, manifest });
    assert.equal(refused.status, 1, JSON.stringify(manifest));
    assert.ok(refused.calls.every((call) => verb(call) !== "create"));
  }
  // A next build moves nothing at all.
  const next = promote(t, { version: "1.2.4-next.3", tags: current });
  assert.equal(next.status, 0);
  assert.deepEqual(next.calls, []);
});
