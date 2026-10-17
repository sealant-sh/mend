// Real processes and kernel locks against the isolated fake Docker daemon.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { STACK_LABEL, STATE_VOLUME } from "./lib.mjs";
import {
  roots,
  volume,
  daemon,
  ownerOf,
  names,
  volumeNames,
  generation,
  callsOf,
  COMPOSE,
  WORKING_DIR,
  STATE_MOUNT,
  on,
  mounts,
  product,
  productNames,
  ledgerDirOf,
  ledger,
  ledgerWindows,
} from "./lifecycle.e2e.helpers.mjs";

for (const resource of [STATE_VOLUME, "sealant-5e55", "mend-store"]) {
  test(`a removal failure keeps the records for retry: ${resource}`, async () => {
    const copyPath = `/fake/volumes/${STATE_VOLUME}/_data/ledger.json`;
    const fakeDaemon = daemon({
      containers: [...generation("retry-cleanup"), ["sealant-5e55", {}, mounts("mend-control")]],
      volumes: [STATE_VOLUME, volume("mend-store", {}, "2026-10-10T01:00:00Z")],
    });
    const owner = ownerOf(fakeDaemon.read());
    const recorded = fakeDaemon.read().containers.find((item) => item.Name === "/sealant-5e55");
    const entries = {
      containers: [recorded.Id],
      volumes: [{ name: "mend-store", createdAt: "2026-10-10T01:00:00Z" }],
      networks: [],
    };
    ledger(fakeDaemon, entries);
    const ledgerFile = join(ledgerDirOf(fakeDaemon), "window.json");
    const localLedger = readFileSync(ledgerFile, "utf8");
    const stateFile = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "stack.json");
    const savedState = JSON.stringify({ daemon: ledgerDirOf(fakeDaemon).split("/").at(-1) });
    writeFileSync(stateFile, savedState, { mode: 0o600 });
    const before = fakeDaemon.read();
    const volumeLedger = JSON.stringify(entries);
    before.files[copyPath] = volumeLedger;
    writeFileSync(fakeDaemon.file("state.json"), JSON.stringify(before));
    writeFileSync(fakeDaemon.file("fail-rm"), resource);

    const failed = fakeDaemon.run(["down"]);
    assert.notEqual(await failed.done, 0, failed.output());
    assert.match(
      failed.output(),
      /could not remove .*the ledger is kept, so the next down tries again/,
    );
    const remaining = fakeDaemon.read();
    assert.deepEqual(ownerOf(remaining), owner, "the same generation still holds the daemon");
    assert.ok(volumeNames(remaining).includes(STATE_VOLUME), "the retry state volume remains");
    if (resource === "sealant-5e55")
      assert.ok(
        remaining.containers.some((item) => item.Id === recorded.Id),
        "failed container remains",
      );
    else assert.ok(volumeNames(remaining).includes(resource), "failed volume remains");
    assert.equal(readFileSync(ledgerFile, "utf8"), localLedger, "the local ledger is unchanged");
    assert.equal(readFileSync(stateFile, "utf8"), savedState, "the local state is unchanged");
    assert.equal(remaining.files[copyPath], volumeLedger, "the volume ledger is unchanged");

    rmSync(fakeDaemon.file("fail-rm"));
    const retried = fakeDaemon.run(["down"]);
    assert.equal(await retried.done, 0, retried.output());
    assert.deepEqual(
      names(fakeDaemon.read()),
      [],
      "retry removed the owner and remaining containers",
    );
    assert.deepEqual(volumeNames(fakeDaemon.read()), [], "retry removed remaining volumes");
    assert.equal(existsSync(ledgerDirOf(fakeDaemon)), false, "retry removed the local ledger");
    assert.equal(existsSync(stateFile), false, "retry removed the local state");
  });
}

