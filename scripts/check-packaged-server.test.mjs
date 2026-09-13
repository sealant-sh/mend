import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { gitFixtureServer } from "./packaged-git-fixture.mjs";
import {
  assertFreshDocker,
  assertHealth,
  assertImagePin,
  assertInstallDockerEvents,
  assertUpgradeRetention,
  assertCaptureExecutor,
  captureRegisteredEvidence,
  checkpointChainEvidence,
  isSealantExecutor,
  reviewDiffEvidence,
  flushReportEvidence,
  cleanupOwnedVolumes,
  completedCommandEvidence,
  createVolumeLedger,
  createDiagnosticProbe,
  createFailedCommandDiagnostics,
  dockerFingerprint,
  installationOwnerLabel,
  isolatedClientEnvironment,
  isInside,
  ownsComposeContainer,
  ownsWorkspaceContainer,
  readPrivateIdentity,
  readUpgradeInputs,
  runPackagedUpgrade,
  privateTreeFingerprint,
  verifyUpgradeBackup,
} from "./packaged-server-assertions.mjs";

const exec = promisify(execFile);
const empty = () => ({ containers: [], networks: [], volumes: [], images: [] });
const projectLabel = "com.docker.compose.project";

test("entrypoint refuses occupied Docker inventories with upgrade enabled or disabled before any mutation", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "mend-acceptance-gate-test-"));
  const script = fileURLToPath(new URL("./check-packaged-server.mjs", import.meta.url));
  try {
    // This executable models Docker's read-only inventory interface, never the Mend CLI.
    // Any attempted mutation, npm invocation, or temporary installation makes the test fail.
    const dockerScript = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const root = ${JSON.stringify(scratch)};
const args = process.argv.slice(2);
appendFileSync(root + '/calls', JSON.stringify(args) + '\\n');
const command = args[0] === '--context' ? args.slice(2) : args;
const state = JSON.parse(readFileSync(root + '/inventory', 'utf8'));
if (command.join(' ') === 'context show') console.log('default');
else if (command.join(' ') === 'context inspect default') console.log(JSON.stringify([{Endpoints:{docker:{Host:'unix:///var/run/docker.sock'}}}]));
else if (command[0] === 'ps') console.log(state.containers.length ? 'container-id' : '');
else if (command[1] === 'ls') console.log(command[0] === 'network' ? (state.networks.length ? 'network-id' : '') : command[0] === 'volume' ? (state.volumes.length ? 'volume-name' : '') : '');
else if (command[1] === 'inspect') console.log(JSON.stringify(state[command[0] + 's']));
else process.exit(90);
`;
    await writeFile(join(scratch, "docker"), dockerScript, { mode: 0o700 });
    const inventories = [
      { containers: [{ Id: "container-id", Config: { Labels: { [projectLabel]: "mend" } } }] },
      { networks: [{ Id: "network-id", Name: "mend_default" }] },
      { volumes: [{ Name: "mend-store" }] },
    ];
    for (const { occupied, upgrading } of inventories.flatMap((inventory) =>
      [false, true].map((enabled) => ({ occupied: inventory, upgrading: enabled })),
    )) {
      await writeFile(join(scratch, "inventory"), JSON.stringify({ ...empty(), ...occupied }));
      await writeFile(join(scratch, "calls"), "");
      await assert.rejects(
        exec(process.execPath, [script], {
          env: {
            ...process.env,
            PATH: `${scratch}:${process.env.PATH}`,
            HOME: scratch,
            TMPDIR: scratch,
            DOCKER_HOST: "",
            DOCKER_CONTEXT: "",
            MEND_TEST_UPGRADE_IMAGE: upgrading ? "ghcr.io/sealant-sh/mend:2.0.0" : undefined,
            MEND_TEST_UPGRADE_VERSION: upgrading ? "2.0.0" : undefined,
            MEND_TEST_UPGRADE_ASSETS: undefined,
            MEND_TEST_OFFLINE: undefined,
            MEND_TEST_VERSION: "1.2.3",
            MEND_TEST_IMAGE: "ghcr.io/sealant-sh/mend:1.2.3",
          },
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /Refusing acceptance/);
          return true;
        },
      );
      const calls = (await readFile(join(scratch, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(calls.length > 0);
      assert.ok(
        calls.every(
          (args) =>
            !args.some((arg) =>
              [
                "create",
                "rm",
                "up",
                "down",
                "prune",
                "start",
                "stop",
                "restart",
                "run",
                "pull",
              ].includes(arg),
            ),
        ),
      );
      assert.deepEqual((await readdir(scratch)).toSorted(), ["calls", "docker", "inventory"]);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("entrypoint retains failed-command output privately after installation cleanup, printing only its path", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "mend-command-failure-test-"));
  const script = fileURLToPath(new URL("./check-packaged-server.mjs", import.meta.url));
  try {
    // No real Docker or packing. Fail the first pack command after the read-only gate.
    await writeFile(
      join(scratch, "docker"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[0] === '--context' ? args.slice(2) : args;
if (command.join(' ') === 'context show') console.log('default');
else if (command.join(' ') === 'context inspect default') console.log(JSON.stringify([{Endpoints:{docker:{Host:'unix:///var/run/docker.sock'}}}]));
else if (command[0] === 'info') console.log('synthetic-failure-test');
else if (command[0] === 'ps' || command[1] === 'ls') console.log('');
else process.exit(90);
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(scratch, "pnpm"),
      `#!/usr/bin/env node
process.stdout.write('private-stdout-token');
process.stderr.write('private-stderr-token');
process.exitCode = 17;
`,
      { mode: 0o700 },
    );
    let reportedPath;
    await assert.rejects(
      exec(process.execPath, [script], {
        env: {
          ...process.env,
          PATH: `${scratch}:${process.env.PATH}`,
          HOME: scratch,
          TMPDIR: scratch,
          DOCKER_HOST: "",
          DOCKER_CONTEXT: "",
          MEND_TEST_UPGRADE_IMAGE: undefined,
          MEND_TEST_UPGRADE_VERSION: undefined,
          MEND_TEST_UPGRADE_ASSETS: undefined,
          MEND_TEST_OFFLINE: undefined,
          MEND_TEST_VERSION: "1.2.3",
          MEND_TEST_IMAGE: "ghcr.io/sealant-sh/mend:1.2.3",
        },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /pnpm failed/);
        assert.doesNotMatch(
          error.stdout + error.stderr,
          /private-stdout-token|private-stderr-token/,
        );
        reportedPath = error.stderr.match(/diagnostics retained at ([^;]+);/)?.[1];
        assert.ok(reportedPath && isInside(scratch, reportedPath));
        return true;
      },
    );
    assert.equal((await lstat(reportedPath)).mode & 0o777, 0o700);
    const names = await readdir(scratch);
    assert.equal(names.length, 3); // Tools and diagnostics only. Installation and lock removed.
    const metadata = JSON.parse(await readFile(join(reportedPath, "FAILED-1.json"), "utf8"));
    assert.equal(metadata.command, "pnpm");
    assert.equal(metadata.code, 17);
    for (const name of await readdir(reportedPath))
      assert.equal((await lstat(join(reportedPath, name))).mode & 0o777, 0o600);
    assert.equal(
      await readFile(join(reportedPath, "FAILED-1.stdout"), "utf8"),
      "private-stdout-token",
    );
    assert.equal(
      await readFile(join(reportedPath, "FAILED-1.stderr"), "utf8"),
      "private-stderr-token",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("fresh-install gate rejects all existing Mend resources, even stopped/orphaned ones", () => {
  for (const running of [false, true]) {
    assert.throws(
      () =>
        assertFreshDocker({
          ...empty(),
          containers: [
            { State: { Running: running }, Config: { Labels: { [projectLabel]: "mend" } } },
          ],
        }),
      /existing compose/,
    );
  }
  for (const name of ["mend", "mend_default", "mend_custom"]) {
    assert.throws(
      () => assertFreshDocker({ ...empty(), networks: [{ Name: name }] }),
      /existing Mend network/,
    );
  }
  for (const part of [
    "store",
    "control",
    "garage",
    "config",
    "ssh",
    "rabbitmq",
    "registry",
    "postgres",
    "pg",
    "etc",
  ]) {
    for (const name of [`mend-${part}`, `mend_mend-${part}`, `mend_${part}`]) {
      assert.throws(
        () => assertFreshDocker({ ...empty(), volumes: [{ Name: name }] }),
        /canonical Mend volume/,
      );
    }
  }
  for (const kind of ["volumes", "networks"]) {
    assert.throws(() =>
      assertFreshDocker({
        ...empty(),
        [kind]: [{ Name: "unexpected-name", Labels: { [projectLabel]: "mend" } }],
      }),
    );
  }
});

test("mend-dev and unrelated Sealant resources are not classified as acceptance-owned", () => {
  const snapshot = {
    ...empty(),
    containers: [{ Id: "existing", Config: { Labels: { [projectLabel]: "mend-dev" } } }],
    networks: [
      { Name: "mend-dev_default", Labels: { [projectLabel]: "mend-dev" } },
      { Name: "sealant_default" },
    ],
    volumes: [{ Name: "mend-dev_mend-postgres" }, { Name: "sealant-registry" }],
  };
  assert.doesNotThrow(() => assertFreshDocker(snapshot));
  assert.equal(ownsComposeContainer(snapshot.containers[0], new Set(), "/tmp/run/mend"), false);
});

test("Compose cleanup requires new immutable ID, exact project, and generation path ownership", () => {
  const owned = {
    Id: "new",
    Config: {
      Labels: {
        [projectLabel]: "mend",
        "com.docker.compose.project.working_dir":
          "/tmp/run/mend/generations/gen-11111111-1111-4111-8111-111111111111",
      },
    },
  };
  assert.equal(ownsComposeContainer(owned, new Set(), "/tmp/run/mend"), true);
  assert.equal(ownsComposeContainer(owned, new Set(["new"]), "/tmp/run/mend"), false);
  for (const directory of [
    "/tmp/run/mend-other/generations/gen-123",
    "/tmp/run/mend/arbitrary-child",
    "/tmp/run/mend/generations/gen-123",
    "/tmp/run/mend/generations/../generations/gen-11111111-1111-4111-8111-111111111111",
    "/tmp/run/mend",
    "/tmp/run/mend/../other",
    "/home/user/.config/mend/generations/gen-123",
    undefined,
  ]) {
    const candidate = {
      ...owned,
      Config: {
        Labels: { ...owned.Config.Labels, "com.docker.compose.project.working_dir": directory },
      },
    };
    assert.equal(ownsComposeContainer(candidate, new Set(), "/tmp/run/mend"), false);
  }
});

test("containment does not confuse sibling prefixes or parent directories", () => {
  assert.equal(isInside("/tmp/test", "/tmp/test/child"), true);
  for (const value of ["/tmp/test", "/tmp/test-other", "/tmp/test/../elsewhere", "/tmp", undefined])
    assert.equal(isInside("/tmp/test", value), false);
});

const detail = (exitCode) =>
  Object.freeze({
    session: { status: "completed" },
    checkpoints: [{}, {}],
    currentAgent: Object.freeze({ status: "exited", exitedAt: "2026-09-06T00:00:00Z", exitCode }),
  });

test("completed command evidence preserves unknown exit codes and rejects observed failure", () => {
  for (const code of [null, 0]) {
    const value = detail(code);
    assert.equal(completedCommandEvidence(value), value);
    assert.equal(value.currentAgent.exitCode, code);
  }
  for (const code of [1, -1, 137, undefined, "0"])
    assert.throws(() => completedCommandEvidence(detail(code)));
  assert.equal(completedCommandEvidence({ ...detail(null), currentAgent: null }), false);
  assert.equal(completedCommandEvidence({ ...detail(null), checkpoints: [] }), false);
  assert.equal(
    completedCommandEvidence({ ...detail(null), session: { status: "running" } }),
    false,
  );
  assert.throws(() => completedCommandEvidence({ ...detail(null), session: { status: "failed" } }));
  for (const exitedAt of [null, "", "not a timestamp"])
    assert.throws(() =>
      completedCommandEvidence({
        ...detail(null),
        currentAgent: { ...detail(null).currentAgent, exitedAt },
      }),
    );
});

test("health checks require the exact configured version", () => {
  assert.doesNotThrow(() => assertHealth({ status: "ok", version: "1.2.3", extra: true }, "1.2.3"));
  for (const value of [
    undefined,
    null,
    {},
    "<html>ok</html>",
    { status: "ok" },
    { status: "ok", version: "1.2.4" },
    { status: "starting", version: "1.2.3" },
  ])
    assert.throws(() => assertHealth(value, "1.2.3"));
});

const workspaceId = "1a2b3c4d-5678-4901-abcd-123456789abc";

/**
 * What Sealant's Docker runtime launches for a session in capture mode (observed live, 2026-09-13):
 * named `sealant-<id>`, no store mount, no host bind, two scoped mend-control volumes — the control
 * socket at /run/sealant and a read-only secrets file at /run/sealant/secrets. The hot pool
 * decouples `<id>` from the session's `sealantWorkspaceId`, so the executor is proven store-less,
 * not pinned to a session by id.
 */
function executor(overrides = {}) {
  const mounts = [
    {
      Type: "volume",
      Source: "mend-control",
      Target: "/run/sealant",
      VolumeOptions: { Subpath: `sealant-${workspaceId}` },
    },
    {
      Type: "volume",
      Source: "mend-control",
      Target: "/run/sealant/secrets",
      ReadOnly: true,
      VolumeOptions: { Subpath: `_dotfiles/sealant-secret-env-${workspaceId}` },
    },
  ];
  return {
    Id: "new-executor",
    Name: `/sealant-${workspaceId}`,
    State: { Running: true },
    HostConfig: { Mounts: mounts, Binds: null },
    Mounts: mounts.map((mount) => ({
      Type: "volume",
      Name: mount.Source,
      Destination: mount.Target,
      RW: mount.ReadOnly !== true,
    })),
    ...overrides,
  };
}

test("a store-less Sealant executor passes acceptance and is owned for cleanup by shape", () => {
  const candidate = executor();
  assert.equal(isSealantExecutor(candidate), true);
  assert.doesNotThrow(() => assertCaptureExecutor(candidate));
  assert.equal(ownsWorkspaceContainer(candidate, new Set()), true);
  assert.equal(ownsWorkspaceContainer(candidate, new Set([candidate.Id])), false);
  // Recognised by the control subpath even when the container was renamed by an operator.
  const renamed = executor({ Name: "/renamed" });
  assert.equal(isSealantExecutor(renamed), true);
  assert.equal(ownsWorkspaceContainer(renamed, new Set()), true);
  // Neither a Sealant name nor a scoped control mount: not an executor, never owned.
  const foreign = executor({
    Name: "/unrelated",
    HostConfig: { Mounts: [], Binds: null },
    Mounts: [],
  });
  assert.equal(isSealantExecutor(foreign), false);
  assert.equal(ownsWorkspaceContainer(foreign, new Set()), false);
  assert.throws(() => assertCaptureExecutor(foreign), /must be a Sealant executor/);
});

const rejectedExecutors = [
  [
    "store volume mount",
    (candidate) => {
      candidate.HostConfig.Mounts.push({
        Type: "volume",
        Source: "mend-store",
        Target: "/workspace/.roots/workspace",
        VolumeOptions: { Subpath: "project/worktrees" },
      });
      candidate.Mounts.push({
        Type: "volume",
        Name: "mend-store",
        Destination: "/workspace/.roots/workspace",
        RW: true,
      });
    },
  ],
  [
    "store bind mount",
    (candidate) => {
      candidate.HostConfig.Mounts.push({
        Type: "bind",
        Source: "/var/lib/mend/store/project/repo.git",
        Target: "/mounted/repo.git",
      });
    },
  ],
  [
    "actual store mount only",
    (candidate) => {
      candidate.Mounts.push({ Type: "volume", Name: "mend-store", Destination: "/x", RW: false });
    },
  ],
  [
    "legacy host bind",
    (candidate) => {
      candidate.HostConfig.Binds = ["/tmp/foreign:/extra:ro"];
    },
  ],
  [
    "a foreign volume at the control-socket path",
    (candidate) => {
      candidate.HostConfig.Mounts.push({
        Type: "volume",
        Source: "mend-store",
        Target: "/run/sealant/extra",
        VolumeOptions: { Subpath: "x" },
      });
    },
  ],
];

for (const [name, invalidate] of rejectedExecutors) {
  test(`acceptance rejects and never owns an executor with ${name}`, () => {
    const candidate = executor();
    invalidate(candidate);
    // Still a Sealant executor by name, but a store mount / host bind is a failure, never owned.
    assert.equal(isSealantExecutor(candidate), true);
    assert.throws(() => assertCaptureExecutor(candidate));
    assert.equal(ownsWorkspaceContainer(candidate, new Set()), false);
  });
}

test("capture evidence needs a registered capture n ≥ 1 from the capture source", () => {
  const stamp = (patch) => ({
    state: "observed",
    source: "capture",
    captureN: 2,
    captureId: "d492613406d23848341e473ed043bfffb2309b85375528a2ce401a6609ed3731",
    seq: "4180",
    partial: false,
    observedAt: "2026-09-13T13:41:09Z",
    label: "observed at capture 2 · seq 4180",
    ...patch,
  });
  const observed = stamp();
  assert.equal(captureRegisteredEvidence(observed), observed);
  const claimed = stamp({ state: "claimed" });
  assert.equal(captureRegisteredEvidence(claimed), claimed);
  for (const patch of [{ captureN: 0 }, { captureN: null }, { captureId: null }, { captureId: "" }])
    assert.equal(captureRegisteredEvidence(stamp(patch)), false);
  assert.equal(captureRegisteredEvidence(undefined), false);
  assert.equal(captureRegisteredEvidence(null), false);
  assert.throws(
    () => captureRegisteredEvidence(stamp({ source: "worktree", captureN: null })),
    /live worktree/,
  );
  assert.throws(() => captureRegisteredEvidence({ label: "x" }), /well formed/);
});

const worktreeId = "524ee990-7ba6-46a3-9186-6af0d042e527";
const baseSha = "a".repeat(40);
const changeSha = "b".repeat(40);
const chainRow = (ordinal, patch = {}) => ({
  id: `checkpoint-${ordinal}`,
  worktreeId,
  sessionId: ordinal === 0 ? null : "session-1",
  ordinal,
  ref: `refs/mend/checkpoints/${worktreeId}/${ordinal}`,
  sha: ordinal === 0 ? baseSha : changeSha,
  sealantRunId: ordinal === 0 ? null : "run-1",
  seq: ordinal === 0 ? "0" : String(ordinal * 10),
  trigger: ordinal === 0 ? "session-start" : ordinal === 2 ? "user-mark" : "turn-boundary",
  createdAt: "2026-09-13T18:02:27Z",
  ...patch,
});

test("chain evidence needs a dense worktree chain from the base with the user mark unchanged", () => {
  const chain = [chainRow(0), chainRow(1), chainRow(2)];
  const checkpoint = chainRow(2);
  const rendered = checkpointChainEvidence(chain, { baseSha, checkpoint, worktreeId });
  assert.equal(
    rendered,
    [
      `0 ${baseSha} refs/mend/checkpoints/${worktreeId}/0 session-start`,
      `1 ${changeSha} refs/mend/checkpoints/${worktreeId}/1 turn-boundary`,
      `2 ${changeSha} refs/mend/checkpoints/${worktreeId}/2 user-mark`,
    ].join("\n"),
  );
  // Later chain growth (a review-open checkpoint) renders differently, so lifecycle
  // fingerprints detect a chain that changed underneath a restart or upgrade.
  assert.notEqual(
    checkpointChainEvidence([...chain, chainRow(3, { trigger: "review-open" })], {
      baseSha,
      checkpoint,
      worktreeId,
    }),
    rendered,
  );
  const evidence = (rows, mark = checkpoint) =>
    checkpointChainEvidence(rows, { baseSha, checkpoint: mark, worktreeId });
  assert.throws(() => evidence([chainRow(0)]), /at least one change checkpoint/);
  assert.throws(() => evidence([chainRow(0), chainRow(2)]), /dense from ordinal 0/);
  assert.throws(() => evidence([chainRow(1), chainRow(2)]), /dense from ordinal 0/);
  assert.throws(
    () => evidence([chainRow(0), chainRow(1), chainRow(2, { worktreeId: "other" })]),
    /dense from ordinal 0/,
  );
  assert.throws(
    () => evidence([chainRow(0), chainRow(1), chainRow(2, { ref: "refs/heads/mend/x" })]),
    /dense from ordinal 0/,
  );
  assert.throws(
    () => evidence([chainRow(0, { sha: changeSha }), chainRow(1), chainRow(2)]),
    /snapshot the worktree's base/,
  );
  for (const patch of [
    { id: "elsewhere" },
    { sha: "c".repeat(40) },
    { ref: `refs/mend/checkpoints/${worktreeId}/9` },
    { seq: "21" },
    { sealantRunId: "run-2" },
  ])
    assert.throws(() => evidence(chain, chainRow(2, patch)), /stand in the worktree chain/);
  assert.throws(
    () => evidence([chainRow(0), chainRow(1), chainRow(2, { trigger: "turn-boundary" })]),
    /stand in the worktree chain/,
  );
  assert.throws(
    () =>
      evidence(
        [chainRow(0), chainRow(1), chainRow(2, { sha: baseSha })],
        chainRow(2, { sha: baseSha }),
      ),
    /stand in the worktree chain/,
  );
  assert.throws(() => evidence(chain, null), /stand in the worktree chain/);
  assert.throws(
    () => checkpointChainEvidence(chain, { baseSha: "short", checkpoint, worktreeId }),
    /needs the worktree and its base/,
  );
});

test("review diff evidence needs a base-anchored slice whose pack-served patch carries the file", () => {
  const observation = {
    state: "observed",
    source: "capture",
    captureN: 4,
    captureId: "c02c00f10b683de051b0a4f461ea25c5fbb07c0d84e3ea7eb4bda470a4c6250c",
    seq: "12",
    partial: false,
    observedAt: "2026-09-13T18:02:27Z",
    label: "observed at capture 4 · seq 12",
  };
  const marker = "packaged-proof-1234";
  const view = (patch = {}) => ({
    change: { id: "change-1" },
    slice: {
      id: "slice-1",
      changeId: "change-1",
      checkpointAId: "checkpoint-0",
      checkpointBId: "checkpoint-3",
    },
    checkpointA: chainRow(0),
    checkpointB: chainRow(3, { trigger: "review-open" }),
    patch: `diff --git a/packaged-proof.txt b/packaged-proof.txt\n+${marker}\n`,
    files: [{ oldPath: null, newPath: "packaged-proof.txt", status: "added" }],
    anchorFiles: [],
    worktreeChangedSinceSnapshot: false,
    observation,
    ...patch,
  });
  const options = { baseSha, sliceId: "slice-1", marker, file: "packaged-proof.txt" };
  const valid = view();
  assert.equal(reviewDiffEvidence(valid, options), valid);
  const rejects = (patch, message) =>
    assert.throws(() => reviewDiffEvidence(view(patch), options), message);
  rejects({ slice: { ...valid.slice, id: "slice-2" } }, /name its slice/);
  rejects({ checkpointB: chainRow(2) }, /name its slice/);
  rejects({ checkpointA: chainRow(0, { sha: changeSha }) }, /anchor at the worktree's base/);
  rejects(
    { slice: { ...valid.slice, checkpointAId: "checkpoint-1" }, checkpointA: chainRow(1) },
    /anchor at the worktree's base/,
  );
  rejects({ checkpointB: chainRow(3, { sha: baseSha }) }, /later checkpoint than its base/);
  rejects({ patch: "diff --git a/other b/other\n+other\n" }, /committed workspace file/);
  rejects(
    {
      files: [{ oldPath: "packaged-proof.txt", newPath: "packaged-proof.txt", status: "modified" }],
    },
    /committed workspace file/,
  );
  rejects({ files: [] }, /committed workspace file/);
  rejects({ observation: undefined }, /registered capture/);
  rejects({ observation: { ...observation, captureN: 0 } }, /registered capture/);
  rejects({ observation: { ...observation, source: "worktree", captureN: null } }, /live worktree/);
  assert.throws(() => reviewDiffEvidence(undefined, options), /name its slice/);
});

test("flush evidence matches only this session's completed report", () => {
  const sessionId = "e8f4474e-b96c-4d41-b286-e1a864d966ff";
  const report = (id, outcome, fields) =>
    `[13:41:39.999] INFO (#514) http.span=38039ms: session engine: capture flush · ${outcome} · observed {\n  sessionId: '${id}',\n  worktreeId: '1e252e03-69ca-49c1-88d8-fb7bea04520e',\n  workspaceId: 'aadc6b45-e1c7-4843-b002-2335b58d372c',\n  why: 'checkpoint · turn-boundary',\n  epoch: 2,\n${fields}\n}\n`;
  const complete =
    "  headN: 2,\n  pending: 0,\n  stagedBytes: 0,\n  uploadedObjects: 14,\n  uploadedBytes: 8211,\n  registered: 3,\n  fenced: false,\n  paused: false";
  const log = `noise\n${report("other", "completed", complete)}${report(sessionId, "partial", complete.replace("pending: 0", "pending: 2"))}${report(sessionId, "completed", complete)}`;
  assert.deepEqual(flushReportEvidence(log, sessionId), {
    headN: 2,
    pending: 0,
    registered: 3,
    uploadedObjects: 14,
    fenced: false,
  });
  assert.equal(flushReportEvidence(report("other", "completed", complete), sessionId), false);
  assert.equal(flushReportEvidence(report(sessionId, "partial", complete), sessionId), false);
  assert.equal(
    flushReportEvidence(
      report(sessionId, "completed", complete.replace("fenced: false", "fenced: true")),
      sessionId,
    ),
    false,
  );
  assert.equal(
    flushReportEvidence(
      report(sessionId, "completed", complete.replace("registered: 3", "registered: 0")),
      sessionId,
    ),
    false,
  );
  assert.equal(flushReportEvidence("session engine: capture flush · refused", sessionId), false);
  assert.equal(flushReportEvidence(undefined, sessionId), false);
  assert.equal(flushReportEvidence(log, ""), false);
  assert.throws(
    () => flushReportEvidence(report(sessionId, "completed", "  headN: 2"), sessionId),
    /pending, registered and fenced/,
  );
});

