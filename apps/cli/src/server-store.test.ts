import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { withServerStore, type ServerFiles, type ServerStore } from "./server-store.ts";

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

describe("setup across processes", () => {
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
/** One upgrade's backup as the upgrade leaves it: a dump, then completed only when told. */
const backupIn = async (
  store: ServerStore,
  outcome: "completed" | "pending" | "unfinished" = "completed",
) => {
  // createdAt has millisecond precision; keep successive backups apart.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const generation = unwrap(store.commit(files));
  const backup = unwrap(store.createBackup(generation, generation));
  fs.writeFileSync(backup.partialFile, `dump of ${path.basename(backup.directory)}\n`);
  if (outcome === "unfinished") return backup;
  unwrap(backup.complete());
  if (outcome === "completed") unwrap(backup.markCompleted());
  return backup;
};
const recovery = (directory: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(directory, "recovery.json"), "utf8"));
const names = (root: string): ReadonlyArray<string> =>
  fs.readdirSync(path.join(root, "backups")).toSorted();

const size = (directory: string) =>
  fs.statSync(path.join(directory, "database.sql")).size +
  fs.statSync(path.join(directory, "recovery.json")).size;

describe("upgrade backup pruning", () => {
  it("keeps the newest N completed backups, the current one among them, and reports the bytes", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const oldest = await backupIn(store);
      const older = await backupIn(store);
      const newer = await backupIn(store);
      const current = await backupIn(store);
      expect(recovery(current.directory)).toMatchObject({ state: "completed" });
      const pruned = unwrap(store.pruneBackups(2, current));
      expect(pruned.kept.map((entry) => entry.directory)).toEqual([
        current.directory,
        newer.directory,
      ]);
      expect(pruned.removed.map((entry) => entry.directory).toSorted()).toEqual(
        [oldest.directory, older.directory].toSorted(),
      );
      expect(pruned.removed.every((entry) => entry.bytes > 0)).toBe(true);
      expect(pruned.kept[0]?.bytes).toBe(size(current.directory));
      expect(pruned.held).toEqual([]);
      expect(fs.existsSync(oldest.directory)).toBe(false);
      expect(fs.existsSync(older.directory)).toBe(false);
      // A second prune finds nothing more to remove.
      expect(unwrap(store.pruneBackups(2, current)).removed).toEqual([]);
    });
    expect(result._tag).toBe("ok");
    expect(names(root)).toHaveLength(2);
  });

  it("never removes the current backup, even when every other one is newer", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const current = await backupIn(store);
      await backupIn(store);
      await backupIn(store);
      const pruned = unwrap(store.pruneBackups(1, current));
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
      await backupIn(store);
      await backupIn(store);
      const current = await backupIn(store, "pending");
      expect(recovery(current.directory)).toMatchObject({ state: "pending" });
      expect(store.pruneBackups(1, current)).toMatchObject({ _tag: "error" });
      expect(store.pruneBackups(0, current)).toMatchObject({ _tag: "error" });
    });
    expect(result._tag).toBe("ok");
    expect(names(root)).toHaveLength(3);
  });

  it("keeps a backup whose recovery is pending or unfinished, however old", async () => {
    const root = temporary();
    const result = await withServerStore(root, async (store) => {
      const unfinished = await backupIn(store, "unfinished");
      const pending = await backupIn(store, "pending");
      const dumpless = await backupIn(store);
      fs.unlinkSync(path.join(dumpless.directory, "database.sql"));
      await backupIn(store);
      const current = await backupIn(store);
      const pruned = unwrap(store.pruneBackups(1, current));
      expect(pruned.held.toSorted((a, b) => a.directory.localeCompare(b.directory))).toEqual(
        [
          { directory: unfinished.directory, reason: "unfinished" },
          { directory: pending.directory, reason: "pending" },
          { directory: dumpless.directory, reason: "unfinished" },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      );
      expect(pruned.removed).toHaveLength(1);
      expect(fs.existsSync(path.join(unfinished.directory, "database.sql.partial"))).toBe(true);
      expect(fs.existsSync(path.join(pending.directory, "database.sql"))).toBe(true);
      expect(fs.existsSync(path.join(dumpless.directory, "recovery.json"))).toBe(true);
    });
    expect(result._tag).toBe("ok");
  });

  it("ignores foreign entries and links, and treats a record from before the state field as completed", async () => {
    const root = temporary();
    const outside = temporary();
    const result = await withServerStore(root, async (store) => {
      const backups = path.join(root, "backups");
      const legacy = await backupIn(store);
      // The record releases before this one wrote: no state, no createdAt.
      const { state: _state, createdAt: _createdAt, ...old } = recovery(legacy.directory);
      fs.writeFileSync(path.join(legacy.directory, "recovery.json"), JSON.stringify(old));
      // A completed backup outside backups/, reached through an upgrade-UUID link.
      const target = path.join(outside, "upgrade-00000000-0000-4000-8000-000000000001");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "database.sql"), "outside dump\n");
      fs.writeFileSync(
        path.join(target, "recovery.json"),
        JSON.stringify({ previousGeneration: "a", targetGeneration: "b", state: "completed" }),
      );
      fs.symlinkSync(target, path.join(backups, "upgrade-00000000-0000-4000-8000-000000000002"));
      const extra = await backupIn(store);
      fs.writeFileSync(path.join(extra.directory, "notes.txt"), "mine\n");
      const linkedDump = await backupIn(store);
      fs.unlinkSync(path.join(linkedDump.directory, "database.sql"));
      fs.symlinkSync(
        path.join(target, "database.sql"),
        path.join(linkedDump.directory, "database.sql"),
      );
      const noRecord = path.join(backups, "upgrade-00000000-0000-4000-8000-000000000003");
      fs.mkdirSync(noRecord);
      fs.writeFileSync(path.join(noRecord, "database.sql"), "dump\n");
      const badRecord = path.join(backups, "upgrade-00000000-0000-4000-8000-000000000004");
      fs.mkdirSync(badRecord);
      fs.writeFileSync(path.join(badRecord, "database.sql"), "dump\n");
      fs.writeFileSync(path.join(badRecord, "recovery.json"), "not json");
      fs.mkdirSync(path.join(backups, "upgrade-not-a-uuid"));
      fs.mkdirSync(path.join(backups, "manual-copy"));
      fs.writeFileSync(path.join(backups, "upgrade-00000000-0000-4000-8000-000000000005"), "file");
      const current = await backupIn(store);
      const pruned = unwrap(store.pruneBackups(1, current));
      expect(pruned.removed.map((entry) => entry.directory)).toEqual([legacy.directory]);
      expect(pruned.held).toEqual([]);
      expect(fs.existsSync(path.join(target, "database.sql"))).toBe(true);
      expect(fs.existsSync(path.join(extra.directory, "database.sql"))).toBe(true);
      expect(fs.lstatSync(path.join(linkedDump.directory, "database.sql")).isSymbolicLink()).toBe(
        true,
      );
    });
    expect(result._tag).toBe("ok");
    expect(names(root)).toHaveLength(9);
  });
});