for (const { args, owned } of [
  { args: ["down"], owned: true },
  { args: ["down", "--force"], owned: true },
  { args: ["down", "--force"], owned: false },
]) {
  test(
    `${args.join(" ")} refuses a failed ledger read before removal, then retries (${owned ? "owned" : "orphaned"})`,
    { timeout: 20_000 },
    async () => {
      const copyPath = `/fake/volumes/${STATE_VOLUME}/_data/ledger.json`;
      const volumeLedger = JSON.stringify({
        containers: [],
        volumes: [{ name: "mend-store", createdAt: "2026-10-10T01:00:00Z" }],
        networks: ["recorded-network"],
      });
      const fakeDaemon = daemon({
        containers: [
          ...(owned
            ? generation("ledger-read-retry")
            : [["verify-stack-relay", { [STACK_LABEL]: "1" }]]),
          ["sealant-5e55", {}, mounts("mend-control")],
          ["person-database", {}],
        ],
        volumes: [STATE_VOLUME, volume("mend-store", {}, "2026-10-10T01:00:00Z"), "person-data"],
        networks: [{ Id: "recorded-network", Name: "sealant-5e55-network", Labels: {} }],
        files: { [copyPath]: volumeLedger },
      });
      const before = fakeDaemon.read();
      const recorded = before.containers.find((item) => item.Name === "/sealant-5e55");
      assert.ok(recorded, "fixture has the locally recorded executor");
      ledger(fakeDaemon, { containers: [recorded.Id] });
      const ledgerFile = join(ledgerDirOf(fakeDaemon), "window.json");
      const localLedger = readFileSync(ledgerFile, "utf8");
      const stateFile = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "stack.json");
      const savedState = JSON.stringify({ daemon: ledgerDirOf(fakeDaemon).split("/").at(-1) });
      writeFileSync(stateFile, savedState, { mode: 0o600 });
      writeFileSync(
        fakeDaemon.file("fail-ledger-read"),
        JSON.stringify({
          stdout: "partial-private-ledger-output",
          stderr: "private-ledger-read-error-token",
        }),
      );

      const failed = fakeDaemon.run(args);
      const code = await failed.done;
      const calls = readFileSync(fakeDaemon.file("state.json.calls"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        calls.filter(
          (call) => call[0] === "run" && call.some((arg) => arg.includes("/state/ledger.json")),
        ).length,
        1,
        "the state-volume read was attempted",
      );
      assert.equal(code, 1, failed.output());
      assert.match(
        failed.output(),
        /the state volume's ledger could not be read; nothing was removed/,
      );
      assert.match(failed.output(), /The ledger and state are kept, so the next down tries again/);
      assert.doesNotMatch(
        failed.output(),
        /partial-private-ledger-output|private-ledger-read-error-token/,
      );
      assert.deepEqual(
        calls.filter(
          (call) =>
            call[0] === "rm" || (["volume", "network"].includes(call[0]) && call[1] === "rm"),
        ),
        [],
        "no stack resource removal was attempted",
      );
      assert.deepEqual(
        fakeDaemon.read(),
        before,
        "every resource, owner and volume ledger remains unchanged",
      );
      assert.equal(readFileSync(ledgerFile, "utf8"), localLedger);
      assert.equal(readFileSync(stateFile, "utf8"), savedState);

      rmSync(fakeDaemon.file("fail-ledger-read"));
      const retried = fakeDaemon.run(args);
      assert.equal(await retried.done, 0, retried.output());
      const remaining = fakeDaemon.read();
      assert.deepEqual(names(remaining), ["person-database"]);
      assert.deepEqual(volumeNames(remaining), ["person-data"]);
      assert.deepEqual(remaining.networks, []);
      assert.equal(ownerOf(remaining), undefined);
      assert.equal(existsSync(ledgerDirOf(fakeDaemon)), false);
      assert.equal(existsSync(stateFile), false);
    },
  );
}

