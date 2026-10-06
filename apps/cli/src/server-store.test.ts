import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  withServerStore,
  type ServerFiles,
  type ServerGeneration,
  type ServerStore,
} from "./server-store.ts";

const roots: Array<string> = [];
const children: Array<ChildProcess> = [];
const temporary = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend store "));
  roots.push(root);
  return root;
};
const fixture = fileURLToPath(new URL("../test-fixtures/server-child.mjs", import.meta.url));
const launch = (args: ReadonlyArray<string>, limited = false) => {
  const nodeArgs = ["--experimental-strip-types", fixture, ...args];
  const child = limited
    ? spawn("bash", [
        "-c",
        'ulimit -c 0; ulimit -f 1; exec "$@"',
        "bash",
        process.execPath,
        ...nodeArgs,
      ])
    : spawn(process.execPath, nodeArgs);
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
};
const waitFor = async (file: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const modeOf = (file: string): number => fs.statSync(file).mode & 0o7777;
const activeDirectory = (root: string): string => fs.realpathSync(path.join(root, "active"));
const identityAt = (root: string): string =>
  fs.readFileSync(path.join(root, "identity.env"), "utf8");
const files: ServerFiles = {
  identity: "original identity\n",
  config: "original config\n",
  env: "original env\n",
  compose: "original compose\n",
  postgresInit: "original init\n",
};

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await closed;
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("server filesystem transactions", () => {
  it("writes public init permissions under a private umask without exposing credentials or directories", async () => {
    const root = temporary();
    expect((await launch([root, "private-umask"]).done).code).toBe(0);
    const generation = activeDirectory(root);
    for (const directory of [root, path.join(root, "generations"), generation]) {
      expect(modeOf(directory)).toBe(0o700);
    }
    expect(modeOf(path.join(root, "identity.env"))).toBe(0o600);
    for (const file of ["identity.env", "server.json", "server.env", "compose.yaml"]) {
      expect(modeOf(path.join(generation, file))).toBe(0o600);
    }
    expect(modeOf(path.join(generation, "postgres-init.sh"))).toBe(0o755);
  });

  it.each([0o700, 0o600, 0o644, 0o750, 0o777, 0o4755])(
    "prepares a new identical generation for incompatible init mode %i without mutating the old one",
    async (mode) => {
      const root = temporary();
      const result = await withServerStore(root, async (store) => {
        const first = store.commit(files);
        if (first._tag === "error") throw first.error;
        const oldScript = path.join(first.value.directory, "postgres-init.sh");
        fs.chmodSync(oldScript, mode);
        const oldStat = fs.statSync(oldScript);
        const identityStat = fs.statSync(path.join(root, "identity.env"));
        const prepared = store.prepare(files);
        if (prepared._tag === "error") throw prepared.error;
        expect(prepared.value.directory).not.toBe(first.value.directory);
        expect(prepared.value.files).toEqual(first.value.files);
        expect(activeDirectory(root)).toBe(first.value.directory);
        // Reads may update atime; inode, content timestamps and permissions must not change.
        expect(fs.statSync(oldScript)).toMatchObject({
          ino: oldStat.ino,
          mode: oldStat.mode,
          mtimeMs: oldStat.mtimeMs,
          ctimeMs: oldStat.ctimeMs,
        });
        expect(fs.statSync(path.join(root, "identity.env"))).toMatchObject({
          ino: identityStat.ino,
          mode: identityStat.mode,
          mtimeMs: identityStat.mtimeMs,
          ctimeMs: identityStat.ctimeMs,
        });
        for (const file of fs.readdirSync(first.value.directory)) {
          expect(fs.readFileSync(path.join(prepared.value.directory, file))).toEqual(
            fs.readFileSync(path.join(first.value.directory, file)),
          );
        }
        expect(
          fs.statSync(path.join(prepared.value.directory, "postgres-init.sh")).mode & 0o7777,
        ).toBe(0o755);
        expect(store.activate(prepared.value)._tag).toBe("ok");
        expect(store.commit(files)).toEqual(prepared);
        expect(identityAt(root)).toBe(files.identity);
        expect(fs.statSync(oldScript).mode & 0o7777).toBe(mode);
        expect(fs.readdirSync(path.join(root, "generations"))).toHaveLength(2);
      });
      if (result._tag === "error") throw result.error;
    },
  );

  it("retains generations, reuses identical files, and refuses to overwrite identity", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const first = store.commit(files);
      expect(first._tag).toBe("ok");
      expect(store.commit(files)).toEqual(first);
      const second = store.commit({ ...files, config: "changed config" });
      expect(second._tag).toBe("ok");
      expect(second).not.toEqual(first);
      expect(store.commit({ ...files, identity: "replacement" })).toMatchObject({ _tag: "error" });
      expect(identityAt(root)).toBe(files.identity);
      if (first._tag === "ok") {
        expect(fs.readFileSync(path.join(first.value.directory, "server.json"), "utf8")).toBe(
          files.config,
        );
      }
      expect(fs.readdirSync(path.join(root, "generations"))).toHaveLength(2);
    });
    expect(result._tag).toBe("ok");
    expect(fs.existsSync(path.join(root, "server.lock"))).toBe(false);
  });

  it("prepares durable identity and complete files before selecting an active generation", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const first = store.prepare(files);
      expect(first._tag).toBe("ok");
      if (first._tag === "error") return;
      expect(identityAt(root)).toBe(files.identity);
      expect(store.readActive()).toEqual({ _tag: "ok", value: null });
      expect(fs.readdirSync(first.value.directory).toSorted()).toEqual(
        [
          "identity.env",
          "server.json",
          "server.env",
          "compose.yaml",
          "postgres-init.sh",
        ].toSorted(),
      );
      expect(store.activate(first.value)).toEqual({ _tag: "ok", value: undefined });
      expect(store.prepare(files)).toEqual(first);
      const target = store.prepare({ ...files, config: "next config" });
      expect(target._tag).toBe("ok");
      if (target._tag === "error") return;
      expect(activeDirectory(root)).toBe(first.value.directory);
      expect(store.prepare({ ...files, identity: "replacement" })._tag).toBe("error");
      expect(store.activate({ ...target.value, directory: temporary() })._tag).toBe("error");
      fs.writeFileSync(path.join(target.value.directory, "compose.yaml"), "changed");
      expect(store.activate(target.value)._tag).toBe("error");
      expect(activeDirectory(root)).toBe(first.value.directory);
      fs.writeFileSync(path.join(target.value.directory, "compose.yaml"), files.compose);
      expect(store.activate(target.value)._tag).toBe("ok");
      expect(store.readActive()).toEqual(target);
      expect(identityAt(root)).toBe(files.identity);
    });
    expect(result._tag).toBe("ok");
  });

  it.each([false, true])(
    "survives process loss after a kernel-limited partial write, prior active=%s",
    async (hasActive) => {
      const root = temporary();
      if (hasActive) {
        const result = await withServerStore(root, async (store) => store.commit(files));
        expect(result).toMatchObject({ _tag: "ok", value: { _tag: "ok" } });
      }
      const previous = hasActive ? activeDirectory(root) : null;
      const failed = await launch([root, "oversized-generation"], true).done;
      expect(failed.signal).toBe("SIGKILL");
      expect(identityAt(root)).toBe(files.identity);
      expect(fs.existsSync(path.join(root, "active"))).toBe(hasActive);
      if (previous !== null) {
        expect(activeDirectory(root)).toBe(previous);
        expect(fs.readFileSync(path.join(previous, "server.env"), "utf8")).toBe(files.env);
      }
      const generations = fs.readdirSync(path.join(root, "generations"));
      expect(generations).toHaveLength(hasActive ? 2 : 1);
      const partial = generations
        .map((name) => path.join(root, "generations", name))
        .find((directory) => directory !== previous);
      expect(partial).toBeDefined();
      if (partial !== undefined) {
        expect(fs.readFileSync(path.join(partial, "server.json"), "utf8")).toBe("new config\n");
        expect(fs.statSync(path.join(partial, "server.env")).size).toBeGreaterThan(0);
        expect(fs.statSync(path.join(partial, "server.env")).size).toBeLessThan(1024 * 1024);
        expect(fs.existsSync(path.join(partial, "compose.yaml"))).toBe(false);
      }
      const locked = await withServerStore(root, async () => {
        throw new Error("must not enter");
      });
      expect(locked).toMatchObject({ _tag: "error" });
      if (locked._tag === "error") expect(locked.error.message).toContain("may be stale");
      // Explicit operator recovery after the child has exited. Nothing in production steals it.
      fs.renameSync(path.join(root, "server.lock"), path.join(root, "recovered.lock"));
      const recovered = await withServerStore(root, async (store) => {
        expect(store.readIdentity()).toEqual({ _tag: "ok", value: files.identity });
        expect(store.commit(files)._tag).toBe("ok");
      });
      expect(recovered._tag).toBe("ok");
      expect(identityAt(root)).toBe(files.identity);
      expect(fs.readdirSync(path.join(root, "generations"))).toHaveLength(2);
    },
  );

  it("releases only its own lock and invalidates escaped store handles", async () => {
    const root = temporary();
    let escaped: ServerStore | undefined;
    const result = await withServerStore(root, async (store) => {
      escaped = store;
      const lock = path.join(root, "server.lock");
      fs.renameSync(lock, path.join(root, "original.lock"));
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner.json"), "replacement-owner");
      expect(store.commit(files)._tag).toBe("error");
    });
    expect(result._tag).toBe("error");
    if (result._tag === "error") expect(result.error.message).toContain("ownership was lost");
    expect(fs.readFileSync(path.join(root, "server.lock", "owner.json"), "utf8")).toBe(
      "replacement-owner",
    );
    expect(escaped?.readActive()._tag).toBe("error");
  });

  it("releases its lock when the callback fails and refuses missing identity or corrupt pointers", async () => {
    const root = temporary();
    expect(
      await withServerStore(root, async () => {
        throw new Error("failed command");
      }),
    ).toMatchObject({ _tag: "error" });
    expect(fs.existsSync(path.join(root, "server.lock"))).toBe(false);
    expect(await withServerStore(root, async (store) => store.commit(files))).toMatchObject({
      _tag: "ok",
      value: { _tag: "ok" },
    });
    fs.unlinkSync(path.join(root, "identity.env"));
    expect(
      await withServerStore(root, async (store) => ({
        commit: store.commit(files),
        read: store.readActive(),
      })),
    ).toMatchObject({
      _tag: "ok",
      value: { commit: { _tag: "error" }, read: { _tag: "error" } },
    });
    fs.unlinkSync(path.join(root, "active"));
    fs.symlinkSync("../../elsewhere", path.join(root, "active"));
    expect(await withServerStore(root, async (store) => store.readActive())).toMatchObject({
      _tag: "ok",
      value: { _tag: "error" },
    });
  });
});