const identityBytes = Buffer.from("SECRET=fixture-only\r\nSECOND=value\n");
const identityHash = createHash("sha256").update(identityBytes).digest("hex");
const ownedVolume = (Name = "mend-store") => ({
  Name,
  Driver: "local",
  CreatedAt: "2026-09-06T00:00:00Z",
  Labels: { [installationOwnerLabel]: identityHash },
});

function volumeOperations(volumes, identity = identityBytes) {
  const calls = [];
  return {
    calls,
    list: async () => volumes.map((volume) => volume.Name),
    identity: async () => identity,
    inspect: async (name) => {
      calls.push(["inspect", name]);
      return volumes.filter((volume) => volume.Name === name);
    },
    remove: async (name) => {
      calls.push(["rm", name]);
      return true;
    },
  };
}

test("startup failure before containers: only matching-owner external volumes are learned and removed", async () => {
  for (const names of [
    ["mend-store"],
    ["mend-store", "mend-control"],
    ["mend-store", "mend-control", "mend-garage"],
  ]) {
    const ledger = createVolumeLedger([], "test-run");
    const external = names.map(ownedVolume);
    const unrelated = [
      ownedVolume("other-data"),
      { ...ownedVolume("concurrent-data"), Labels: { [projectLabel]: "mend" } },
    ];
    ledger.collect([...external, ...unrelated], new Set(), identityBytes);
    assert.deepEqual(ledger.names(), names);
    const operations = volumeOperations([...external, ...unrelated]);
    assert.equal(await cleanupOwnedVolumes(ledger, operations), true);
    assert.deepEqual(
      operations.calls,
      names.flatMap((name) => [
        ["inspect", name],
        ["rm", name],
      ]),
    );
  }
});