for (const args of [["down"], ["down", "--force"]]) {
  test(
    `${args.join(" ")} accepts a successful read with no state-volume ledger file`,
    { timeout: 20_000 },
    async () => {
      const fakeDaemon = daemon({
        containers: [...generation("absent-copy"), ["sealant-5e55", {}, mounts("mend-control")]],
        volumes: [STATE_VOLUME],
      });
      const recorded = fakeDaemon.read().containers.find((item) => item.Name === "/sealant-5e55");
      assert.ok(recorded);
      ledger(fakeDaemon, { containers: [recorded.Id] });
      const down = fakeDaemon.run(args);
      assert.equal(await down.done, 0, down.output());
      assert.deepEqual(names(fakeDaemon.read()), []);
      assert.deepEqual(volumeNames(fakeDaemon.read()), []);
      assert.equal(existsSync(ledgerDirOf(fakeDaemon)), false);
    },
  );
}

test(
  "the ledger reader's production shell distinguishes real file absence from inaccessible or nonregular paths",
  { timeout: 20_000 },
  async () => {
    const fakeDaemon = daemon({ containers: generation("shell-reader"), volumes: [STATE_VOLUME] });
    const down = fakeDaemon.run(["down"]);
    assert.equal(await down.done, 0, down.output());
    const readers = callsOf(fakeDaemon).filter(
      (args) =>
        args[0] === "run" &&
        args.includes("--entrypoint") &&
        args.some((arg) => arg.includes("/state/ledger.json")),
    );
    assert.equal(readers.length, 1);
    const script = readers[0].at(-1);
    const root = mkdtempSync(join(tmpdir(), "verify-stack-ledger-shell-"));
    roots.push(root);
    chmodSync(root, 0o755);
    const cases = [
      "absent",
      "regular",
      "unreadable-file",
      "unsearchable-directory",
      "unreadable-directory",
      "directory",
      "broken-symlink",
      "symlink",
      "empty",
      "whitespace",
    ];
    const results = [];
    for (const kind of cases) {
      const directory = join(root, kind);
      const file = join(directory, "ledger.json");
      mkdirSync(directory, { mode: 0o755 });
      if (
        ["regular", "unreadable-file", "unsearchable-directory", "unreadable-directory"].includes(
          kind,
        )
      )
        writeFileSync(file, "{}\n", { mode: 0o644 });
      if (kind === "unreadable-file") chmodSync(file, 0o000);
      if (kind === "unsearchable-directory") chmodSync(directory, 0o644);
      if (kind === "unreadable-directory") chmodSync(directory, 0o111);
      if (kind === "directory") mkdirSync(file);
      if (kind === "broken-symlink") symlinkSync(join(directory, "missing"), file);
      if (kind === "symlink") {
        writeFileSync(join(directory, "target"), "{}\n", { mode: 0o644 });
        symlinkSync(join(directory, "target"), file);
      }
      if (kind === "empty") writeFileSync(file, "", { mode: 0o644 });
      if (kind === "whitespace") writeFileSync(file, " \n", { mode: 0o644 });
      try {
        // Only substitute the mount's path. The reader script itself is the real CLI's argv.
        const result = spawnSync(
          "sh",
          ["-c", script.replaceAll("/state", '"$1"'), "ledger-reader", directory],
          {
            encoding: "utf8",
            timeout: 5000,
            env: { PATH: process.env.PATH, LC_ALL: "C" },
            ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
          },
        );
        assert.equal(result.error, undefined);
        results.push({ kind, status: result.status, stdout: result.stdout });
      } finally {
        chmodSync(directory, 0o755);
      }
    }
    assert.deepEqual(
      results,
      cases.map((kind) => ({
        kind,
        status: ["absent", "regular", "empty", "whitespace"].includes(kind) ? 0 : 1,
        stdout:
          kind === "absent"
            ? '{"containers":[],"volumes":[],"networks":[]}\n'
            : kind === "regular"
              ? "{}\n"
              : kind === "whitespace"
                ? " \n"
                : "",
      })),
    );
  },
);