// Each test here spawns Node processes that load TypeScript; on a loaded CI runner one has taken
// 3.7 s, so vitest's 5 s default left little headroom.
describe("setup across processes", { timeout: 30_000 }, () => {
  it("excludes contenders before state creation, during Compose, and through health, then reuses credentials", async () => {
    const root = temporary();
    const rendezvous = temporary();
    const first = launch([root, "setup", rendezvous]);
    for (const phase of ["context", "compose", "health"]) {
      await waitFor(path.join(rendezvous, phase));
      const contender = await launch([root]).done;
      expect(contender.code).toBe(1);
      expect(contender.stdout).toContain("is still live");
      expect(contender.stdout).toContain("Never remove a live lock");
      if (phase === "context") expect(fs.existsSync(path.join(root, "identity.env"))).toBe(false);
      fs.writeFileSync(path.join(rendezvous, `release-${phase}`), "go");
    }
    expect((await first.done).code).toBe(0);
    const identity = identityAt(root);
    const generation = activeDirectory(root);
    const rerun = await launch([root]).done;
    expect(rerun.code).toBe(0);
    expect(identityAt(root)).toBe(identity);
    expect(activeDirectory(root)).toBe(generation);
    expect(fs.existsSync(path.join(root, "server.lock"))).toBe(false);
  });

  it("retains saved credentials when Compose fails and on retry", async () => {
    const root = temporary();
    const failed = await launch([root, "compose-failure"]).done;
    expect(failed.code).toBe(1);
    const identity = identityAt(root);
    const generation = activeDirectory(root);
    expect((await launch([root]).done).code).toBe(0);
    expect(identityAt(root)).toBe(identity);
    expect(activeDirectory(root)).toBe(generation);
  });

  it("does not steal a killed setup's lock, and manual recovery keeps its active identity", async () => {
    const root = temporary();
    const rendezvous = temporary();
    fs.writeFileSync(path.join(rendezvous, "release-context"), "go");
    const first = launch([root, "setup", rendezvous]);
    await waitFor(path.join(rendezvous, "compose"));
    const identity = identityAt(root);
    const generation = activeDirectory(root);
    first.child.kill("SIGKILL");
    expect((await first.done).signal).toBe("SIGKILL");
    expect((await launch([root]).done).stdout).toContain("may be stale");
    expect(identityAt(root)).toBe(identity);
    fs.renameSync(path.join(root, "server.lock"), path.join(root, "recovered.lock"));
    expect((await launch([root]).done).code).toBe(0);
    expect(identityAt(root)).toBe(identity);
    expect(activeDirectory(root)).toBe(generation);
  });
});