test("external ownership refuses missing/empty/mismatched identity and never falls back to Compose labels", async () => {
  for (const bytes of [
    undefined,
    Buffer.alloc(0),
    Buffer.from(identityBytes.toString().trim()),
    Buffer.from("other installation"),
  ]) {
    const ledger = createVolumeLedger([], "test-run");
    const volume = {
      ...ownedVolume(),
      Labels: {
        ...ownedVolume().Labels,
        [projectLabel]: "mend",
        "sh.sealant.mend.acceptance": "test-run",
      },
    };
    ledger.collect([volume], new Set([volume.Name]), bytes);
    assert.equal(ledger.canRemove(volume, bytes), false);
    // A later good identity cannot repair an unproven first observation.
    ledger.collect([volume], new Set([volume.Name]), identityBytes);
    const operations = volumeOperations([volume]);
    await cleanupOwnedVolumes(ledger, operations);
    assert.ok(!operations.calls.some(([command]) => command === "rm"));
  }
  for (const labels of [
    null,
    {},
    { [projectLabel]: "mend" },
    { [installationOwnerLabel]: "other" },
  ]) {
    const ledger = createVolumeLedger([], "test-run");
    const volume = { ...ownedVolume(), Labels: labels };
    ledger.collect([volume], new Set([volume.Name]), identityBytes);
    assert.equal(ledger.canRemove(volume, identityBytes), false);
  }
});