for (const [kind, copy] of [
  ["empty", ""],
  ["whitespace", " \n"],
  ["malformed-private", "private-data"],
]) {
  test(
    `a present ${kind} ledger copy refuses teardown and retains its records`,
    { timeout: 20_000 },
    async () => {
      const copyPath = `/fake/volumes/${STATE_VOLUME}/_data/ledger.json`;
      const fakeDaemon = daemon({
        containers: generation("invalid-copy"),
        volumes: [STATE_VOLUME],
        files: { [copyPath]: copy },
      });
      ledger(fakeDaemon, {});
      const ledgerFile = join(ledgerDirOf(fakeDaemon), "window.json");
      const beforeLedger = readFileSync(ledgerFile, "utf8");
      const stateFile = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "stack.json");
      const savedState = JSON.stringify({ daemon: ledgerDirOf(fakeDaemon).split("/").at(-1) });
      writeFileSync(stateFile, savedState, { mode: 0o600 });
      const before = fakeDaemon.read();
      const down = fakeDaemon.run(["down", "--force"]);
      assert.equal(await down.done, 1, down.output());
      assert.doesNotMatch(down.output(), /private-data/);
      assert.match(
        down.output(),
        /the state volume's ledger.json cannot be read \(invalid ledger JSON\); nothing was removed/,
      );
      assert.deepEqual(fakeDaemon.read(), before);
      assert.equal(readFileSync(ledgerFile, "utf8"), beforeLedger);
      assert.equal(readFileSync(stateFile, "utf8"), savedState);
      assert.deepEqual(
        callsOf(fakeDaemon).filter(
          (args) =>
            args[0] === "rm" || (["volume", "network"].includes(args[0]) && args[1] === "rm"),
        ),
        [],
      );
      // The printed recovery command moves the invalid copy aside instead of deleting its evidence.
      const repaired = fakeDaemon.read();
      repaired.files[`${copyPath}.bad`] = repaired.files[copyPath];
      delete repaired.files[copyPath];
      writeFileSync(fakeDaemon.file("state.json"), JSON.stringify(repaired));
      const retry = fakeDaemon.run(["down", "--force"]);
      assert.equal(await retry.done, 0, retry.output());
      assert.deepEqual(names(fakeDaemon.read()), []);
      assert.deepEqual(volumeNames(fakeDaemon.read()), []);
      assert.equal(existsSync(ledgerDirOf(fakeDaemon)), false);
      assert.equal(existsSync(stateFile), false);
    },
  );
}

test("down --force on a daemon with no stack of its own removes nothing of a product server (N13)", async () => {
  const fakeDaemon = daemon(product);
  const before = fakeDaemon.read();
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.equal(await sweep.done, 0, sweep.output());
  assert.match(sweep.output(), /removed 0 container\(s\), 0 volume\(s\)/);
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), names(before));
  assert.deepEqual(volumeNames(left), volumeNames(before));
  assert.deepEqual(left.networks, before.networks);
  // Reported, with how to remove them by hand, and never touched.
  assert.match(
    sweep.output(),
    /left alone \(shaped like the stack's, but never recorded as made by it\): container mend-mend-1/,
  );
  assert.match(sweep.output(), /docker volume rm .*mend-store/);
});

test("down --force with no ledger removes only the stack's own infrastructure (N13)", async () => {
  const fakeDaemon = daemon({
    ...product,
    containers: [...product.containers, ["verify-stack-relay", { [STACK_LABEL]: "1" }]],
    volumes: [...product.volumes, STATE_VOLUME],
  });
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.equal(await sweep.done, 0, sweep.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), productNames);
  assert.deepEqual(volumeNames(left), volumeNames(product));
  assert.deepEqual(left.networks, product.networks);
});