const unwrap = <T>(result: { _tag: "ok"; value: T } | { _tag: "error"; error: Error }): T => {
  if (result._tag === "error") throw result.error;
  return result.value;
};
const TRAILER = "--\n-- PostgreSQL database cluster dump complete\n--\n";
/** One upgrade's backup as the upgrade leaves it: a dump, then completed only when told. */
const backupIn = (
  store: ServerStore,
  outcome: "completed" | "pending" | "unfinished" = "completed",
  generations?: { readonly previous: ServerGeneration; readonly target: ServerGeneration },
) => {
  // By default each backup gets generations no other one shares, so nothing chains by accident.
  const generation = generations ?? {
    previous: unwrap(store.prepare({ ...files, config: `previous ${randomUUID()}\n` })),
    target: unwrap(store.prepare({ ...files, config: `target ${randomUUID()}\n` })),
  };
  const backup = unwrap(store.createBackup(generation.previous, generation.target));
  fs.writeFileSync(
    backup.partialFile,
    `-- PostgreSQL database cluster dump\n-- ${path.basename(backup.directory)}\n${TRAILER}`,
  );
  if (outcome === "unfinished") return backup;
  unwrap(backup.complete());
  if (outcome === "completed") unwrap(backup.markCompleted());
  return backup;
};
const recovery = (directory: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(directory, "recovery.json"), "utf8"));
/** Rewrite a record the way releases before 0.36 wrote it: no state, sequence or createdAt. */
const makeLegacy = (directory: string, mtime?: Date): void => {
  const { state: _state, sequence: _sequence, createdAt: _createdAt, ...old } = recovery(directory);
  const file = path.join(directory, "recovery.json");
  fs.writeFileSync(file, JSON.stringify(old));
  if (mtime !== undefined) fs.utimesSync(file, mtime, mtime);
};
const names = (root: string): ReadonlyArray<string> =>
  fs.readdirSync(path.join(root, "backups")).toSorted();