test("the Garage volume is external: owned by the installation label alone, never by Compose evidence", async () => {
  // Setup claims mend-garage before Compose starts, so it carries only the ownership label; the
  // bundle's Garage container then mounts it. v0.27.0's acceptance refused exactly this volume.
  const ledger = createVolumeLedger([], "test-run");
  const garage = ownedVolume("mend-garage");
  ledger.collect([ownedVolume(), ownedVolume("mend-control"), garage], new Set(), identityBytes);
  ledger.collect(
    [ownedVolume(), ownedVolume("mend-control"), garage],
    new Set(["mend-garage"]),
    identityBytes,
  );
  assert.equal(ledger.canRemove(garage, identityBytes), true);
  assert.deepEqual(ledger.names(), ["mend-store", "mend-control", "mend-garage"]);
  const operations = volumeOperations([ownedVolume(), ownedVolume("mend-control"), garage]);
  assert.equal(await cleanupOwnedVolumes(ledger, operations), true);
  assert.deepEqual(
    operations.calls.filter(([command]) => command === "rm").map(([, name]) => name),
    ["mend-store", "mend-control", "mend-garage"],
  );
  // A mend-garage that Compose created (project label, no ownership label) is somebody's data.
  const composeMade = { ...ownedVolume("mend-garage"), Labels: { [projectLabel]: "mend" } };
  const refused = createVolumeLedger([], "test-run");
  refused.collect([composeMade], new Set(["mend-garage"]), identityBytes);
  assert.equal(refused.canRemove(composeMade, identityBytes), false);
  assert.deepEqual(refused.names(), []);
});

