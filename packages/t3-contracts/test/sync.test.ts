import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = "v0.0.1-nightly.20261013.1";
// Independent inventory: adding a mapping requires reviewing the expected copied contract.
const shared = [
  "Array",
  "assistantCitations",
  "backgroundActivitySettings",
  "changeRequestUrl",
  "codexArtifactTemplates",
  "codexFileCitations",
  "codexMarkdownDirectives",
  "composerContextLegacy",
  "composerContextReferences",
  "fileLinks",
  "inlineSkills",
  "keybindings",
  "markdownGithubAlerts",
  "markdownLinks",
  "markdownListIndentation",
  "markdownPipeline",
  "model",
  "orchestrationV2PendingBackgroundWork",
  "path",
  "proposedPlanText",
  "schemaJson",
  "serverSettings",
  "sourceControl",
  "Struct",
  "threadFindText",
  "threadLinks",
  "threadPullRequests",
  "threadSearch",
  "threadTranscript",
];
const clientRuntime = ["models", "subagentDisplay", "subagentRuntime", "threadSettled"];
const inventory: ReadonlyArray<{ upstream: string; local: string; bytes: string }> = [
  { upstream: "LICENSE", local: "LICENSE", bytes: "fixture license\n" },
  { upstream: "packages/contracts/src/a.ts", local: "src/a.ts", bytes: "export const a = 1;\n" },
  {
    upstream: "packages/contracts/src/nested/b.ts",
    local: "src/nested/b.ts",
    bytes: "export const b = 2;\n",
  },
  ...shared.map((name) => ({
    upstream: `packages/shared/src/${name}.ts`,
    local: `t3-shared/src/${name}.ts`,
    bytes: `export const ${name} = "shared";\n`,
  })),
  ...clientRuntime.map((name) => ({
    upstream: `packages/client-runtime/src/state/${name}.ts`,
    local: `client-runtime/${name}.ts`,
    bytes: `export const ${name} = "state";\n`,
  })),
];
const upstream = Object.fromEntries(inventory.map((file) => [file.upstream, file.bytes]));
const local = Object.fromEntries(inventory.map((file) => [file.local, file.bytes]));
const write = (root: string, name: string, bytes: string) => {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), bytes);
};
const fixture = (
  work: (f: {
    repo: string;
    target: string;
    root: string;
    git: (...args: string[]) => string;
    run: (sourceArgs?: ReadonlyArray<string>) => SpawnSyncReturns<string>;
  }) => void,
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-contract-sync-"));
  const repo = path.join(root, "upstream"),
    target = path.join(root, "package");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  try {
    fs.mkdirSync(repo);
    git("init", "-q");
    for (const [name, bytes] of Object.entries(upstream)) write(repo, name, bytes);
    git("add", ".");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "tagged fixture",
    );
    git("tag", tag);
    fs.mkdirSync(target);
    fs.cpSync(path.join(packageRoot, "scripts"), path.join(target, "scripts"), { recursive: true });
    write(target, "package.json", '{"type":"module"}\n');
    write(target, "src/previous.ts", "previous source\n");
    write(target, "t3-shared/src/keybindings.ts", "previous keybindings\n");
    write(target, "client-runtime/threadSettled.ts", "previous thread reading\n");
    write(target, "LICENSE", "previous license\n");
    write(target, "t3code.pin.json", "previous pin\n");
    work({
      root,
      repo,
      target,
      git,
      run: (sourceArgs = ["--source", repo]) =>
        spawnSync(
          process.execPath,
          ["--experimental-strip-types", "scripts/sync.ts", "--tag", tag, ...sourceArgs],
          { cwd: target, env, encoding: "utf8", timeout: 10_000 },
        ),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};
const snapshot = (root: string) =>
  Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        return [path.relative(root, full), fs.readFileSync(full).toString("hex")];
      }),
  );

it("copies the complete tagged mapping and pin, excluding dirty and unrelated files", () =>
  fixture(({ repo, target, git, run }) => {
    write(repo, "packages/contracts/src/a.ts", "dirty bytes\n");
    write(repo, "packages/contracts/src/untracked.ts", "untracked bytes\n");
    write(target, "t3-shared/package.json", "keep me\n");
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    for (const [name, bytes] of Object.entries(local))
      expect(fs.readFileSync(path.join(target, name), "utf8")).toBe(bytes);
    expect(fs.existsSync(path.join(target, "src/previous.ts"))).toBe(false);
    expect(fs.existsSync(path.join(target, "src/untracked.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "t3-shared/package.json"), "utf8")).toBe("keep me\n");
    const pin: unknown = JSON.parse(fs.readFileSync(path.join(target, "t3code.pin.json"), "utf8"));
    expect(pin).toEqual({
      repository: "https://github.com/pingdotgg/t3code.git",
      tag,
      commit: git("rev-parse", tag),
      files: Object.fromEntries(
        inventory.map((file) => [
          file.local,
          {
            upstream: file.upstream,
            blob: git("rev-parse", `${tag}:${file.upstream}`),
            sha256: createHash("sha256").update(file.bytes).digest("hex"),
          },
        ]),
      ),
    });
    expect(fs.readdirSync(target).filter((name) => name.startsWith(".sync-"))).toEqual([]);
  }));

it("preserves every previous byte and pin if a later Git blob read fails", () =>
  fixture(({ repo, target, git, run }) => {
    const blob = git("rev-parse", `${tag}:packages/contracts/src/nested/b.ts`);
    fs.rmSync(path.join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    const before = snapshot(target);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("packages/contracts/src/nested/b.ts");
    expect(snapshot(target)).toEqual(before);
  }));

it("preserves the old copy when a required mapped source is absent at the tag", () =>
  fixture(({ target, git, run }) => {
    git("rm", "packages/shared/src/keybindings.ts");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "remove required file",
    );
    git("tag", "-f", tag);
    const before = snapshot(target);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("packages/shared/src/keybindings.ts does not exist");
    expect(snapshot(target)).toEqual(before);
  }));

it("rolls back already replaced paths when a later destination cannot be installed", () =>
  fixture(({ target, run }) => {
    fs.rmSync(path.join(target, "client-runtime"), { recursive: true });
    write(target, "client-runtime", "existing non-directory obstacle\n");
    const before = snapshot(target);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(snapshot(target)).toEqual(before);
    expect(fs.readdirSync(target).filter((name) => name.startsWith(".sync-"))).toEqual([]);
  }));

it("removes its temporary repository after a failed fetch without touching the old copy", () =>
  fixture(({ root, repo, target, run }) => {
    const before = snapshot(target);
    const result = run(["--repository", path.join(repo, "missing-repository")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing-repository");
    expect(snapshot(target)).toEqual(before);
    expect(fs.readdirSync(root).filter((name) => name.startsWith("mend-t3code-"))).toEqual([]);
  }));

it("fetches a local tag, removes its scratch repository, and repeats without changing the copy", () =>
  fixture(({ root, repo, target, run }) => {
    const result = run(["--repository", repo]);
    expect(result.status, result.stderr).toBe(0);
    for (const [name, bytes] of Object.entries(local))
      expect(fs.readFileSync(path.join(target, name), "utf8")).toBe(bytes);
    const before = snapshot(target);
    const repeated = run(["--repository", repo]);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(snapshot(target)).toEqual(before);
    expect(fs.readdirSync(root).filter((name) => name.startsWith("mend-t3code-"))).toEqual([]);
    expect(fs.readdirSync(target).filter((name) => name.startsWith(".sync-"))).toEqual([]);
  }));