const size = (directory: string) =>
  fs.statSync(path.join(directory, "database.sql")).size +
  fs.statSync(path.join(directory, "recovery.json")).size;
const directories = (entries: ReadonlyArray<{ readonly directory: string }>) =>
  entries.map((entry) => entry.directory).toSorted();
/** Distinct generations, one per config, so records can chain previous → target. */
const generationsIn = (store: ServerStore, count: number): ReadonlyArray<ServerGeneration> =>
  Array.from({ length: count }, (_, index) =>
    unwrap(store.prepare({ ...files, config: `config ${index}\n` })),
  );
/** A generation pinning `version`, as server.json states it. */
const pinning = (store: ServerStore, version: string): ServerGeneration =>
  unwrap(store.prepare({ ...files, config: JSON.stringify({ serverVersion: version }) }));
/** Generations pinning each version in turn, by index. */
const pinningEach = (
  store: ServerStore,
  versions: ReadonlyArray<string>,
): ((index: number) => ServerGeneration) => {
  const generations = versions.map((version) => pinning(store, version));
  return (index) => {
    const generation = generations[index];
    if (generation === undefined) throw new Error(`No generation ${index}`);
    return generation;
  };
};
/** Replace a backup's dump with `content`. */
const writeDump = (backup: { readonly directory: string }, content: string): void =>
  fs.writeFileSync(path.join(backup.directory, "database.sql"), content);
/** Plain numeric order; the CLI passes its own upgrade order. */
const byVersion = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true });