test("pre-existing volumes remain unowned even with matching identity or fixture labels", async () => {
  const existing = [
    ownedVolume(),
    { ...ownedVolume("fixture"), Labels: { "sh.sealant.mend.acceptance": "test-run" } },
  ];
  const ledger = createVolumeLedger(existing, "test-run");
  ledger.collect(existing, new Set(existing.map((volume) => volume.Name)), identityBytes);
  const operations = volumeOperations(existing);
  assert.equal(await cleanupOwnedVolumes(ledger, operations), true);
  assert.deepEqual(operations.calls, []);
});

test("changed, lost, or restored identity cannot authorize external-volume cleanup", async () => {
  for (const changed of [undefined, Buffer.alloc(0), Buffer.from("changed identity")]) {
    const ledger = createVolumeLedger([], "test-run");
    const volume = ownedVolume();
    ledger.collect([volume], new Set(), identityBytes);
    const operations = volumeOperations([volume], changed);
    // Explicit undefined should stay unknown rather than using the fixture default.
    operations.identity = async () => changed;
    assert.equal(await cleanupOwnedVolumes(ledger, operations), false);
    assert.equal(ledger.canRemove(volume, identityBytes), false);
    assert.ok(!operations.calls.some(([command]) => command === "rm"));
  }
});

test("cleanup rereads persisted identity before each volume removal", async () => {
  const volumes = [ownedVolume(), ownedVolume("mend-control")];
  const ledger = createVolumeLedger([], "test-run");
  ledger.collect(volumes, new Set(), identityBytes);
  const operations = volumeOperations(volumes);
  let reads = 0;
  operations.identity = async () => (++reads === 1 ? identityBytes : Buffer.from("replacement"));
  assert.equal(await cleanupOwnedVolumes(ledger, operations), false);
  assert.equal(reads, 2);
  assert.deepEqual(operations.calls, [
    ["inspect", "mend-store"],
    ["rm", "mend-store"],
    ["inspect", "mend-control"],
  ]);
});

test("changed snapshots are never relearned, including disappearance and same-name replacement", async () => {
  for (const change of [
    { CreatedAt: "2026-09-07T00:00:00Z" },
    { Labels: { [installationOwnerLabel]: "someone-else" } },
    { Driver: "remote-plugin" },
    { Options: { device: "/other-data" } },
  ]) {
    for (const recollect of [false, true]) {
      const ledger = createVolumeLedger([], "test-run");
      const original = ownedVolume();
      const replacement = { ...original, ...change };
      ledger.collect([original], new Set(), identityBytes);
      if (recollect) ledger.collect([replacement], new Set(), identityBytes);
      const operations = volumeOperations([replacement]);
      assert.equal(await cleanupOwnedVolumes(ledger, operations), false);
      assert.equal(ledger.canRemove(original, identityBytes), false);
      assert.ok(!operations.calls.some(([command]) => command === "rm"));
    }
  }
  const ledger = createVolumeLedger([], "test-run");
  ledger.collect([ownedVolume()], new Set(), identityBytes);
  ledger.collect([], new Set(), identityBytes);
  ledger.collect([ownedVolume()], new Set(), identityBytes);
  assert.equal(ledger.canRemove(ownedVolume(), identityBytes), false);
});

test("Compose and fixture volumes require their own evidence and unchanged snapshots", () => {
  const compose = { ...ownedVolume("mend_mend-config"), Labels: { [projectLabel]: "mend" } };
  const fixture = {
    ...ownedVolume("fixture"),
    Labels: { "sh.sealant.mend.acceptance": "test-run" },
  };
  const foreign = {
    ...fixture,
    Name: "other-fixture",
    Labels: { "sh.sealant.mend.acceptance": "another-run" },
  };
  const ledger = createVolumeLedger([], "test-run");
  ledger.collect([compose, fixture, foreign], new Set(), identityBytes);
  assert.deepEqual(ledger.names(), ["fixture"]);
  ledger.collect([compose, fixture, foreign], new Set([compose.Name]), identityBytes);
  assert.equal(ledger.canRemove(compose, identityBytes), false);
  assert.equal(ledger.canRemove(fixture, identityBytes), true);
  assert.equal(ledger.canRemove(foreign, identityBytes), false);
  const proven = createVolumeLedger([], "test-run");
  proven.collect([compose], new Set([compose.Name]), identityBytes);
  proven.collect([compose], new Set(), identityBytes); // Containers already removed during cleanup.
  assert.equal(proven.canRemove(compose, identityBytes), true);
  assert.equal(proven.canRemove({ ...compose, CreatedAt: "replacement" }, identityBytes), false);
});

test("cleanup retains in-use volumes and fails closed on inspection/list errors", async () => {
  for (const inspected of [
    undefined,
    [],
    [ownedVolume(), ownedVolume()],
    [ownedVolume("wrong-name")],
  ]) {
    const ledger = createVolumeLedger([], "test-run");
    ledger.collect([ownedVolume()], new Set(), identityBytes);
    const operations = volumeOperations([ownedVolume()]);
    operations.inspect = async () => inspected;
    assert.equal(await cleanupOwnedVolumes(ledger, operations), false);
    assert.deepEqual(operations.calls, []);
  }
  const ledger = createVolumeLedger([], "test-run");
  ledger.collect([ownedVolume()], new Set(), identityBytes);
  const operations = volumeOperations([ownedVolume()]);
  operations.remove = async (name) => {
    operations.calls.push(["rm", name]);
    return false;
  };
  assert.equal(await cleanupOwnedVolumes(ledger, operations), false);
  assert.deepEqual(operations.calls, [
    ["inspect", "mend-store"],
    ["rm", "mend-store"],
  ]);
  operations.calls.length = 0;
  operations.list = async () => {
    throw new Error("daemon unavailable");
  };
  await assert.rejects(cleanupOwnedVolumes(ledger, operations), /daemon unavailable/);
  assert.deepEqual(operations.calls, []);
});

test("identity reader uses exact private persisted bytes without requiring active or containers", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "mend-identity-test-"));
  const configRoot = join(scratch, "config");
  await mkdir(configRoot, { mode: 0o700 });
  const file = join(configRoot, "identity.env");
  try {
    assert.equal(await readPrivateIdentity(configRoot), undefined);
    await writeFile(file, "", { mode: 0o600 });
    assert.equal(await readPrivateIdentity(configRoot), undefined);
    await writeFile(file, identityBytes, { mode: 0o600 });
    assert.deepEqual(await readPrivateIdentity(configRoot), identityBytes);
    await chmod(file, 0o644);
    assert.equal(await readPrivateIdentity(configRoot), undefined);
    await chmod(file, 0o600);
    await chmod(configRoot, 0o755);
    assert.equal(await readPrivateIdentity(configRoot), undefined);
    await chmod(configRoot, 0o700);
    await symlink(configRoot, join(scratch, "alias"));
    assert.equal(await readPrivateIdentity(join(scratch, "alias")), undefined);
    await rm(file);
    const foreign = join(scratch, "foreign-identity");
    await writeFile(foreign, identityBytes, { mode: 0o600 });
    await symlink(foreign, file);
    assert.equal(await readPrivateIdentity(configRoot), undefined);
    assert.deepEqual(await readFile(foreign), identityBytes);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("isolated clients clear inherited agents, identities, Git config injection and user XDG paths", () => {
  const inherited = {
    PATH: process.env.PATH,
    HOME: "/user",
    XDG_CONFIG_HOME: "/user/config",
    XDG_DATA_HOME: "/user/data",
    SSH_AUTH_SOCK: "/user/agent",
    MEND_TOKEN: "private",
    MEND_URL: "http://user",
    GIT_CONFIG: "/user/gitconfig",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/user/hooks",
    GIT_CONFIG_PARAMETERS: "injected",
    GIT_CONFIG_GLOBAL: "/user/gitconfig",
    GIT_SSH_COMMAND: "user-ssh",
    GIT_DIR: "/user/repo",
    GH_TOKEN: "private",
    OPENAI_API_KEY: "private",
    NODE_OPTIONS: "--require=user-code",
    DOCKER_CONTEXT: "other-daemon",
    DOCKER_HOST: "tcp://other-daemon",
  };
  const environment = isolatedClientEnvironment(inherited, "/tmp/test-home", "/user/docker");
  assert.equal(environment.HOME, "/tmp/test-home");
  assert.equal(environment.XDG_CONFIG_HOME, "/tmp/test-home/.config");
  assert.equal(environment.XDG_DATA_HOME, "/tmp/test-home/.local/share");
  assert.equal(environment.SSH_AUTH_SOCK, "");
  assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.DOCKER_CONFIG, "/user/docker");
  for (const key of [
    "MEND_TOKEN",
    "MEND_URL",
    "GH_TOKEN",
    "OPENAI_API_KEY",
    "NODE_OPTIONS",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_PARAMETERS",
    "GIT_SSH_COMMAND",
    "GIT_DIR",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
  ])
    assert.equal(environment[key], undefined);
  assert.equal(inherited.SSH_AUTH_SOCK, "/user/agent");
});

