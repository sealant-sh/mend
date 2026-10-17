// Real processes and kernel locks against the isolated fake Docker daemon.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { OWNER_CONTAINER, STACK_LABEL, STATE_VOLUME } from "./lib.mjs";
import {
  volume,
  daemon,
  names,
  volumeNames,
  generation,
  until,
  COMPOSE,
  on,
  mounts,
  EXECUTOR,
  SIDECAR,
  product,
  ledgerDirOf,
  ledger,
  ledgerWindows,
} from "./lifecycle.e2e.helpers.mjs";

test("a `mend` window records an inner session, and nothing another client makes meanwhile (R7-1)", async () => {
  const fakeDaemon = daemon({
    containers: generation("a"),
    volumes: [STATE_VOLUME, ...product.volumes.slice(2)],
  });
  const cache = fakeDaemon.env.MEND_VERIFY_STACK_CACHE;
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stack.json"), JSON.stringify({ images: { cli: "c" } }));
  // While the window is open: an inner session, and the person's `pnpm dev` database beside it.
  writeFileSync(
    fakeDaemon.file("run"),
    JSON.stringify({
      containers: [
        [...EXECUTOR, "node:26-bookworm"],
        [...SIDECAR, [], "docker:27.5.1-dind-rootless"],
        ["mend-dev-postgres-1", { [COMPOSE]: "mend-dev" }],
      ],
      volumes: ["mend-dev_mend-dev-pgdata"],
      networks: ["sealant-5e55-network", "mend-dev_default"],
    }),
  );
  const inner = fakeDaemon.run(["mend", "run", "--", "true"]);
  assert.equal(await inner.done, 0, inner.output());
  const [window] = ledgerWindows(fakeDaemon);
  assert.equal(window.closed, true);
  assert.equal(window.containers.length, 2);
  // What each recorded container ran, by image id; nothing for what the window did not record.
  assert.deepEqual(
    window.ran.map((item) => [item.container, item.image, item.id.slice(0, 7)]).toSorted(),
    [
      ["sealant-5e55", "node:26-bookworm", "sha256:"],
      ["sealant-5e55-docker", "docker:27.5.1-dind-rootless", "sha256:"],
    ],
  );
  assert.deepEqual(window.volumes, []);
  assert.equal(window.networks.length, 1);
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), ["mend-dev-postgres-1"]);
  assert.deepEqual(
    volumeNames(left),
    volumeNames({ volumes: [...product.volumes.slice(2), volume("mend-dev_mend-dev-pgdata")] }),
  );
  assert.deepEqual(
    left.networks.map((network) => network.Name),
    ["mend-dev_default"],
  );
  assert.match(down.output(), /removed container sealant-5e55 /);
  assert.match(down.output(), /removed network sealant-5e55-network/);
});

test("a recording cut short by a kill keeps what it saw, and says so", async () => {
  const fakeDaemon = daemon({ containers: generation("a"), volumes: [STATE_VOLUME] });
  const cache = fakeDaemon.env.MEND_VERIFY_STACK_CACHE;
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stack.json"), JSON.stringify({ images: { cli: "c" } }));
  writeFileSync(fakeDaemon.file("run"), JSON.stringify({ containers: [EXECUTOR] }));
  writeFileSync(fakeDaemon.file("pause-run"), "1");
  const inner = fakeDaemon.run(["mend", "run", "--", "sleep", "60"]);
  await until("the session to be recorded", () =>
    ledgerWindows(fakeDaemon).some((window) => window.containers.length === 1),
  );
  // The window holds the daemon's lock shared: a `down` cannot race it (NIT-5).
  const busy = fakeDaemon.run(["down"]);
  assert.notEqual(await busy.done, 0);
  assert.match(busy.output(), /stack is busy/);
  inner.child.kill("SIGKILL");
  // The inner CLI's run holds the killed process's output open until it ends.
  rmSync(fakeDaemon.file("pause-run"));
  await inner.done;
  assert.equal(ledgerWindows(fakeDaemon)[0].closed, false);
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  assert.deepEqual(names(fakeDaemon.read()), []);
  assert.match(down.output(), /was cut short/);
});

/** An anonymous volume's name, as Docker makes one: 64 hex digits. */
const anonymous = (n) => `${String(n).repeat(8)}${"0".repeat(56)}`;