describe("upgrade backup pruning", () => {
  it("keeps the newest N completed backups, the current one among them, and reports the bytes", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const oldest = backupIn(store);
      const older = backupIn(store);
      const newer = backupIn(store);
      const current = backupIn(store);
      expect(recovery(current.directory)).toMatchObject({ state: "completed", sequence: 4 });
      const pruned = unwrap(store.pruneBackups(2, current, byVersion));
      expect(pruned.kept.map((entry) => entry.directory)).toEqual([
        current.directory,
        newer.directory,
      ]);
      expect(directories(pruned.removed)).toEqual(directories([oldest, older]));
      expect(pruned.removed.every((entry) => entry.bytes > 0 && !entry.legacy)).toBe(true);
      expect(pruned.kept[0]?.bytes).toBe(size(current.directory));
      expect(pruned.held).toEqual([]);
      expect(pruned.failed).toEqual([]);
      expect(fs.existsSync(oldest.directory)).toBe(false);
      expect(fs.existsSync(older.directory)).toBe(false);
      // A second prune finds nothing more to remove.
      expect(unwrap(store.pruneBackups(2, current, byVersion)).removed).toEqual([]);
    });
    expect(result._tag).toBe("ok");
    expect(names(root)).toHaveLength(2);
  });

  it("orders by Mend's sequence, not a clock that ran ahead", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const skewed = backupIn(store);
      // The box's clock was a year fast for this upgrade, then corrected.
      const file = path.join(skewed.directory, "recovery.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ ...recovery(skewed.directory), createdAt: "2099-01-01T00:00:00.000Z" }),
      );
      fs.utimesSync(file, new Date("2099-01-01"), new Date("2099-01-01"));
      const previous = backupIn(store);
      const current = backupIn(store);
      const pruned = unwrap(store.pruneBackups(2, current, byVersion));
      expect(pruned.kept.map((entry) => entry.directory)).toEqual([
        current.directory,
        previous.directory,
      ]);
      expect(directories(pruned.removed)).toEqual([skewed.directory]);
    });
    expect(result._tag).toBe("ok");
  });

  it("orders records from before 0.36 by the generation chain when a copy reset their mtimes", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const generations = generationsIn(store, 5);
      const at = (index: number): ServerGeneration => {
        const generation = generations[index];
        if (generation === undefined) throw new Error(`No generation ${index}`);
        return generation;
      };
      const [g0, g1, g2, g3, g4] = [at(0), at(1), at(2), at(3), at(4)];
      const first = backupIn(store, "completed", { previous: g0, target: g1 });
      const second = backupIn(store, "completed", { previous: g1, target: g2 });
      const third = backupIn(store, "completed", { previous: g2, target: g3 });
      // A copy without -t: mtimes in reverse order of the upgrades.
      makeLegacy(first.directory, new Date("2026-10-03T00:00:03Z"));
      makeLegacy(second.directory, new Date("2026-10-03T00:00:02Z"));
      makeLegacy(third.directory, new Date("2026-10-03T00:00:01Z"));
      const current = backupIn(store, "completed", { previous: g3, target: g4 });
      expect(recovery(current.directory)).toMatchObject({ sequence: 1 });
      const pruned = unwrap(store.pruneBackups(2, current, byVersion));
      expect(pruned.kept.map((entry) => entry.directory)).toEqual([
        current.directory,
        third.directory,
      ]);
      expect(directories(pruned.removed)).toEqual(directories([first, second]));
      expect(pruned.removed.every((entry) => entry.legacy)).toBe(true);
    });
    expect(result._tag).toBe("ok");
  });

  it("orders records from before 0.36 by their target's version across a setup rerun", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const g = pinningEach(store, ["0.30.0", "0.31.0", "0.32.0", "0.32.0", "0.33.0", "0.36.0"]);
      const a = backupIn(store, "completed", { previous: g(0), target: g(1) });
      const b = backupIn(store, "completed", { previous: g(1), target: g(2) });
      // A setup rerun moved g2 to g3 without a backup; the chain breaks there.
      const c = backupIn(store, "completed", { previous: g(3), target: g(4) });
      makeLegacy(a.directory, new Date("2026-10-03T00:00:02Z"));
      makeLegacy(b.directory, new Date("2026-10-03T00:00:03Z"));
      makeLegacy(c.directory, new Date("2026-10-03T00:00:01Z"));
      const current = backupIn(store, "completed", { previous: g(4), target: g(5) });
      const pruned = unwrap(store.pruneBackups(2, current, byVersion));
      expect(pruned.kept.map((entry) => entry.directory)).toEqual([current.directory, c.directory]);
      expect(directories(pruned.removed)).toEqual(directories([a, b]));
    });
    expect(result._tag).toBe("ok");
  });

  it("holds a record without an outcome that an older CLI wrote after a 0.36 one", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const g = pinningEach(store, ["0.35.0", "0.36.0", "0.36.1", "0.36.2", "0.36.2", "0.36.3"]);
      const sequenced = backupIn(store, "completed", { previous: g(0), target: g(1) });
      // An older CLI upgraded from that target, then another across a setup rerun to a later version.
      const chained = backupIn(store, "completed", { previous: g(1), target: g(2) });
      makeLegacy(chained.directory);
      const later = backupIn(store, "completed", { previous: g(2), target: g(3) });
      makeLegacy(later.directory, new Date("2020-01-01"));
      const current = backupIn(store, "completed", { previous: g(4), target: g(5) });
      const pruned = unwrap(store.pruneBackups(1, current, byVersion));
      expect(pruned.held.toSorted((x, y) => x.directory.localeCompare(y.directory))).toEqual(
        [
          { directory: chained.directory, reason: "no-outcome" },
          { directory: later.directory, reason: "no-outcome" },
        ].toSorted((x, y) => x.directory.localeCompare(y.directory)),
      );
      expect(pruned.removed.map((entry) => entry.directory)).toEqual([sequenced.directory]);
    });
    expect(result._tag).toBe("ok");
  });

  it("holds a record with a state but no valid sequence", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const corrupt = backupIn(store);
      const file = path.join(corrupt.directory, "recovery.json");
      fs.writeFileSync(file, JSON.stringify({ ...recovery(corrupt.directory), sequence: "1" }));
      const stateless = backupIn(store);
      const { sequence: _sequence, ...rest } = recovery(stateless.directory);
      fs.writeFileSync(path.join(stateless.directory, "recovery.json"), JSON.stringify(rest));
      const current = backupIn(store);
      const pruned = unwrap(store.pruneBackups(1, current, byVersion));
      expect(pruned.held.map((entry) => [entry.reason, entry.detail])).toEqual([
        ["unreadable", "recovery.json has a state without a valid sequence"],
        ["unreadable", "recovery.json has a state without a valid sequence"],
      ]);
      expect(pruned.removed).toEqual([]);
    });
    expect(result._tag).toBe("ok");
  });

  it("finds pg_dumpall's trailer only at the start of a line at the end of the dump", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const midLine = backupIn(store);
      writeDump(
        midLine,
        `COPY x FROM stdin;\nrow -- PostgreSQL database cluster dump complete\n--\n`,
      );
      const notLast = backupIn(store);
      writeDump(notLast, `-- dump\n${TRAILER}CREATE TABLE after_the_trailer ();\n`);
      const crlf = backupIn(store);
      writeDump(
        crlf,
        "-- dump\r\n--\r\n-- PostgreSQL database cluster dump complete\r\n--\r\n\r\n",
      );
      const blankLines = backupIn(store);
      writeDump(blankLines, `-- dump\n${TRAILER}\n\n`);
      const current = backupIn(store);
      const pruned = unwrap(store.pruneBackups(1, current, byVersion));
      expect(directories(pruned.held)).toEqual(directories([midLine, notLast]));
      expect(directories(pruned.removed)).toEqual(directories([crlf, blankLines]));
    });
    expect(result._tag).toBe("ok");
  });

  it.skipIf(process.getuid?.() === 0)(
    "an unreadable backup never refuses an upgrade, and the prune lists it",
    async () => {
      const root = temporary();
      const result = await withServerStore(root, async (store) => {
        const locked = backupIn(store);
        fs.chmodSync(locked.directory, 0o000);
        try {
          const current = backupIn(store);
          expect(recovery(current.directory)).toMatchObject({ sequence: 1 });
          const pruned = unwrap(store.pruneBackups(1, current, byVersion));
          expect(pruned.held).toMatchObject([
            {
              directory: locked.directory,
              reason: "unreadable",
              detail: expect.stringContaining("EACCES"),
            },
          ]);
          expect(pruned.removed).toEqual([]);
        } finally {
          fs.chmodSync(locked.directory, 0o700);
        }
      });
      expect(result._tag).toBe("ok");
    },
  );

  it("never removes the current backup, even when every other one is newer", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const current = backupIn(store);
      backupIn(store);
      backupIn(store);
      const pruned = unwrap(store.pruneBackups(1, current, byVersion));
      expect(pruned.kept.map((entry) => entry.directory)).toEqual([current.directory]);
      expect(pruned.removed).toHaveLength(2);
      expect(fs.existsSync(path.join(current.directory, "database.sql"))).toBe(true);
    });
    expect(result._tag).toBe("ok");
    expect(names(root)).toHaveLength(1);
  });

  it("removes nothing while the current backup is not recorded as completed", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      backupIn(store);
      backupIn(store);
      const current = backupIn(store, "pending");
      expect(recovery(current.directory)).toMatchObject({ state: "pending" });
      expect(store.pruneBackups(1, current, byVersion)).toMatchObject({ _tag: "error" });
      expect(store.pruneBackups(0, current, byVersion)).toMatchObject({ _tag: "error" });
    });
    expect(result._tag).toBe("ok");
    expect(names(root)).toHaveLength(3);
  });

  it("keeps a backup whose recovery is pending or unfinished, however old", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const unfinished = backupIn(store, "unfinished");
      const pending = backupIn(store, "pending");
      // markCompleted wrote its temporary and never renamed it: still pending, still listed.
      const interrupted = backupIn(store, "pending");
      fs.writeFileSync(
        path.join(interrupted.directory, ".recovery-00000000-0000-4000-8000-000000000009"),
        "{}",
      );
      const truncated = backupIn(store);
      fs.writeFileSync(path.join(truncated.directory, "database.sql"), "-- PostgreSQL database");
      const legacyEmpty = backupIn(store);
      fs.writeFileSync(path.join(legacyEmpty.directory, "database.sql"), "x");
      makeLegacy(legacyEmpty.directory);
      const legacyDumpless = backupIn(store);
      fs.unlinkSync(path.join(legacyDumpless.directory, "database.sql"));
      makeLegacy(legacyDumpless.directory);
      backupIn(store);
      const current = backupIn(store);
      const pruned = unwrap(store.pruneBackups(1, current, byVersion));
      const reasons = Object.fromEntries(
        pruned.held.map((entry) => [entry.directory, entry.reason]),
      );
      expect(reasons).toEqual({
        [unfinished.directory]: "unfinished",
        [pending.directory]: "pending",
        [interrupted.directory]: "pending",
        [truncated.directory]: "unfinished",
        [legacyEmpty.directory]: "unfinished",
        [legacyDumpless.directory]: "unfinished",
      });
      expect(pruned.removed).toHaveLength(1);
      for (const directory of Object.keys(reasons)) expect(fs.existsSync(directory)).toBe(true);
    });
    expect(result._tag).toBe("ok");
  });

  it("finishes removals a crash cut short", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const backups = path.join(root, "backups");
      const renamed = backupIn(store);
      fs.renameSync(renamed.directory, `${renamed.directory}.removing`);
      const dumpless = backupIn(store);
      fs.unlinkSync(path.join(dumpless.directory, "database.sql"));
      const empty = path.join(backups, "upgrade-00000000-0000-4000-8000-00000000000a");
      fs.mkdirSync(empty);
      // Not Mend's to finish: a .removing directory holding something Mend never writes.
      const foreign = path.join(backups, "upgrade-00000000-0000-4000-8000-00000000000b.removing");
      fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(foreign, "notes.txt"), "mine\n");
      const current = backupIn(store);
      const pruned = unwrap(store.pruneBackups(5, current, byVersion));
      expect(directories(pruned.removed)).toEqual(
        [`${renamed.directory}.removing`, dumpless.directory, empty].toSorted(),
      );
      expect(pruned.removed.every((entry) => entry.interrupted)).toBe(true);
      expect(pruned.held).toEqual([]);
    });
    expect(result._tag).toBe("ok");
    expect(names(root)).toHaveLength(2);
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports what it removed when a removal fails partway, and finishes it next time",
    async () => {
      const root = temporary();
      const result = await withServerStore(root, async (store) => {
        const stuck = backupIn(store);
        const removable = backupIn(store);
        const current = backupIn(store);
        fs.chmodSync(stuck.directory, 0o500);
        const pruned = unwrap(store.pruneBackups(1, current, byVersion));
        fs.chmodSync(`${stuck.directory}.removing`, 0o700);
        expect(pruned.removed.map((entry) => entry.directory)).toEqual([removable.directory]);
        expect(pruned.failed.map((entry) => entry.directory)).toEqual([stuck.directory]);
        const retried = unwrap(store.pruneBackups(1, current, byVersion));
        expect(retried.removed).toMatchObject([
          { directory: `${stuck.directory}.removing`, interrupted: true },
        ]);
        expect(retried.failed).toEqual([]);
      });
      expect(result._tag).toBe("ok");
      expect(names(root)).toHaveLength(1);
    },
  );

  it("claims no freed space for a dump another hard link still holds", async () => {
    const root = temporary();
    const outside = temporary();
    const result = await withServerStore(root, async (store) => {
      const linked = backupIn(store);
      fs.linkSync(path.join(linked.directory, "database.sql"), path.join(outside, "snapshot.sql"));
      const record = fs.statSync(path.join(linked.directory, "recovery.json")).size;
      const current = backupIn(store);
      const pruned = unwrap(store.pruneBackups(1, current, byVersion));
      expect(pruned.removed).toMatchObject([{ directory: linked.directory, bytes: record }]);
      expect(fs.readFileSync(path.join(outside, "snapshot.sql"), "utf8")).toContain(TRAILER);
    });
    expect(result._tag).toBe("ok");
  });

  it("ignores foreign entries and links, and treats a whole record from before 0.36 as completed", async () => {
    const root = temporary();
    const outside = temporary();
    const result = await withServerStore(root, async (store) => {
      const backups = path.join(root, "backups");
      const legacy = backupIn(store);
      makeLegacy(legacy.directory);
      // A completed backup outside backups/, reached through an upgrade-UUID link.
      const target = path.join(outside, "upgrade-00000000-0000-4000-8000-000000000001");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "database.sql"), `outside dump\n${TRAILER}`);
      fs.writeFileSync(
        path.join(target, "recovery.json"),
        JSON.stringify({ previousGeneration: "a", targetGeneration: "b", state: "completed" }),
      );
      fs.symlinkSync(target, path.join(backups, "upgrade-00000000-0000-4000-8000-000000000002"));
      const extra = backupIn(store);
      fs.writeFileSync(path.join(extra.directory, "notes.txt"), "mine\n");
      const linkedDump = backupIn(store);
      fs.unlinkSync(path.join(linkedDump.directory, "database.sql"));
      fs.symlinkSync(
        path.join(target, "database.sql"),
        path.join(linkedDump.directory, "database.sql"),
      );
      const noRecord = path.join(backups, "upgrade-00000000-0000-4000-8000-000000000003");
      fs.mkdirSync(noRecord);
      fs.writeFileSync(path.join(noRecord, "database.sql"), `dump\n${TRAILER}`);
      const badRecord = path.join(backups, "upgrade-00000000-0000-4000-8000-000000000004");
      fs.mkdirSync(badRecord);
      fs.writeFileSync(path.join(badRecord, "database.sql"), `dump\n${TRAILER}`);
      fs.writeFileSync(path.join(badRecord, "recovery.json"), "not json");
      fs.mkdirSync(path.join(backups, "upgrade-not-a-uuid"));
      fs.mkdirSync(path.join(backups, "manual-copy"));
      fs.writeFileSync(path.join(backups, "upgrade-00000000-0000-4000-8000-000000000005"), "file");
      const current = backupIn(store);
      const pruned = unwrap(store.pruneBackups(1, current, byVersion));
      expect(pruned.removed).toMatchObject([{ directory: legacy.directory, legacy: true }]);
      expect(pruned.held).toEqual([]);
      expect(fs.existsSync(path.join(target, "database.sql"))).toBe(true);
      expect(fs.existsSync(path.join(extra.directory, "database.sql"))).toBe(true);
      expect(fs.lstatSync(path.join(linkedDump.directory, "database.sql")).isSymbolicLink()).toBe(
        true,
      );
    });
    if (result._tag === "error") throw result.error;
    expect(names(root)).toHaveLength(9);
  });
});