test("a Compose path under the state volume's Mountpoint proves nothing (N13a)", async () => {
  // A Compose client with a file system of its own wrote its file under the same path.
  const fakeDaemon = daemon({
    containers: [
      [
        "product-real-compose",
        { [COMPOSE]: "mend", [WORKING_DIR]: `${STATE_MOUNT}/product-generation` },
        mounts("product-real-compose-data"),
      ],
      [
        "product-traversal",
        { [COMPOSE]: "mend", [WORKING_DIR]: `${STATE_MOUNT}/../../product/generation` },
        mounts("product-traversal-data"),
      ],
    ],
    volumes: [STATE_VOLUME, "product-real-compose-data", "product-traversal-data"],
  });
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.equal(await sweep.done, 0, sweep.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), ["product-real-compose", "product-traversal"]);
  assert.deepEqual(volumeNames(left), ["product-real-compose-data", "product-traversal-data"]);
});

test("a shared network pulls nothing in: not a product executor, its network or its data (N13b)", async () => {
  const shared = ["shared-product-network", "net-shared"];
  const fakeDaemon = daemon({
    containers: [
      ["verify-stack-relay", { [STACK_LABEL]: "1" }, on(shared)],
      [
        "sealant-22222222-2222-2222-2222-222222222222",
        {},
        { ...mounts("external-executor-data"), ...on(shared, ["product-network", "net-product"]) },
      ],
      ["product-unrelated", {}, on(["product-network", "net-product"])],
    ],
    volumes: ["external-executor-data", "product-shared-data"],
    networks: [
      { Name: "shared-product-network", Id: "net-shared" },
      { Name: "product-network", Id: "net-product" },
    ],
  });
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.equal(await sweep.done, 0, sweep.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), [
    "product-unrelated",
    "sealant-22222222-2222-2222-2222-222222222222",
  ]);
  assert.deepEqual(volumeNames(left), ["external-executor-data", "product-shared-data"]);
  assert.deepEqual(
    left.networks.map((network) => network.Name),
    ["shared-product-network", "product-network"],
  );
});

test("a teardown removes the ledger's entries whose identity still matches, and nothing else (N13)", async () => {
  const fakeDaemon = daemon({
    containers: [
      ...generation("a"),
      ["mend-mend-1", { [COMPOSE]: "mend" }, on(["mend_default", "net-inner"])],
      ["sealant-5e55", {}, mounts("mend-control")],
      // On the inner network, never recorded: a container someone else attached.
      ["attached-later", {}, on(["mend_default", "net-inner"])],
    ],
    volumes: [
      STATE_VOLUME,
      volume("mend-store", {}, "2026-10-10T01:00:00Z"),
      volume("mend-control", {}, "2026-10-10T01:00:01Z"),
      // Recorded once, since removed and made again: another volume.
      volume("mend-garage", {}, "2026-10-10T03:00:00Z"),
      "unrecorded-data",
    ],
    networks: [{ Name: "mend_default", Id: "net-inner", Labels: { [COMPOSE]: "mend" } }],
  });
  const ids = Object.fromEntries(
    fakeDaemon.read().containers.map((item) => [item.Name.slice(1), item.Id]),
  );
  ledger(fakeDaemon, {
    containers: [ids["mend-mend-1"], ids["sealant-5e55"], "0".repeat(64)],
    networks: ["net-inner"],
    volumes: [
      { name: "mend-store", createdAt: "2026-10-10T01:00:00Z" },
      { name: "mend-control", createdAt: "2026-10-10T01:00:01Z" },
      { name: "mend-garage", createdAt: "2026-10-10T01:00:02Z" },
    ],
  });
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), ["attached-later"]);
  assert.deepEqual(volumeNames(left), ["mend-garage", "unrecorded-data"]);
  assert.deepEqual(
    left.networks.map(({ Id, Name }) => ({ Id, Name })),
    [{ Id: "net-inner", Name: "mend_default" }],
  );
  assert.match(
    down.output(),
    /left network mend_default: something the stack did not make uses it/,
  );
  assert.doesNotMatch(down.output(), /removed network mend_default/);
  assert.match(down.output(), /made again after the stack recorded it\): volume mend-garage/);
  assert.match(down.output(), /removed container mend-mend-1/);
  assert.match(down.output(), /removed container sealant-5e55/);
  assert.deepEqual(ledgerWindows(fakeDaemon), [], "the ledger goes with the stack");
});