test("fake Docker refuses live network endpoints and mounted volumes, then removes released resources", () => {
  const fakeDaemon = daemon({
    containers: [["survivor", {}, { ...mounts("shared-data"), ...on(["shared", "net-shared"]) }]],
    volumes: ["shared-data", "unused-data"],
    networks: [
      { Id: "net-shared", Name: "shared" },
      { Id: "net-unused", Name: "unused" },
    ],
  });
  const inspected = fakeDaemon.docker(["network", "inspect", "net-shared"]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(Object.values(JSON.parse(inspected.stdout)[0].Containers), [
    { Name: "survivor" },
  ]);
  const network = fakeDaemon.docker(["network", "rm", "net-shared", "net-unused"]);
  assert.equal(network.status, 1);
  assert.match(network.stderr, /active endpoints/);
  assert.deepEqual(
    fakeDaemon.read().networks.map(({ Id }) => Id),
    ["net-shared"],
  );
  for (const flags of [[], ["--force"]]) {
    const removal = fakeDaemon.docker(["volume", "rm", ...flags, "shared-data", "unused-data"]);
    assert.equal(removal.status, 1);
    assert.match(removal.stderr, /shared-data.*in use/);
    assert.deepEqual(volumeNames(fakeDaemon.read()), ["shared-data"]);
  }
  assert.equal(fakeDaemon.docker(["rm", "--force", "survivor"]).status, 0);
  assert.equal(fakeDaemon.docker(["network", "rm", "net-shared"]).status, 0);
  assert.equal(fakeDaemon.docker(["volume", "rm", "shared-data"]).status, 0);
  assert.deepEqual(fakeDaemon.read().networks, []);
  assert.deepEqual(volumeNames(fakeDaemon.read()), []);
});

test("fake Docker rm --volumes removes only unused anonymous mounts, preserving named and shared volumes", () => {
  const orphan = anonymous(3);
  const shared = anonymous(4);
  const namedHex = anonymous(5);
  const retained = anonymous(6);
  const fakeDaemon = daemon({
    containers: [
      ["removed", {}, mounts(orphan, shared, namedHex, "named-data")],
      ["survivor", {}, mounts(shared)],
      ["removed-without-volumes", {}, mounts(retained)],
    ],
    volumes: [
      { ...volume(orphan), Anonymous: true },
      { ...volume(shared), Anonymous: true },
      { ...volume(retained), Anonymous: true },
      namedHex,
      "named-data",
    ],
  });
  assert.equal(fakeDaemon.docker(["rm", "--force", "--volumes", "removed"]).status, 0);
  assert.deepEqual(names(fakeDaemon.read()), ["removed-without-volumes", "survivor"]);
  assert.deepEqual(
    volumeNames(fakeDaemon.read()),
    [shared, retained, namedHex, "named-data"].toSorted(),
  );
  assert.equal(fakeDaemon.docker(["rm", "--force", "removed-without-volumes"]).status, 0);
  assert.ok(volumeNames(fakeDaemon.read()).includes(retained));
});

test("a recorded volume still mounted by an unrecorded survivor keeps the ledger for retry", async () => {
  const fakeDaemon = daemon({
    containers: [
      ...generation("a"),
      ["sealant-5e55", {}, mounts("mend-control")],
      ["attached-later", {}, mounts("mend-control")],
    ],
    volumes: [STATE_VOLUME, volume("mend-control", {}, "2026-10-10T01:00:01Z")],
  });
  const recorded = fakeDaemon.read().containers.find(({ Name }) => Name === "/sealant-5e55");
  ledger(fakeDaemon, {
    containers: [recorded.Id],
    volumes: [{ name: "mend-control", createdAt: "2026-10-10T01:00:01Z" }],
  });
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 1, down.output());
  assert.match(
    down.output(),
    /could not remove volume mend-control \(docker volume failed \(exit 1\)\)/,
  );
  assert.match(down.output(), /the ledger is kept, so the next down tries again/);
  assert.match(down.output(), /removed container sealant-5e55/);
  assert.deepEqual(names(fakeDaemon.read()), ["attached-later", OWNER_CONTAINER].toSorted());
  assert.deepEqual(volumeNames(fakeDaemon.read()), [STATE_VOLUME, "mend-control"].toSorted());
  assert.equal(ledgerWindows(fakeDaemon).length, 1);
});