test("Docker fingerprint is ordering-independent, secret-free, and detects restart/replacement", () => {
  const first = {
    ...empty(),
    containers: [
      {
        Id: "one",
        Config: { Env: ["TOKEN=secret"] },
        State: { Status: "running", StartedAt: "today" },
        RestartCount: 0,
      },
    ],
    networks: [{ Id: "a" }, { Id: "b" }],
    volumes: [{ Name: "store", CreatedAt: "today" }],
    images: ["z", "a"],
  };
  const original = dockerFingerprint(first);
  assert.doesNotMatch(original, /TOKEN|secret/);
  assert.equal(
    original,
    dockerFingerprint({
      ...first,
      networks: first.networks.toReversed(),
      images: first.images.toReversed(),
    }),
  );
  assert.notEqual(
    original,
    dockerFingerprint({ ...first, containers: [{ ...first.containers[0], RestartCount: 1 }] }),
  );
  assert.notEqual(
    original,
    dockerFingerprint({ ...first, volumes: [{ Name: "store", CreatedAt: "tomorrow" }] }),
  );
});

const healthContainerId = "a".repeat(64);
const healthExecId = "b".repeat(64);
const eventWindow = {
  captureSince: "2026-09-06T00:00:00.000Z",
  since: "2026-09-06T00:01:00.000Z",
  until: "2026-09-06T00:01:10.000Z",
  captureUntil: "2026-09-06T00:01:15.000Z",
};
const healthInventory = (Test = ["CMD-SHELL", "pg_isready -U mend -d mend"], Shell) => ({
  ...empty(),
  containers: [{ Id: healthContainerId, Config: { Healthcheck: { Test }, Shell } }],
});
const healthEvent = (
  Action,
  offset = 61,
  execID = healthExecId,
  container = healthContainerId,
) => ({
  Type: "container",
  Action,
  Actor: {
    ID: container,
    Attributes: { execID, ...(Action === "exec_die" ? { exitCode: "0" } : {}) },
  },
  timeNano: String(
    BigInt(Date.parse(eventWindow.captureSince)) * 1_000_000n + BigInt(offset) * 1_000_000_000n,
  ),
});
const healthSequence = (
  command = "/bin/sh -c pg_isready -U mend -d mend",
  offsets = [61, 62, 63],
) =>
  [`exec_create: ${command}`, `exec_start: ${command}`, "exec_die"].map((action, index) =>
    healthEvent(action, offsets[index]),
  );
const assertEvents = (events, inventory = healthInventory(), window = eventWindow) =>
  assertInstallDockerEvents(
    events.map((event) => JSON.stringify(event)).join("\n"),
    inventory,
    window,
  );

// Synthetic fixtures only. Failure messages must never include real command text or IDs.
function rejectsEvents(events, inventory = healthInventory(), window = eventWindow) {
  assert.throws(
    () => assertEvents(events, inventory, window),
    (error) => {
      assert.match(error.message, /Docker install events inconclusive/);
      assert.doesNotMatch(error.message, /pg_isready|private-token|aaaaaaaa|bbbbbbbb/);
      return true;
    },
  );
}

test("install events permit exact CMD, default CMD-SHELL and configured-shell healthcheck chains", () => {
  assert.deepEqual(assertEvents([]), { healthchecks: 0 });
  for (const [declaredTest, shell, command] of [
    [
      ["CMD-SHELL", "pg_isready -U mend -d mend"],
      undefined,
      "/bin/sh -c pg_isready -U mend -d mend",
    ],
    [["CMD-SHELL", "pg_isready -U mend -d mend"], [], "/bin/sh -c pg_isready -U mend -d mend"],
    [
      ["CMD", "node", "-e", "fetch('http://localhost/health')"],
      undefined,
      "node -e fetch('http://localhost/health')",
    ],
    [
      ["CMD-SHELL", "test -f /healthy"],
      ["/bin/bash", "-o", "pipefail", "-c"],
      "/bin/bash -o pipefail -c test -f /healthy",
    ],
  ]) {
    assert.deepEqual(assertEvents(healthSequence(command), healthInventory(declaredTest, shell)), {
      healthchecks: 1,
    });
  }
  const concurrent = healthSequence().flatMap((event) => [
    event,
    {
      ...event,
      Actor: { ...event.Actor, Attributes: { ...event.Actor.Attributes, execID: "c".repeat(64) } },
    },
  ]);
  assert.deepEqual(assertEvents(concurrent), { healthchecks: 2 });
  const unhealthy = healthSequence();
  unhealthy[2].Actor.Attributes.exitCode = "1";
  assert.deepEqual(assertEvents(unhealthy), { healthchecks: 1 });
});

test("bounded context correlates edge-crossing healthchecks without asserting out-of-window activity", () => {
  for (const offsets of [
    [58, 59, 61],
    [59, 61, 62],
    [68, 69, 72],
    [69, 71, 72],
  ])
    assert.deepEqual(assertEvents(healthSequence(undefined, offsets)), { healthchecks: 1 });
  const outside = [healthEvent("restart", 1), healthEvent("destroy", 70)];
  assert.deepEqual(assertEvents(outside), { healthchecks: 0 });
  rejectsEvents([healthEvent("restart", 60)]); // Inclusive start, exclusive end.
  rejectsEvents([healthSequence()[2]]); // No create/start inside the lookback.
  rejectsEvents(healthSequence().slice(0, 2)); // No die before the bounded capture ends.
});

test("install events reject mutation, unknown resources and undeclared exec commands", () => {
  for (const action of [
    "create",
    "destroy",
    "remove",
    "restart",
    "start",
    "stop",
    "die",
    "kill",
    "pause",
    "unpause",
    "update",
    "rename",
    "health_status: healthy",
    "unknown",
  ])
    rejectsEvents([healthEvent(action)]);
  for (const Type of ["image", "volume", "network", "daemon", "unknown"])
    rejectsEvents([{ ...healthSequence()[0], Type }]);
  rejectsEvents(
    healthSequence().map((event) => ({ ...event, Actor: { ...event.Actor, ID: "d".repeat(64) } })),
  );
  for (const command of [
    "/bin/sh -c pg_isready -U mend -d mend; touch /private-token",
    "pg_isready -U mend -d mend",
    "/bin/sh -c  pg_isready -U mend -d mend",
    "node -e private-token",
    "rm -rf /data",
  ])
    rejectsEvents(healthSequence(command));
  for (const Test of [
    undefined,
    [],
    ["NONE"],
    ["CMD"],
    ["CMD", ""],
    ["BOGUS", "x"],
    ["CMD-SHELL", "x", "extra"],
    ["CMD", 123],
  ])
    rejectsEvents(healthSequence(), healthInventory(Test === undefined ? null : Test));
  for (const shell of ["/bin/sh -c", [12], ["/bin/bash", "-c"]])
    rejectsEvents(healthSequence(), healthInventory(undefined, shell));
});

