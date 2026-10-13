import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FoldersRepo, ReferencesRepo } from "@mend/db";
import { FolderId, OrganizationId, ProjectId, ReferenceId, WorktreeId } from "@mend/domain";
import { Folder, ProjectFolder, Reference } from "@mend/domain/workbench";
import { BlobStoreFsLive, captureSourceKey } from "@mend/store";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { CaptureSources, CaptureSourcesLive, MAX_SOURCE_BYTES } from "../src/capture-sources.ts";

const PROJECT = ProjectId.make("proj-sources");
const WORKTREE = WorktreeId.make("wt-sources");
const EPOCH = 4;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-capture-sources-"));
const blobRoot = path.join(scratch, "blobs");

const folderAt = (name: string, folderPath: string, readOnly: boolean) => ({
  folder: new Folder({
    id: FolderId.make(`fold-${name}`),
    organizationId: OrganizationId.make("org-1"),
    name,
    path: folderPath,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  selection: new ProjectFolder({
    projectId: PROJECT,
    folderId: FolderId.make(`fold-${name}`),
    name,
    readOnly,
    createdAt: new Date(),
  }),
});

const referenceAt = (name: string, clonePath: string) =>
  new Reference({
    id: ReferenceId.make(`ref-${name}`),
    name,
    organizationId: OrganizationId.make("org-1"),
    createdByUserId: null,
    originUrl: `https://example.test/${name}.git`,
    path: clonePath,
    pinnedRef: null,
    headSha: null,
    refreshedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

const published = (
  folders: ReadonlyArray<ReturnType<typeof folderAt>>,
  references: ReadonlyArray<Reference>,
  storageRoot = blobRoot,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sources = yield* CaptureSources;
      return yield* sources.forProject(PROJECT, WORKTREE, EPOCH);
    }).pipe(
      Effect.provide(
        CaptureSourcesLive.pipe(
          Layer.provide(Layer.mock(FoldersRepo, { listForProject: () => Effect.succeed(folders) })),
          Layer.provide(
            Layer.mock(ReferencesRepo, { listForProject: () => Effect.succeed(references) }),
          ),
          Layer.provide(BlobStoreFsLive(storageRoot)),
        ),
      ),
    ),
  );

/** What the archive holds, as the daemon's `tar -xzf` would see it. */
const entriesOf = (key: string): ReadonlyArray<string> =>
  execFileSync("tar", ["-tzf", path.join(blobRoot, key)], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((line) => line !== "");

describe("capture sources", () => {
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("publishes a folder's contents under the session's epoch, keyed by the archive's digest", async () => {
    const docs = path.join(scratch, "docs");
    fs.mkdirSync(path.join(docs, "guides"), { recursive: true });
    fs.writeFileSync(path.join(docs, "NOTES.md"), "read me\n");
    fs.writeFileSync(path.join(docs, "guides", "style.md"), "terse\n");

    const [source, ...rest] = await published([folderAt("docs", docs, true)], []);
    expect(rest).toEqual([]);
    if (source === undefined) throw new Error("no source");
    expect(source.name).toBe("docs");
    // Beside the worktree, never inside it: sealantd refuses a path under the working directory.
    expect(source.path).toBe("/workspace/home/docs");
    expect(source.read_only).toBe(true);
    expect(source.key).toBe(captureSourceKey(WORKTREE, EPOCH, source.sha256));
    expect(fs.statSync(path.join(blobRoot, source.key)).size).toBe(source.bytes);
    // The folder's contents are the mount, so its own directory name is not in the archive.
    expect(entriesOf(source.key)).toEqual(
      expect.arrayContaining(["NOTES.md", "guides", "guides/style.md"]),
    );
    expect(entriesOf(source.key)).not.toContain("docs");

    // The digest is the content's: the same folder publishes the same key again, and an edit
    // moves it (which is what tells sealantd to extract again).
    const [again] = await published([folderAt("docs", docs, true)], []);
    expect(again?.sha256).toBe(source.sha256);
    fs.writeFileSync(path.join(docs, "NOTES.md"), "read me twice\n");
    const [edited] = await published([folderAt("docs", docs, true)], []);
    expect(edited?.sha256).not.toBe(source.sha256);
  });

  it("carries a writable selection as writable, and a reference as its tree without the history", async () => {
    const shared = path.join(scratch, "shared");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "scratch.txt"), "notes\n");

    const clone = path.join(scratch, "effect-clone");
    fs.mkdirSync(path.join(clone, "src"), { recursive: true });
    fs.writeFileSync(path.join(clone, "src", "index.ts"), "export const one = 1;\n");
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "t@t"],
      ["config", "user.name", "t"],
      ["add", "-A"],
      ["commit", "-q", "-m", "one"],
    ]) {
      execFileSync("git", args, { cwd: clone, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    }

    const sources = await published(
      [folderAt("shared", shared, false)],
      [referenceAt("effect", clone)],
    );
    const folder = sources.find((source) => source.name === "shared");
    const reference = sources.find((source) => source.name === "effect");
    expect(folder?.read_only).toBe(false);
    // A reference is read-only by definition: it is upstream source material, not the work.
    expect(reference?.read_only).toBe(true);
    expect(reference?.path).toBe("/workspace/ref/effect");
    if (reference === undefined) throw new Error("no reference");
    // `git archive HEAD` — the tree an agent reads, without the history behind it.
    const entries = entriesOf(reference.key);
    expect(entries).toEqual(expect.arrayContaining(["src/index.ts"]));
    expect(entries.some((entry) => entry.startsWith(".git"))).toBe(false);
  });

  it("leaves out a source it cannot archive, so one folder never costs the session", async () => {
    const good = path.join(scratch, "good");
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, "ok.md"), "fine\n");

    const sources = await published(
      [folderAt("gone", path.join(scratch, "not-here"), true), folderAt("good", good, true)],
      // A directory that is not a git repository: `git archive` fails, the rest still travel.
      [referenceAt("bare", good)],
    );
    expect(sources.map((source) => source.name)).toEqual(["good"]);
  });

  it("omits an actually oversized compressed source while publishing its small neighbor", async () => {
    const owned = fs.mkdtempSync(path.join(scratch, "overflow-"));
    const large = path.join(owned, "large");
    const small = path.join(owned, "small");
    const storage = path.join(owned, "blobs");
    try {
      fs.mkdirSync(large);
      fs.mkdirSync(small);
      fs.writeFileSync(path.join(small, "keep.txt"), "small source survives\n");
      const fd = fs.openSync(path.join(large, "noise.bin"), "wx");
      try {
        // Fresh noise cannot collapse below the compressed-byte ceiling as repeated zeroes do.
        for (let offset = 0; offset < 64 * 1024 * 1024 + 64 * 1024; offset += 64 * 1024) {
          fs.writeSync(fd, randomBytes(64 * 1024));
        }
      } finally {
        fs.closeSync(fd);
      }
      const archive = path.join(owned, "large.tar.gz");
      execFileSync("tar", ["-czf", archive, "."], { cwd: large });
      expect(fs.statSync(archive).size).toBeGreaterThan(64 * 1024 * 1024);

      const sources = await published(
        [folderAt("oversized", large, true), folderAt("small", small, true)],
        [],
        storage,
      );
      expect(sources.map((source) => source.name)).toEqual(["small"]);
      const [retained] = sources;
      if (retained === undefined) throw new Error("small source was not published");
      expect(
        execFileSync("tar", ["-xOzf", path.join(storage, retained.key), "./keep.txt"], {
          encoding: "utf8",
        }),
      ).toBe("small source survives\n");
      const files = fs
        .readdirSync(storage, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(storage, path.join(entry.parentPath, entry.name)));
      expect(files).toEqual([retained.key]);
      expect(fs.statSync(path.join(storage, retained.key)).size).toBe(retained.bytes);
      expect(retained.bytes).toBeLessThan(64 * 1024 * 1024);
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  }, 30_000);

  it("caps one source at the size sealantd will accept", () => {
    expect(MAX_SOURCE_BYTES).toBe(64 * 1024 * 1024);
  });
});