test("a Core dev stack of Compose project `sealant`, made during a `mend` window, survives (R8-1)", async () => {
  const fakeDaemon = daemon({ containers: generation("a"), volumes: [STATE_VOLUME] });
  const cache = fakeDaemon.env.MEND_VERIFY_STACK_CACHE;
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stack.json"), JSON.stringify({ images: { cli: "c" } }));
  // While the window is open: an inner session, and the person's `docker compose up -d` in
  // /workspace/repos/sealant (Core's compose.yaml, project `sealant`; compose.selfhost.yaml, `name:
  // sealant`), a `sealant-ci` copy, and a hand-named `docker run --name sealant-test-redis`.
  writeFileSync(
    fakeDaemon.file("run"),
    JSON.stringify({
      containers: [
        EXECUTOR,
        SIDECAR,
        ["sealant-postgres-1", { [COMPOSE]: "sealant" }, ["sealant_postgres-data"]],
        ["sealant-cache-1", { [COMPOSE]: "sealant" }, [anonymous(1)]],
        ["sealant-web-1", { [COMPOSE]: "sealant" }],
        ["sealant-ci-postgres-1", { [COMPOSE]: "sealant-ci" }, ["sealant-ci_postgres-data"]],
        ["sealant-test-redis", {}, [anonymous(2)]],
      ],
      volumes: ["sealant_postgres-data", "sealant-ci_postgres-data", anonymous(1), anonymous(2)],
      networks: ["sealant-5e55-network", "sealant_default"],
    }),
  );
  const inner = fakeDaemon.run(["mend", "run", "--", "true"]);
  assert.equal(await inner.done, 0, inner.output());
  const [window] = ledgerWindows(fakeDaemon);
  assert.equal(window.containers.length, 2, "the executor and its sidecar only");
  assert.equal(window.networks.length, 1);
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), [
    "sealant-cache-1",
    "sealant-ci-postgres-1",
    "sealant-postgres-1",
    "sealant-test-redis",
    "sealant-web-1",
  ]);
  assert.deepEqual(
    volumeNames(left),
    [anonymous(1), anonymous(2), "sealant-ci_postgres-data", "sealant_postgres-data"].toSorted(),
  );
  assert.deepEqual(
    left.networks.map((network) => network.Name),
    ["sealant_default"],
  );
  assert.doesNotMatch(down.output(), /removed container sealant-(cache|web|postgres|ci|test)/);
});

test("a window file that is a symlink is refused, and nothing is removed (NIT-7)", async () => {
  const fakeDaemon = daemon({
    containers: [["verify-stack-relay", { [STACK_LABEL]: "1" }]],
    volumes: [STATE_VOLUME],
  });
  ledger(fakeDaemon, {});
  const target = join(fakeDaemon.root, "planted.json");
  writeFileSync(target, "{}", { mode: 0o600 });
  rmSync(join(ledgerDirOf(fakeDaemon), "window.json"));
  symlinkSync(target, join(ledgerDirOf(fakeDaemon), "window.json"));
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.notEqual(await sweep.done, 0);
  assert.match(sweep.output(), /window\.json is a symlink, refused; nothing was removed/);
  assert.deepEqual(names(fakeDaemon.read()), ["verify-stack-relay"]);
});

test("a torn ledger copy in the state volume is refused with the command that moves it aside (NIT-6)", async () => {
  const fakeDaemon = daemon({
    containers: [["verify-stack-relay", { [STACK_LABEL]: "1" }]],
    volumes: [STATE_VOLUME],
    files: { [`/fake/volumes/${STATE_VOLUME}/_data/ledger.json`]: "{" },
  });
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.notEqual(await sweep.done, 0);
  assert.match(
    sweep.output(),
    /the state volume's ledger.json cannot be read .*nothing was removed/,
  );
  assert.match(
    sweep.output(),
    /docker run --rm --volume verify-stack-state:\/s \S+ mv \/s\/ledger\.json \/s\/ledger\.json\.bad/,
  );
  assert.deepEqual(names(fakeDaemon.read()), ["verify-stack-relay"]);
});