test("install events reject unmatched, reused, cross-container and malformed exec IDs", () => {
  for (const index of [0, 1, 2]) {
    const events = healthSequence();
    events[index].Actor.Attributes.execID = "c".repeat(64);
    rejectsEvents(events);
  }
  for (const execID of [undefined, "", "short", 123, `${healthExecId}\n`]) {
    const events = healthSequence();
    events[0].Actor.Attributes.execID = execID;
    rejectsEvents(events);
  }
  const events = healthSequence();
  events[1].Actor.ID = "d".repeat(64);
  const inventory = healthInventory();
  inventory.containers.push({ ...inventory.containers[0], Id: "d".repeat(64) });
  rejectsEvents(events, inventory);
  rejectsEvents([healthSequence()[0], ...healthSequence()]);
  rejectsEvents([healthSequence()[1], healthSequence()[2]]);
  rejectsEvents([healthSequence()[0], healthSequence()[2]]);
  rejectsEvents([...healthSequence(), healthSequence(undefined, [64, 65, 66])[2]]);
  rejectsEvents([...healthSequence(), ...healthSequence(undefined, [64, 65, 66])]);
  const wrongStart = healthSequence();
  wrongStart[1].Action += " private-token";
  rejectsEvents(wrongStart);
});

test("install event parsing fails closed on malformed data, timestamps, windows and full history", () => {
  for (const malformed of [
    null,
    [],
    {},
    { ...healthSequence()[0], Actor: null },
    { ...healthSequence()[0], Actor: { ID: healthContainerId, Attributes: [] } },
    { ...healthSequence()[0], timeNano: 123 },
    { ...healthSequence()[0], timeNano: "bad" },
    { ...healthSequence()[0], timeNano: `${healthSequence()[0].timeNano}\n` },
    { ...healthSequence()[0], timeNano: "9".repeat(50) },
  ])
    rejectsEvents([malformed]);
  for (const exitCode of [undefined, "unknown", 0, "0\n"]) {
    const events = healthSequence();
    events[2].Actor.Attributes.exitCode = exitCode;
    rejectsEvents(events);
  }
  for (const text of ["private-token invalid JSON", "{", undefined])
    assert.throws(
      () => assertInstallDockerEvents(text, healthInventory(), eventWindow),
      /inconclusive/,
    );
  rejectsEvents(healthSequence().toReversed());
  rejectsEvents([healthEvent("restart", -1)]);
  rejectsEvents([healthEvent("restart", 75)]);
  rejectsEvents([], healthInventory(), { ...eventWindow, since: "bad" });
  rejectsEvents([], healthInventory(), { ...eventWindow, until: eventWindow.captureSince });
  rejectsEvents([], healthInventory(), { ...eventWindow, captureSince: "2026-09-05T23:00:00Z" });
  rejectsEvents([], { containers: [null] });
  rejectsEvents([], { containers: [{ Id: `${healthContainerId}\n` }] });
  rejectsEvents([], healthInventory(), { ...eventWindow, until: eventWindow.since });
  rejectsEvents([], {
    containers: [...healthInventory().containers, ...healthInventory().containers],
  });
  rejectsEvents(Array.from({ length: 256 }, () => healthEvent("restart", 1)));
});

test("private FAILED diagnostics preserve raw bytes with restrictive modes and delete on success", async () => {
  const diagnostics = createFailedCommandDiagnostics();
  assert.equal(await diagnostics.finish(true), undefined);
  const raw = Buffer.from([0, 255, 13, 10, 65]);
  let root;
  try {
    await diagnostics.record(
      { command: "synthetic", args: ["private-token"], code: 17 },
      raw,
      Buffer.from("private-stderr"),
    );
    root = await diagnostics.finish(true);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(root)).toSorted(), [
      "FAILED-1.json",
      "FAILED-1.stderr",
      "FAILED-1.stdout",
    ]);
    for (const name of await readdir(root))
      assert.equal((await lstat(join(root, name))).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(join(root, "FAILED-1.stdout")), raw);
    assert.equal(await readFile(join(root, "FAILED-1.stderr"), "utf8"), "private-stderr");
    assert.equal(await diagnostics.finish(false), undefined);
    await assert.rejects(lstat(root), { code: "ENOENT" });
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
});

const inputs = (version = "0.23.0") => ({
  MEND_TEST_UPGRADE_IMAGE: `ghcr.io/sealant-sh/mend:${version}`,
  MEND_TEST_UPGRADE_VERSION: version,
});