test("a volume the stack made twice under one name is removed whichever record is read first (R7-2)", async () => {
  const fakeDaemon = daemon({
    containers: generation("a"),
    volumes: [STATE_VOLUME, volume("mend-store", {}, "2026-10-10T02:00:00Z")],
  });
  for (const [window, createdAt] of [
    ["a", "2026-10-10T01:00:00Z"],
    ["b", "2026-10-10T02:00:00Z"],
    ["c", "2026-10-10T00:30:00Z"],
  ])
    ledger(fakeDaemon, { volumes: [{ name: "mend-store", createdAt }] }, { window });
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  assert.deepEqual(volumeNames(fakeDaemon.read()), []);
});

test("a teardown on one daemon leaves another daemon's ledger alone (R7-3)", async () => {
  const first = daemon({
    containers: [...generation("a"), ["sealant-5e55", {}, mounts("mend-control")]],
    volumes: [STATE_VOLUME],
  });
  const ids = Object.fromEntries(
    first.read().containers.map((item) => [item.Name.slice(1), item.Id]),
  );
  ledger(first, { containers: [ids["sealant-5e55"]] });
  // Another daemon, the same cache directory.
  const second = daemon({ cache: first.env.MEND_VERIFY_STACK_CACHE });
  const sweep = second.run(["down", "--force"]);
  assert.equal(await sweep.done, 0, sweep.output());
  assert.equal(ledgerWindows(first).length, 1, "the first daemon's ledger stays");
  const down = first.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  assert.deepEqual(names(first.read()), []);
});

test("a ledger that is planted, open to others or unreadable removes nothing (NIT-2, NIT-3)", async () => {
  // Keep these case-specific helpers beside the ledger refusal assertions.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const setup = () => {
    const fakeDaemon = daemon({
      containers: [
        ["verify-stack-relay", { [STACK_LABEL]: "1" }],
        ["sealant-5e55", {}, mounts("mend-control")],
      ],
      volumes: [STATE_VOLUME],
    });
    const id = fakeDaemon.read().containers[1].Id;
    ledger(fakeDaemon, { containers: [id] });
    return fakeDaemon;
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const untouched = async (fakeDaemon, pattern) => {
    const sweep = fakeDaemon.run(["down", "--force"]);
    assert.notEqual(await sweep.done, 0);
    assert.match(sweep.output(), pattern);
    assert.deepEqual(names(fakeDaemon.read()), ["sealant-5e55", "verify-stack-relay"]);
    assert.deepEqual(volumeNames(fakeDaemon.read()), [STATE_VOLUME]);
  };
  // A directory in the ledger's place that is a symlink.
  const linked = setup();
  const elsewhere = join(linked.root, "elsewhere");
  renameSync(ledgerDirOf(linked), elsewhere);
  symlinkSync(elsewhere, ledgerDirOf(linked));
  await untouched(linked, /no symlink/);
  // A window file others can write.
  const open = setup();
  chmodSync(join(ledgerDirOf(open), "window.json"), 0o666);
  await untouched(open, /window\.json must be this user's own file/);
  // A window file that is not JSON: the error names it.
  const torn = setup();
  writeFileSync(join(ledgerDirOf(torn), "window.json"), "{", { mode: 0o600 });
  await untouched(torn, /the ledger in .*window\.json cannot be read/);
});

test("the ledger is this cache's windows and the state volume's copy, merged (NIT-4)", async () => {
  const fakeDaemon = daemon({
    containers: [...generation("a"), ["sealant-5e55", {}, mounts("mend-control")]],
    volumes: [STATE_VOLUME, volume("mend-store", {}, "2026-10-10T01:00:00Z")],
    files: {
      [`/fake/volumes/${STATE_VOLUME}/_data/ledger.json`]: JSON.stringify({
        containers: [],
        networks: [],
        volumes: [{ name: "mend-store", createdAt: "2026-10-10T01:00:00Z" }],
      }),
    },
  });
  ledger(fakeDaemon, { containers: [fakeDaemon.read().containers.at(-1).Id] });
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  assert.deepEqual(names(fakeDaemon.read()), []);
  assert.deepEqual(volumeNames(fakeDaemon.read()), []);
});