test("upgrade inputs are optional, paired, canonical and strictly newer, with current assets by default", () => {
  const baseline = "0.0.0-acceptance.123.2";
  assert.equal(readUpgradeInputs({}, "/assets", baseline), undefined);
  assert.deepEqual(readUpgradeInputs(inputs(), "/assets", baseline), {
    image: "ghcr.io/sealant-sh/mend:0.23.0",
    version: "0.23.0",
    assets: "/assets",
  });
  assert.equal(
    readUpgradeInputs({ ...inputs(), MEND_TEST_UPGRADE_ASSETS: "/target" }, "/assets", baseline)
      .assets,
    "/target",
  );
  for (const invalid of [
    { MEND_TEST_UPGRADE_IMAGE: inputs().MEND_TEST_UPGRADE_IMAGE },
    { MEND_TEST_UPGRADE_VERSION: "0.23.0" },
    { MEND_TEST_UPGRADE_ASSETS: "/orphan" },
    { ...inputs(), MEND_TEST_UPGRADE_ASSETS: "" },
    { ...inputs(), MEND_TEST_UPGRADE_IMAGE: "other/mend:0.23.0" },
    { ...inputs(), MEND_TEST_UPGRADE_IMAGE: "ghcr.io/sealant-sh/mend:latest" },
    ...[
      "",
      "latest",
      "01.2.3",
      "0.23.0-01",
      "0.23.0-",
      "0.23.0+build",
      "0.0.0-acceptance.123.2",
      "0.0.0-acceptance.123.1",
    ].map(inputs),
  ])
    assert.throws(() => readUpgradeInputs(invalid, "/assets", baseline));
  for (const [older, newer] of [
    ["1.9.0", "1.10.0"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-rc.1", "1.0.0"],
    ["1.0.0-1", "1.0.0-alpha"],
    ["1.0.0-alpha", "1.0.0-beta"],
  ]) {
    assert.doesNotThrow(() => readUpgradeInputs(inputs(newer), "/assets", older));
    assert.throws(() => readUpgradeInputs(inputs(older), "/assets", newer));
  }
});

test("image pin evidence rejects retags and runtime-only health version overrides", () => {
  const version = "0.23.0";
  const tag = `ghcr.io/sealant-sh/mend:${version}`;
  const image = {
    Id: "sha256:target",
    Config: {
      Env: [`MEND_VERSION=${version}`],
      Labels: { "org.opencontainers.image.version": version },
    },
  };
  const container = { Image: image.Id, Config: { Image: tag, Env: image.Config.Env } };
  assert.doesNotThrow(() => assertImagePin(container, image, tag, version));
  for (const candidate of [
    { ...image, Id: "sha256:other" },
    { ...image, Config: { ...image.Config, Labels: {} } },
    { ...image, Config: { ...image.Config, Env: ["MEND_VERSION=old"] } },
  ])
    assert.throws(() => assertImagePin(container, candidate, tag, version));
  assert.throws(() =>
    assertImagePin(
      { ...container, Config: { ...container.Config, Image: "alias" } },
      image,
      tag,
      version,
    ),
  );
});

test("upgrade retention changes only the generation and pin, never credentials or deployment", () => {
  const previous = {
    target: "old",
    identity: "digest",
    config: { serverVersion: "0.1.0", appPort: 1234 },
    serverEnv: "SECRET=do-not-print\nMEND_VERSION=0.1.0\nOTHER=0.1.0\n",
  };
  const target = {
    ...previous,
    target: "new",
    config: { ...previous.config, serverVersion: "0.2.0" },
    serverEnv: previous.serverEnv.replace("MEND_VERSION=0.1.0", "MEND_VERSION=0.2.0"),
  };
  assert.doesNotThrow(() => assertUpgradeRetention(previous, target));
  for (const candidate of [
    { ...target, target: previous.target },
    { ...target, identity: "changed" },
    { ...target, config: { ...target.config, appPort: 4321 } },
    { ...target, serverEnv: target.serverEnv.replace("do-not-print", "changed-secret") },
    { ...target, serverEnv: target.serverEnv.replace("OTHER=0.1.0", "OTHER=0.2.0") },
  ])
    assert.throws(
      () => assertUpgradeRetention(previous, candidate),
      (error) => {
        assert.doesNotMatch(String(error), /do-not-print|changed-secret/);
        return true;
      },
    );
});

test("UpgradeFailure at the public CLI invocation boundary propagates with ownership collection and no retry/rollback", async () => {
  const failure = new Error("UpgradeFailure");
  const calls = [];
  await assert.rejects(
    runPackagedUpgrade(
      { version: "0.2.0", assets: "/target assets" },
      true,
      async (args, options) => {
        calls.push([args, options]);
        throw failure;
      },
      async () => {
        calls.push("collect-owned");
      },
    ),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [
    [
      ["server", "upgrade", "--version", "0.2.0", "--assets-dir", "/target assets", "--offline"],
      { timeout: 600_000 },
    ],
    "collect-owned",
  ]);
  calls.length = 0;
  await runPackagedUpgrade(
    { version: "0.2.0", assets: "/target" },
    false,
    async (args) => {
      calls.push(args);
    },
    async () => {
      calls.push("collect-owned");
    },
  );
  assert.ok(!calls[0].includes("--offline"));
  assert.equal(calls[1], "collect-owned");
  // This tests acceptance's command boundary only. It does not simulate a successful
  // product upgrade or establish product target-startup recovery behavior.
});

test("refusal diagnostics match across chunks without returning raw stderr", () => {
  const probe = createDiagnosticProbe("Refusing downgrade");
  probe.accept(Buffer.from("secret-before\nRefusing down"));
  assert.equal(probe.matched(), false);
  probe.accept(Buffer.from("grade\nsecret-after"));
  assert.equal(probe.matched(), true);
  assert.doesNotMatch(JSON.stringify(probe), /secret/);
  const unrelated = createDiagnosticProbe("Refusing downgrade");
  unrelated.accept(Buffer.from("permission denied"));
  assert.equal(unrelated.matched(), false);
  const disabled = createDiagnosticProbe();
  disabled.accept(Buffer.from("Refusing downgrade"));
  assert.equal(disabled.matched(), false);
});

test("real backup reader requires private complete cluster SQL, roles and exact recovery links", async () => {
  const root = await mkdtemp(join(tmpdir(), "mend-backup-test-"));
  const backups = join(root, "backups");
  const directory = join(backups, "upgrade-11111111-1111-4111-8111-111111111111");
  const sqlFile = join(directory, "database.sql");
  const recoveryFile = join(directory, "recovery.json");
  const sql = [
    "CREATE DATABASE mend WITH TEMPLATE = template0;",
    "CREATE DATABASE sealant_control_plane WITH TEMPLATE = template0;",
    "CREATE ROLE mend;",
    "CREATE ROLE sealant;",
    "CREATE ROLE postgres;",
    "-- PostgreSQL database cluster dump complete",
    "",
  ].join("\n");
  const recovery = JSON.stringify({
    previousGeneration: "/old",
    targetGeneration: "/target",
    database: "database.sql",
  });
  const verify = () => verifyUpgradeBackup(root, "/old", "/target");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(sqlFile, sql, { mode: 0o600 });
    await writeFile(recoveryFile, recovery, { mode: 0o600 });
    await verify();
    const before = await privateTreeFingerprint(root);
    assert.match(before, /^[a-f0-9]{64}$/);
    for (const omitted of [
      "CREATE DATABASE mend",
      "CREATE DATABASE sealant_control_plane",
      "CREATE ROLE mend",
      "CREATE ROLE sealant",
      "CREATE ROLE postgres",
      "dump complete",
    ]) {
      await writeFile(
        sqlFile,
        sql
          .split("\n")
          .filter((line) => !line.includes(omitted))
          .join("\n"),
      );
      await assert.rejects(verify);
      assert.notEqual(await privateTreeFingerprint(root), before);
    }
    await writeFile(sqlFile, sql);
    await writeFile(recoveryFile, recovery.replace("/old", "/wrong"));
    await assert.rejects(verify);
    await writeFile(recoveryFile, recovery);
    await writeFile(join(directory, "database.sql.partial"), "secret-partial", { mode: 0o600 });
    await assert.rejects(verify, /no partial/);
    await rm(join(directory, "database.sql.partial"));
    for (const path of [backups, directory, sqlFile, recoveryFile]) {
      await chmod(path, path === backups || path === directory ? 0o755 : 0o644);
      await assert.rejects(verify, /private/);
      await chmod(path, path === backups || path === directory ? 0o700 : 0o600);
    }
    await verify();
    assert.equal(await privateTreeFingerprint(root), before);
    await rm(sqlFile);
    const foreign = join(root, "foreign-sql");
    await writeFile(foreign, sql, { mode: 0o600 });
    await symlink(foreign, sqlFile);
    await assert.rejects(verify, /regular files/);
    const linked = await privateTreeFingerprint(root);
    await rm(sqlFile);
    await symlink("/nonexistent-outside-test", sqlFile);
    assert.notEqual(await privateTreeFingerprint(root), linked);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture serves a real network Git clone without host sharing or traversal", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "mend-git-fixture-test-"));
  const root = join(scratch, "http");
  await mkdir(root);
  const source = join(scratch, "source");
  await mkdir(source);
  const home = join(scratch, "home");
  await mkdir(home);
  // A user's signing/hook settings or injected Git environment must not reach fixture Git.
  const hostileConfig = "[commit]\n gpgsign = true\n[core]\n hooksPath = /not-a-test-hook\n";
  await writeFile(join(home, ".gitconfig"), hostileConfig);
  const env = isolatedClientEnvironment(
    {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "true",
      GIT_DIR: "/not-the-fixture",
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      SSH_AUTH_SOCK: "/user/agent.sock",
    },
    home,
  );
  const git = (args, cwd = source) => exec("git", args, { cwd, env });
  const server = gitFixtureServer(root);
  try {
    await git(["init", "-b", "main"]);
    await writeFile(join(source, "README.md"), "fixture content\n");
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Acceptance",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["clone", "--bare", source, join(root, "repo.git")]);
    await git(["update-server-info"], join(root, "repo.git"));
    await writeFile(join(scratch, "private"), "not served");
    await symlink(join(scratch, "private"), join(root, "escape"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const clone = join(scratch, "clone");
    await git(["clone", `${origin}/repo.git`, clone]);
    assert.equal((await git(["rev-parse", "HEAD"], clone)).stdout.trim(), sha);
    assert.equal(await readFile(join(clone, "README.md"), "utf8"), "fixture content\n");
    assert.equal(await readFile(join(home, ".gitconfig"), "utf8"), hostileConfig);
    for (const path of ["/escape", "/%2e%2e%2fprivate", "/repo.git", "/missing", "/%invalid"]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 404);
      await response.body?.cancel();
    }
    const denied = await fetch(`${origin}/repo.git/HEAD`, {
      method: "POST",
      body: "do not change Git",
    });
    assert.equal(denied.status, 405);
    await denied.body?.cancel();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
