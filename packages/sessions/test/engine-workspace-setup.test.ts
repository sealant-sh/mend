import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  HotWorkspacesRepo,
  ReferenceNotFoundError,
  ReferencesRepo,
  WorktreesRepo,
  UserDotfilesRepo,
  UserGitAuthorRepo,
  InstanceRolesRepo,
} from "@mend/db";
import {
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  defaultSettings,
  type DotfilesRepository,
  ReferenceId,
} from "@mend/domain";
import { HotWorkspace, Project, ResolvedGitAuthor, Reference } from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { SessionEngine, WorkspaceGitHooks } from "@mend/sessions";
import { DotfilesStore, DotfilesStoreError, harnessHomePathOf } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Exit, Layer } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import {
  CUSTOM_BASE,
  NEWER_SNAPSHOT,
  SNAPSHOT,
  dotfilesStoreLayer,
  isShellProfileExec,
  launchOnce,
  provisionIn,
  type LaunchImage,
} from "./engine/capture-fixture.ts";
import { signalledFixture } from "./engine/clock-fixture.ts";
import {
  dotfilesClonerLayer,
  launchSkill,
  now,
  pickedUpWrites,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  skillsForLaunchLayer,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

/** No machine key and no transport log in these worlds. */
// Dotfiles resolve per owner; the engine fixtures run without any configured, so launches
// carry no archives and stamp an empty record.
/** The exec that writes the owner's git author as system config (`gitAuthorConfigArgv`). */
const isGitAuthorExec = (argv: ReadonlyArray<string>): boolean => argv[3] === "mend-git-author";

/** A default shell profile file as shipped (`packages/sessions/src/shell-profile/`). */
const shellProfileAsset = (name: string) =>
  fs.readFileSync(new URL(`../src/shell-profile/${name}`, import.meta.url), "utf8");

const gunzipped = (text: string) => gunzipSync(Buffer.from(text, "base64"));

/**
 * What the batched write execs put where: absolute workspace path → contents. Reads the writer's
 * operations (`workspace-files.ts`): `w` writes, `s`/`a` stage, `f` writes what was staged.
 */
const writtenFiles = (execCalls: ReadonlyArray<ReadonlyArray<string>>): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  const staged = new Map<string, string>();
  for (const argv of execCalls) {
    if (argv[3] !== "mend-write") continue;
    const picked = pickedUpWrites.get(argv);
    if (picked !== undefined) {
      for (const file of picked) files.set(file.path, Buffer.from(file.base64, "base64"));
      continue;
    }
    const ops = argv.slice(4);
    let index = 0;
    const list = () => {
      const count = Number(ops[index++]);
      const out = ops.slice(index, index + count);
      index += count;
      return out;
    };
    while (index < ops.length) {
      const op = ops[index++];
      if (op === "w") {
        const paths = list();
        const bytes = gunzipped(list().join(""));
        for (const target of paths) files.set(target, bytes);
      } else if (op === "s" || op === "a") {
        const staging = ops[index++] ?? "";
        const text = list().join("");
        staged.set(staging, (op === "a" ? (staged.get(staging) ?? "") : "") + text);
      } else if (op === "f") {
        const staging = ops[index++] ?? "";
        const paths = list();
        const bytes = gunzipped(staged.get(staging) ?? "");
        for (const target of paths) files.set(target, bytes);
      } else {
        throw new Error(`unknown write operation ${op ?? ""}`);
      }
    }
  }
  return files;
};

/** A path on the fixture's git daemon, beside the adopted origin. */
const servedUrl = (project: Project, name: string): string => {
  if (project.originUrl === null) throw new Error("the fixture project has no origin");
  return project.originUrl.replace(/\/origin$/, `/${name}`);
};

/** A dotfiles repo beside the fixture origin, served by the same git daemon. */
const dotfilesOrigin = (tmp: string, project: Project): string => {
  const dots = path.join(tmp, "dots");
  fs.mkdirSync(dots, { recursive: true });
  const run = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [...args], {
      cwd: dots,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "dots",
        GIT_AUTHOR_EMAIL: "dots@localhost",
        GIT_COMMITTER_NAME: "dots",
        GIT_COMMITTER_EMAIL: "dots@localhost",
      },
    });
  run("init", "-b", "main");
  fs.writeFileSync(path.join(dots, ".vimrc"), "set nocompatible\n");
  run("add", "-A");
  run("commit", "-m", "dots");
  return servedUrl(project, "dots");
};

/** The owner's repository knob, read from a cell the test fills once the daemon is up. */
const userDotfilesLayer = (
  cell: { repository: DotfilesRepository | null },
  reads: Array<string> = [],
): Layer.Layer<UserDotfilesRepo> =>
  Layer.succeed(UserDotfilesRepo, {
    repository: (userId) =>
      Effect.sync(() => {
        reads.push(userId);
        return cell.repository;
      }),
    setRepository: (_userId, value) => Effect.succeed(value),
    startAgentsAfterInstall: () => Effect.succeed(false),
    setStartAgentsAfterInstall: (_userId, value) => Effect.succeed(value),
  });

const repositoryOf = (url: string): DotfilesRepository => ({
  url,
  ref: null,
  subdirectory: null,
  manager: "stow",
  bootstrap: false,
});

const ZSH_FAMILY: LaunchImage = {
  mode: "family",
  os: "arch",
  packages: [],
  shell: "zsh",
  services: { docker: false },
  screen: false,
};

/** A store whose snapshot per owner is whatever `snapshots` says right now; every read lands in `reads`. */
const ownedSnapshotsLayer = (
  snapshots: Map<string, { readonly sha: string; readonly data: string }>,
  reads: Array<string> = [],
): Layer.Layer<DotfilesStore> =>
  Layer.succeed(DotfilesStore, {
    snapshot: () => Effect.die("not in test"),
    current: (userId) =>
      Effect.sync(() => {
        const snapshot = snapshots.get(userId);
        return snapshot === undefined
          ? null
          : { sha: snapshot.sha, source: "laptop", committedAt: new Date(0), files: [] };
      }),
    archive: (userId) =>
      Effect.sync(() => {
        reads.push(`snapshot of ${userId}`);
        return snapshots.get(userId) ?? null;
      }),
    clear: () => Effect.void,
  });

/** The owner's repository knob per account; every read lands in `reads`. */
const ownedRepositoriesLayer = (
  repositories: Map<string, DotfilesRepository>,
  reads: Array<string> = [],
): Layer.Layer<UserDotfilesRepo> =>
  Layer.succeed(UserDotfilesRepo, {
    repository: (userId) =>
      Effect.sync(() => {
        reads.push(`repository of ${userId}`);
        return repositories.get(userId) ?? null;
      }),
    setRepository: (_userId, value) => Effect.succeed(value),
    startAgentsAfterInstall: () => Effect.succeed(false),
    setStartAgentsAfterInstall: (_userId, value) => Effect.succeed(value),
  });

describe("SessionEngine workspace git hooks", () => {
  it.effect(
    "reports an ended agent while its workspace is still up, before the sweep stops it",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const stopped: string[] = [];
        const heard: Array<{ readonly sessionId: string; readonly stoppedYet: number }> = [];
        const hooks = Layer.succeed(WorkspaceGitHooks, {
          branchesPushed: () => Effect.void,
          agentEnded: (event) =>
            Effect.sync(
              () => void heard.push({ sessionId: event.sessionId, stoppedYet: stopped.length }),
            ),
          pullRequestOpened: () => Effect.void,
          register: () => Effect.void,
          landRequested: () => Effect.succeed({ landed: false, lines: [] }),
          registerLanding: () => Effect.void,
        });
        /** The stop's tail asked the platform to stop the workspace. */
        const workspaceStopped = yield* Deferred.make<void>();
        const signallingStops = Layer.effect(
          SealantClient,
          Effect.map(SealantClient, (client) => ({
            ...client,
            stopWorkspace: (workspace, options) =>
              client
                .stopWorkspace(workspace, options)
                .pipe(Effect.ensuring(Deferred.succeed(workspaceStopped, undefined))),
          })),
        ).pipe(Layer.provide(sealantLaunchLayer(created, undefined, stopped)));
        yield* withPreparedEngineEffect(
          (world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* Deferred.await(workspaceStopped);
              expect(heard).toEqual([{ sessionId: session.id, stoppedYet: 0 }]);
              expect(stopped).toEqual(["workspace-1"]);
            }),
          { sealantLayer: signallingStops, gitHooksLayer: hooks },
        );
      }),
  );
});

describe("SessionEngine workspace git hooks: pushes", () => {
  it("reports a push through the transport that moved a branch, and nothing else", async () => {
    const created: CreateOptions[] = [];
    const pushed: Array<string> = [];
    const hooks = Layer.succeed(WorkspaceGitHooks, {
      branchesPushed: (event) => Effect.sync(() => void pushed.push(event.worktreeId)),
      agentEnded: () => Effect.void,
      pullRequestOpened: () => Effect.void,
      register: () => Effect.void,
      landRequested: () => Effect.succeed({ landed: false, lines: [] }),
      registerLanding: () => Effect.void,
    });
    const zero = "0".repeat(40);
    const next = "a".repeat(40);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["codex"]);
          const api = servedSocketApis.get(session.id);
          if (api === undefined) return yield* Effect.die("no socket api served");
          yield* api.gitTransportDone("op-tag", 0, [`${zero} ${next} refs/tags/v1`]);
          yield* api.gitTransportDone("op-failed", 1, [`${zero} ${next} refs/heads/wip`]);
          yield* api.gitTransportDone("op-fetch", 0, null);
          expect(pushed).toEqual([]);
          yield* api.gitTransportDone("op-push", 0, [`${zero} ${next} refs/heads/chore/bump`]);
          expect(pushed).toEqual([session.worktreeId]);
        }),
      { sealantLayer: sealantLaunchLayer(created), gitHooksLayer: hooks },
    );
  });
});

describe("SessionEngine git author", () => {
  const savedAuthor = Layer.succeed(UserGitAuthorRepo, {
    resolve: (userId) =>
      Effect.succeed(
        userId === "user-fixture"
          ? new ResolvedGitAuthor({
              name: "Anna Example",
              email: "anna@example.com",
              source: "setting",
            })
          : null,
      ),
    set: () => Effect.void,
    clear: () => Effect.void,
  });

  /** Launch one codex session; report what ran in the workspace before the harness opened. */
  const launchAndWatch = async (captured: MemoryCaptureStore | undefined) => {
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const beforeHarness: Array<ReadonlyArray<string>> = [];
    let opened = false;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["codex"]);
        }),
      {
        ...(captured === undefined ? {} : { captured }),
        gitAuthorLayer: savedAuthor,
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
          undefined,
          {
            beforeOpen: () => {
              if (opened) return;
              opened = true;
              beforeHarness.push(...execCalls);
            },
          },
        ),
      },
    );
    return { created, execCalls, beforeHarness };
  };

  it("writes the owner's author as system git config before the harness starts", async () => {
    const { created, execCalls, beforeHarness } = await launchAndWatch(undefined);
    expect(execCalls.filter(isGitAuthorExec)).toEqual([
      [
        "sh",
        "-c",
        'git config --system user.name "$1" && git config --system user.email "$2"',
        "mend-git-author",
        "Anna Example",
        "anna@example.com",
      ],
    ]);
    expect(beforeHarness.some(isGitAuthorExec)).toBe(true);
    // Never as env: GIT_AUTHOR_* would override the owner's dotfiles and the repository's config.
    const env = created[0]?.env ?? {};
    expect(Object.keys(env).filter((name) => name.startsWith("GIT_"))).toEqual([]);
  });

  it("writes it in a captured workspace too, where nothing is mounted", async () => {
    const { created, execCalls, beforeHarness } = await launchAndWatch(makeMemoryCaptureStore());
    expect(created[0]?.source?.kind).toBe("capture");
    expect(execCalls.filter(isGitAuthorExec).map((argv) => argv.slice(4))).toEqual([
      ["Anna Example", "anna@example.com"],
    ]);
    expect(beforeHarness.some(isGitAuthorExec)).toBe(true);
  });
});

describe("SessionEngine default shell profile", () => {
  const ZSHRC = shellProfileAsset("zshrc");
  const STARSHIP = shellProfileAsset("starship.toml");
  const DOTFILES_ZSHRC = "# from the owner's dotfiles\n";
  const DOTFILES_STARSHIP = "add_newline = true\n";

  /**
   * Launch one codex session into `image`, with the workspace's `$HOME` a real directory: the
   * profile exec runs its own script there, as the workspace would, and every other exec answers
   * exit 0. `dotfiles` puts what the owner's dotfiles left in `$HOME` before the launch; the
   * result reads both profile paths back after it.
   */
  const launchWithHome = async (options: {
    readonly captured?: MemoryCaptureStore;
    readonly image?: LaunchImage;
    readonly defaultShellProfile?: boolean;
    readonly dotfiles?: { readonly zshrc?: boolean; readonly starship?: boolean };
  }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-shell-profile-home-"));
    if (options.dotfiles?.zshrc === true) {
      fs.writeFileSync(path.join(home, ".zshrc"), DOTFILES_ZSHRC);
    }
    if (options.dotfiles?.starship === true) {
      fs.mkdirSync(path.join(home, ".config"));
      fs.writeFileSync(path.join(home, ".config", "starship.toml"), DOTFILES_STARSHIP);
    }
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const beforeHarness: Array<ReadonlyArray<string>> = [];
    let opened = false;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          if (options.defaultShellProfile !== undefined) {
            world.projects.set(
              project.id,
              new Project({ ...project, defaultShellProfile: options.defaultShellProfile }),
            );
          }
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["codex"]);
        }),
      {
        ...(options.captured === undefined ? {} : { captured: options.captured }),
        workspaceImage: options.image ?? ZSH_FAMILY,
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
          undefined,
          {
            beforeOpen: () => {
              if (opened) return;
              opened = true;
              beforeHarness.push(...execCalls);
            },
            exec: (argv) => {
              if (!isShellProfileExec(argv)) return undefined;
              const result = spawnSync("sh", argv.slice(1), {
                env: { ...process.env, HOME: home },
                encoding: "utf8",
              });
              return {
                exitCode: result.status ?? 1,
                stdout: result.stdout,
                stderr: result.stderr,
              };
            },
          },
        ),
      },
    );
    const read = (relative: string) => {
      const file = path.join(home, relative);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    };
    const zshrc = read(".zshrc");
    const starship = read(".config/starship.toml");
    fs.rmSync(home, { recursive: true, force: true });
    return {
      created,
      profileExecs: execCalls.filter(isShellProfileExec),
      beforeHarness,
      zshrc,
      starship,
    };
  };

  it("writes ~/.zshrc and ~/.config/starship.toml into a zsh workspace with neither, before the harness starts", async () => {
    const launched = await launchWithHome({});
    expect(launched.profileExecs).toHaveLength(1);
    expect(launched.beforeHarness.some(isShellProfileExec)).toBe(true);
    expect(launched.zshrc).toBe(ZSHRC);
    expect(launched.starship).toBe(STARSHIP);
  });

  it("leaves each file the owner's dotfiles put there and writes only the other", async () => {
    const keptZshrc = await launchWithHome({ dotfiles: { zshrc: true } });
    expect(keptZshrc.zshrc).toBe(DOTFILES_ZSHRC);
    expect(keptZshrc.starship).toBe(STARSHIP);

    const keptStarship = await launchWithHome({ dotfiles: { starship: true } });
    expect(keptStarship.zshrc).toBe(ZSHRC);
    expect(keptStarship.starship).toBe(DOTFILES_STARSHIP);
  });

  it("does the same in a captured workspace, where nothing is mounted", async () => {
    const fresh = await launchWithHome({ captured: makeMemoryCaptureStore() });
    expect(fresh.created[0]?.source?.kind).toBe("capture");
    expect(fresh.beforeHarness.some(isShellProfileExec)).toBe(true);
    expect(fresh.zshrc).toBe(ZSHRC);
    expect(fresh.starship).toBe(STARSHIP);

    const kept = await launchWithHome({
      captured: makeMemoryCaptureStore(),
      dotfiles: { zshrc: true, starship: true },
    });
    expect(kept.profileExecs).toHaveLength(1);
    expect(kept.zshrc).toBe(DOTFILES_ZSHRC);
    expect(kept.starship).toBe(DOTFILES_STARSHIP);
  });

  it("writes nothing when the project turns it off", async () => {
    for (const captured of [undefined, makeMemoryCaptureStore()]) {
      const launched = await launchWithHome({
        ...(captured === undefined ? {} : { captured }),
        defaultShellProfile: false,
      });
      expect(launched.profileExecs).toEqual([]);
      expect(launched.zshrc).toBeNull();
      expect(launched.starship).toBeNull();
    }
  });

  it("writes nothing into a bash family image or a custom base", async () => {
    for (const image of [{ ...ZSH_FAMILY, shell: "bash" as const }, CUSTOM_BASE]) {
      const launched = await launchWithHome({ image });
      expect(launched.profileExecs).toEqual([]);
      expect(launched.zshrc).toBeNull();
    }
  });
});

describe("SessionEngine files into a captured workspace", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const captureLayer = (created: CreateOptions[], execCalls: ReadonlyArray<string>[]) =>
    sealantLaunchLayer(
      created,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      execCalls,
    );

  it("places a pasted image in the live workspace's harness home, not on this machine", async () => {
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          // No workspace yet: nowhere a harness would read the file, so nothing is stored.
          const early = yield* engine
            .storePastedImage(session.id, PNG, "user-fixture")
            .pipe(Effect.flip);
          expect(early._tag).toBe("SessionNotLiveError");

          yield* engine.launch(session.id, ["codex"]);
          const placed = yield* engine.storePastedImage(session.id, PNG, "user-fixture");
          expect(placed.path).toMatch(/^\/workspace\/harness-home\/paste\/\d{8}-\d{6}-\w{4}\.png$/);
          expect(placed.mediaType).toBe("image/png");
          expect(new Uint8Array(writtenFiles(execCalls).get(placed.path) ?? [])).toEqual(PNG);
          expect(
            fs.existsSync(path.join(harnessHomePathOf(project.storePath, session.id), "paste")),
          ).toBe(false);

          const refused = yield* engine
            .storePastedImage(session.id, new TextEncoder().encode("not an image"), "user-fixture")
            .pipe(Effect.flip);
          expect(refused._tag).toBe("PastedImageError");
        }),
      { captured: makeMemoryCaptureStore(), sealantLayer: captureLayer(created, execCalls) },
    );
  });

  it("keeps writing a co-located paste beside the store, launched or not", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          projectId: project.id,
          harness: "codex",
          label: null,
          name: null,
          ownerUserId: "user-fixture",
          start: { kind: "base", base: null },
        });
        const placed = yield* engine.storePastedImage(session.id, PNG, "user-fixture");
        const hostPath = path.join(
          harnessHomePathOf(project.storePath, session.id),
          "paste",
          path.posix.basename(placed.path),
        );
        expect(new Uint8Array(fs.readFileSync(hostPath))).toEqual(PNG);
      }),
    );
  });

  it("delivers the owner's skills into a captured workspace's harness home", async () => {
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const skillsLayer = skillsForLaunchLayer((ownerUserId, projectId) =>
      Effect.succeed({
        user: [
          launchSkill("global", "owner global", {
            scope: "user",
            userId: ownerUserId ?? "missing-owner",
          }),
        ],
        project: [launchSkill("local", "project local", { scope: "project", projectId })],
      }),
    );
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["codex"]);
          const written = writtenFiles(execCalls);
          const text = (file: string) => written.get(file)?.toString("utf8");
          for (const target of [".claude/skills", ".codex/skills", ".pi/agent/skills"]) {
            expect(text(`/workspace/harness-home/${target}/global/SKILL.md`)).toBe("owner global");
            expect(text(`/workspace/harness-home/${target}/local/SKILL.md`)).toBe("project local");
          }
          expect(
            JSON.parse(text("/workspace/harness-home/.mend-managed-skills.json") ?? "{}"),
          ).toEqual({
            ".claude/skills": ["global", "local"],
            ".codex/skills": ["global", "local"],
            ".pi/agent/skills": ["global", "local"],
          });
          expect(
            JSON.parse(text("/workspace/harness-home/.mend-managed-skills-digests.json") ?? "{}"),
          ).toMatchObject({ ".claude/skills": { global: expect.any(String) } });
          // The bundles are rewritten whole: their old directories are cleared first, each one
          // only if it is exactly what Mend delivered, else kept aside.
          const prepared = execCalls.find((argv) => argv[3] === "mend-skills");
          expect(prepared?.[4]).toBe("/workspace/harness-home");
          expect(prepared?.[5]).toMatch(/^\.mend\/skills-kept\//);
          const vacate: ReadonlyArray<{ dir: string; accept: ReadonlyArray<string> }> = JSON.parse(
            prepared?.[6] ?? "[]",
          );
          expect(vacate.map((entry) => entry.dir)).toContain(".claude/skills/global");
          expect(prepared?.[2]).not.toContain("rm -rf");
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: captureLayer(created, execCalls),
        skillsLayer,
      },
    );
  });
});

describe("SessionEngine hot sessions", () => {
  /**
   * An in-memory pool with one skeleton. `claim` ignores the fingerprint — the test simulates a
   * project whose inputs still match — and `create` dies so the post-claim rewarm stops before
   * touching the platform (its worktree creation is real and harmless in the tmp store).
   */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const hotPoolLayer = (pool: { entries: Array<HotWorkspace>; removed: Array<string> }) =>
    Layer.succeed(HotWorkspacesRepo, {
      create: () => Effect.die("not in test"),
      byId: (id) => Effect.sync(() => pool.entries.find((entry) => entry.id === id) ?? null),
      listForProject: (projectId) =>
        Effect.sync(() => pool.entries.filter((entry) => entry.projectId === projectId)),
      listAll: () => Effect.sync(() => [...pool.entries]),
      setReady: () => Effect.void,
      setBaseSha: () => Effect.void,
      setFailed: () => Effect.void,
      claim: (projectId) =>
        Effect.sync(() => {
          const index = pool.entries.findIndex(
            (entry) => entry.projectId === projectId && entry.status === "ready",
          );
          const entry = pool.entries[index];
          if (entry === undefined) return null;
          const claimed = new HotWorkspace({ ...entry, status: "claimed", updatedAt: now() });
          pool.entries[index] = claimed;
          return claimed;
        }),
      remove: (id) =>
        Effect.sync(() => {
          pool.removed.push(id);
          pool.entries = pool.entries.filter((entry) => entry.id !== id);
        }),
    });

  it("claims a ready skeleton: provision adopts its id and launch skips the create", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          // A standby skeleton (ADR-0001): a live workspace over the project's worktrees root,
          // no worktree of its own — the claiming session brings one and the launch binds it.
          pool.entries.push(
            new HotWorkspace({
              id: skeletonId,
              projectId: project.id,
              worktreeId: null,
              ownerUserId: "user-fixture",
              status: "ready",
              error: null,
              fingerprint: "match-simulated-by-the-fake-claim",
              remoteSsh: "not-taken",
              harnessLayout: "shared",
              worktree: null,
              branch: null,
              baseSha: null,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              workspaceImage: defaultSettings.workspaceImage,
              // What the prewarm applied, a source it left out included, is what the claiming
              // session records.
              dotfiles: {
                repository: { url: "https://example.test/dots.git", ref: null },
                snapshotSha: null,
                notApplied: [{ source: "repository", reason: "dotfiles clone failed" }],
              },
              environment: {
                environmentRevision: 0,
                environmentVariableNames: [],
                secretRevision: 0,
                secretNames: [],
              },
              referenceMounts: [],
              extraMounts: [],
              createdAt: now(),
              updatedAt: now(),
            }),
          );

          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          // The session adopted the skeleton's id, and brought a worktree of its own.
          expect(session.id).toBe(skeletonId);
          expect(session.worktree).toMatch(/^wt-/);
          expect(session.branch).toBe(`mend/wt/${session.worktreeId}`);
          const worktreesRepo = yield* WorktreesRepo;
          expect((yield* worktreesRepo.byId(session.worktreeId))?.directory).toBe(session.worktree);

          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(0);
          expect(spawned.length).toBeGreaterThan(0);
          // The claimed standby receives the owner's git author at claim, as a cold one does.
          expect(execCalls.filter(isGitAuthorExec).map((argv) => argv.slice(4))).toEqual([
            ["Account user-fixture", "user-fixture@accounts.example"],
          ]);
          // …and the default shell profile: the standby's image is the zsh default.
          expect(execCalls.filter(isShellProfileExec)).toHaveLength(1);
          expect(pool.removed).toContain(skeletonId);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.sealantWorkspaceId).toBe("workspace-1");
          expect(launched?.dotfiles).toEqual({
            repository: { url: "https://example.test/dots.git", ref: null },
            snapshotSha: null,
            notApplied: [{ source: "repository", reason: "dotfiles clone failed" }],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          () => false,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
        ),
        hotWorkspacesLayer: hotPoolLayer(pool),
      },
    );
  });

  it("never serves a Claude or Codex session of an owner who chose the selected agent's login only from a standby: it goes cold with the narrower create", async () => {
    const created: CreateOptions[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          // Made with every login its owner connected (`platformShape("shell")`).
          pool.entries.push(
            new HotWorkspace({
              id: skeletonId,
              projectId: project.id,
              worktreeId: null,
              ownerUserId: "user-fixture",
              status: "ready",
              error: null,
              fingerprint: "match-simulated-by-the-fake-claim",
              remoteSsh: "not-taken",
              harnessLayout: "shared",
              worktree: null,
              branch: null,
              baseSha: null,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              workspaceImage: defaultSettings.workspaceImage,
              dotfiles: { repository: null, snapshotSha: null, notApplied: [] },
              environment: {
                environmentRevision: 0,
                environmentVariableNames: [],
                secretRevision: 0,
                secretNames: [],
              },
              referenceMounts: [],
              extraMounts: [],
              createdAt: now(),
              updatedAt: now(),
            }),
          );

          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          expect(session.id).not.toBe(skeletonId);
          yield* engine.launch(session.id, ["codex"]);

          expect(created.map((options) => options.credentials)).toEqual([
            { codex: true, github: true },
          ]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        hotWorkspacesLayer: hotPoolLayer(pool),
        selectedOnly: new Set(["user-fixture"]),
      },
    );
  });

  it("drains a standby claimed before its owner chose the selected agent's login only, and launches cold with the narrower create", async () => {
    const created: CreateOptions[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    // Read at each launch, so the choice made between provision and launch is the one that counts.
    const selectedOnly = new Set<string>();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          // Made with every login its owner connected (`platformShape("shell")`).
          pool.entries.push(
            new HotWorkspace({
              id: skeletonId,
              projectId: project.id,
              worktreeId: null,
              ownerUserId: "user-fixture",
              status: "ready",
              error: null,
              fingerprint: "match-simulated-by-the-fake-claim",
              remoteSsh: "not-taken",
              harnessLayout: "shared",
              worktree: null,
              branch: null,
              baseSha: null,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              workspaceImage: defaultSettings.workspaceImage,
              dotfiles: { repository: null, snapshotSha: null, notApplied: [] },
              environment: {
                environmentRevision: 0,
                environmentVariableNames: [],
                secretRevision: 0,
                secretNames: [],
              },
              referenceMounts: [],
              extraMounts: [],
              createdAt: now(),
              updatedAt: now(),
            }),
          );

          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          // Claimed while the owner gave every login.
          expect(session.id).toBe(skeletonId);
          selectedOnly.add("user-fixture");
          yield* engine.launch(session.id, ["codex"]);

          // The standby went; the launch made its own workspace naming Codex and GitHub only.
          expect(pool.removed).toContain(skeletonId);
          expect(created.map((options) => options.credentials)).toEqual([
            { codex: true, github: true },
          ]);
          expect(world.sessions.get(session.id)?.status).toBe("running");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        hotWorkspacesLayer: hotPoolLayer(pool),
        selectedOnly,
      },
    );
  });

  it("claims a ready skeleton for a new conversation inside an existing worktree too", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          // A standby skeleton (ADR-0001): a live workspace over the project's worktrees root,
          // no worktree of its own — the claiming session brings one and the launch binds it.
          pool.entries.push(
            new HotWorkspace({
              id: skeletonId,
              projectId: project.id,
              worktreeId: null,
              ownerUserId: "user-fixture",
              status: "ready",
              error: null,
              fingerprint: "match-simulated-by-the-fake-claim",
              remoteSsh: "not-taken",
              harnessLayout: "shared",
              worktree: null,
              branch: null,
              baseSha: null,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              workspaceImage: defaultSettings.workspaceImage,
              dotfiles: { repository: null, snapshotSha: null, notApplied: [] },
              environment: {
                environmentRevision: 0,
                environmentVariableNames: [],
                secretRevision: 0,
                secretNames: [],
              },
              referenceMounts: [],
              extraMounts: [],
              createdAt: now(),
              updatedAt: now(),
            }),
          );

          const engine = yield* SessionEngine;
          // The worktree already exists (a durable place, or one holding other sessions): the
          // worktree-scoped verb — "s session here", the web's new conversation — claims too.
          const place = yield* engine.ensureWorktree(
            project.id,
            { name: "shared-place", start: { kind: "base", base: null } },
            "user-fixture",
          );
          const session = yield* engine.provisionSessionIn(place.id, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(session.id).toBe(skeletonId);
          expect(session.worktreeId).toBe(place.id);
          expect(session.worktree).toBe(place.directory);
          const worktreesRepo = yield* WorktreesRepo;
          expect((yield* worktreesRepo.byId(session.worktreeId))?.directory).toBe(session.worktree);

          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(0);
          expect(spawned.length).toBeGreaterThan(0);
          expect(pool.removed).toContain(skeletonId);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.sealantWorkspaceId).toBe("workspace-1");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, () => false, undefined, spawned),
        hotWorkspacesLayer: hotPoolLayer(pool),
      },
    );
  });

  /** A ready co-located standby over `project`'s worktrees root, as the hot pool keeps one. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const readyStandby = (projectId: ProjectId, id: SessionId) =>
    new HotWorkspace({
      id,
      projectId,
      worktreeId: null,
      ownerUserId: "user-fixture",
      status: "ready",
      error: null,
      fingerprint: "match-simulated-by-the-fake-claim",
      remoteSsh: "not-taken",
      harnessLayout: "shared",
      worktree: null,
      branch: null,
      baseSha: null,
      sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
      workspaceImage: defaultSettings.workspaceImage,
      dotfiles: { repository: null, snapshotSha: null, notApplied: [] },
      environment: {
        environmentRevision: 0,
        environmentVariableNames: [],
        secretRevision: 0,
        secretNames: [],
      },
      referenceMounts: [],
      extraMounts: [],
      createdAt: now(),
      updatedAt: now(),
    });

  const LEGACY_URL = "http://user:R6-FIXTURE-TOKEN@127.0.0.1:9/repo";

  it("leaves a standby over a store with a login or token unclaimed, and refuses the launch as a cold one", async () => {
    // Review 6 of mend#640, R6-1: claiming a surviving co-located standby skipped the gate a
    // cold launch passes, and the claimed workspace ran a new conversation over that store.
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          pool.entries.push(readyStandby(project.id, skeletonId));
          const engine = yield* SessionEngine;
          const place = yield* engine.ensureWorktree(
            project.id,
            { name: "legacy-place", start: { kind: "base", base: null } },
            "user-fixture",
          );
          execFileSync("git", ["-C", project.storePath, "config", "remote.origin.url", LEGACY_URL]);
          const session = yield* engine.provisionSessionIn(place.id, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          // Not claimed: the standby is left as it was, and the session is a cold one.
          expect(session.id).not.toBe(skeletonId);
          expect(pool.entries.map((entry) => [entry.id, entry.status])).toEqual([
            [skeletonId, "ready"],
          ]);
          const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(
            refused._tag === "DotfilesResolveError" ? refused.message : refused._tag,
          ).toContain("remote.origin.url (a login or token");
          expect(JSON.stringify(refused)).not.toContain("R6-FIXTURE-TOKEN");
          expect(created).toHaveLength(0);
          expect(spawned).toHaveLength(0);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, () => false, undefined, spawned),
        hotWorkspacesLayer: hotPoolLayer(pool),
      },
    );
  });

  it("refuses to launch into a standby claimed before its store held a token, and lets it go", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          pool.entries.push(readyStandby(project.id, skeletonId));
          const engine = yield* SessionEngine;
          const place = yield* engine.ensureWorktree(
            project.id,
            { name: "claimed-place", start: { kind: "base", base: null } },
            "user-fixture",
          );
          // Claimed while the store was clean (before an upgrade, say)…
          const session = yield* engine.provisionSessionIn(place.id, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(session.id).toBe(skeletonId);
          // …and launched once it is not.
          execFileSync("git", ["-C", project.storePath, "config", "remote.origin.url", LEGACY_URL]);
          const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(
            refused._tag === "DotfilesResolveError" ? refused.message : refused._tag,
          ).toContain("remote.origin.url (a login or token");
          expect(spawned).toHaveLength(0);
          expect(created).toHaveLength(0);
          expect(pool.removed).toContain(skeletonId);
          expect(world.sessions.get(session.id)?.status).toBe("failed");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, () => false, undefined, spawned),
        hotWorkspacesLayer: hotPoolLayer(pool),
      },
    );
  });

  it("leaves a standby unclaimed when a selected reference's clone holds a login or token", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    const selected: Array<Reference> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const clone = path.join(tmp, "legacy-reference");
          execFileSync("git", ["clone", "-q", path.join(tmp, "origin"), clone]);
          execFileSync("git", ["-C", clone, "config", "remote.origin.url", LEGACY_URL]);
          selected.push(
            new Reference({
              id: ReferenceId.make("legacy-reference"),
              name: "legacy-reference",
              organizationId: project.organizationId,
              createdByUserId: "user-fixture",
              originUrl: "https://host.invalid/repo",
              path: clone,
              pinnedRef: null,
              headSha: null,
              refreshedAt: null,
              createdAt: now(),
              updatedAt: now(),
            }),
          );
          const skeletonId = SessionId.make(crypto.randomUUID());
          pool.entries.push(readyStandby(project.id, skeletonId));
          const engine = yield* SessionEngine;
          const place = yield* engine.ensureWorktree(
            project.id,
            { name: "reference-place", start: { kind: "base", base: null } },
            "user-fixture",
          );
          const session = yield* engine.provisionSessionIn(place.id, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(session.id).not.toBe(skeletonId);
          const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(
            refused._tag === "DotfilesResolveError" ? refused.message : refused._tag,
          ).toContain("a login or token");
          expect(JSON.stringify(refused)).not.toContain("R6-FIXTURE-TOKEN");
          expect(created).toHaveLength(0);
          expect(spawned).toHaveLength(0);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, () => false, undefined, spawned),
        hotWorkspacesLayer: hotPoolLayer(pool),
        referencesLayer: Layer.succeed(ReferencesRepo, {
          create: () => Effect.die("not in test"),
          byId: (id) => Effect.fail(new ReferenceNotFoundError({ referenceId: id })),
          byName: () => Effect.succeed(null),
          listAll: () => Effect.succeed(selected),
          listForOrganization: () => Effect.succeed(selected),
          byIdsInOrganization: () => Effect.succeed(selected),
          remove: () => Effect.void,
          setHead: () => Effect.void,
          listForProject: () => Effect.succeed(selected),
          setForProject: () => Effect.void,
        }),
      },
    );
  });
});

describe("SessionEngine dotfiles", () => {
  it.each([false, true])(
    "saved loopback dotfiles require the owner's current operator role: %s",
    async (isOperator) => {
      const created: CreateOptions[] = [];
      const requests: string[] = [];
      const roles: string[] = [];
      const recorder = http.createServer((request, response) => {
        requests.push(request.url ?? "");
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve));
      const address = recorder.address();
      if (address === null || typeof address === "string") throw new Error("No recorder.");
      const url = `http://127.0.0.1:${address.port}/saved-dots.git`;
      try {
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              yield* engine.launch(session.id, ["codex"]);
              expect(created).toHaveLength(1);
              expect(world.sessions.get(session.id)?.status).toBe("running");
              expect(requests).toEqual(
                isOperator ? ["/saved-dots.git/info/refs?service=git-upload-pack"] : [],
              );
              const omitted = world.sessions.get(session.id)?.dotfiles?.notApplied;
              expect(omitted).toHaveLength(1);
              expect(omitted?.[0]?.reason).toContain(isOperator ? "failed" : "only the operator");
            }),
          {
            sealantLayer: sealantLaunchLayer(created),
            userDotfilesLayer: ownedRepositoriesLayer(
              new Map([["user-fixture", repositoryOf(url)]]),
            ),
            dotfilesClonerLayer: dotfilesClonerLayer({ ownerIsOperator: isOperator }),
            instanceRolesLayer: Layer.mock(InstanceRolesRepo, {
              isOperator: (userId) =>
                Effect.sync(() => {
                  roles.push(userId);
                  return isOperator;
                }),
            }),
          },
        );
        expect(roles).toEqual(["user-fixture", "user-fixture"]);
        expect(requests).toEqual(
          isOperator ? ["/saved-dots.git/info/refs?service=git-upload-pack"] : [],
        );
      } finally {
        await new Promise<void>((resolve, reject) => {
          recorder.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    },
  );

  it("ships the repository before the snapshot and stamps both as applied", async () => {
    const created: CreateOptions[] = [];
    const cell: { repository: DotfilesRepository | null } = { repository: null };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { project, engine, session } = yield* launchOnce(world, tmp);
          const url = dotfilesOrigin(tmp, project);
          cell.repository = repositoryOf(url);
          yield* engine.launch(session.id, ["codex"]);

          // Apply order: the repository with its own manager, then the snapshot as a copy.
          expect(
            created[0]?.dotfiles?.archives?.map(({ manager, bootstrap }) => ({
              manager,
              bootstrap,
            })),
          ).toEqual([
            { manager: "stow", bootstrap: false },
            { manager: "copy", bootstrap: false },
          ]);
          expect(created[0]?.dotfiles?.archives?.[1]?.data).toBe(SNAPSHOT.data);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: { url, ref: null },
            snapshotSha: SNAPSHOT.sha,
            notApplied: [],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(cell),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
      },
    );
  });

  it("launches without a repository that cannot be cloned, still ships the snapshot, and records why", async () => {
    const created: CreateOptions[] = [];
    const cell: { repository: DotfilesRepository | null } = { repository: null };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { project, engine, session } = yield* launchOnce(world, tmp);
          // The daemon serves nothing at this path: the clone fails the way a wrong URL does.
          const url = servedUrl(project, "no-such-dots");
          cell.repository = repositoryOf(url);
          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles?.archives).toEqual([
            { data: SNAPSHOT.data, manager: "copy", bootstrap: false },
          ]);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: { url, ref: null },
            snapshotSha: SNAPSHOT.sha,
            notApplied: [
              {
                source: "repository",
                reason: expect.stringMatching(
                  /^dotfiles clone of \S+\/no-such-dots failed: fatal: remote error: /,
                ),
              },
            ],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(cell),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
      },
    );
  });

  it("launches with no dotfiles when the only source fails, and records why", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles).toBeUndefined();
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: null,
            snapshotSha: null,
            notApplied: [
              { source: "snapshot", reason: "dotfiles snapshot could not be packed: git failed" },
            ],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        dotfilesStoreLayer: dotfilesStoreLayer(() =>
          Effect.fail(
            new DotfilesStoreError({
              message: "dotfiles snapshot could not be packed: git failed",
            }),
          ),
        ),
      },
    );
  });

  it("launches without a repository the source policy refuses at launch, and records the refusal", async () => {
    const created: CreateOptions[] = [];
    // Saved under a policy that let it through; this launch's policy refuses the host.
    const url = "https://metadata.google.internal/dots.git";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles?.archives).toEqual([
            { data: SNAPSHOT.data, manager: "copy", bootstrap: false },
          ]);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: { url, ref: null },
            snapshotSha: SNAPSHOT.sha,
            notApplied: [
              {
                source: "repository",
                reason:
                  "dotfiles repository refused: metadata.google.internal is not a repository host.",
              },
            ],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer({ repository: repositoryOf(url) }),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
      },
    );
  });

  it("clones as the session's owner, with their git access, and never lends the host's", async () => {
    const created: CreateOptions[] = [];
    const asked: Array<string> = [];
    // An ssh remote on a multi-tenant instance, for an owner whose git access is the bridge and
    // who shares no signer: the clone has no signer of theirs, and no other identity to use.
    const url = "ssh://git@127.0.0.1:1/owner/dots.git";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);

          expect(asked).toEqual(["git access of user-fixture"]);
          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles?.archives).toEqual([
            { data: SNAPSHOT.data, manager: "copy", bootstrap: false },
          ]);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles?.notApplied).toEqual([
            {
              source: "repository",
              reason:
                "the dotfiles repository signs with your connected signer: no signer connected — run `mend keys share` on the machine that holds your key",
            },
          ]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer({ repository: repositoryOf(url) }),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
        dotfilesClonerLayer: dotfilesClonerLayer({
          tenancy: "multi",
          gitAccess: "bridge",
          asked,
        }),
      },
    );
  });

  it("clones a public repository on a multi-tenant instance with none of the host's setup", async () => {
    const created: CreateOptions[] = [];
    const cell: { repository: DotfilesRepository | null } = { repository: null };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { project, engine, session } = yield* launchOnce(world, tmp);
          const url = dotfilesOrigin(tmp, project);
          cell.repository = repositoryOf(url);
          yield* engine.launch(session.id, ["codex"]);

          expect(created[0]?.dotfiles?.archives?.map(({ manager }) => manager)).toEqual([
            "stow",
            "copy",
          ]);
          expect(world.sessions.get(session.id)?.dotfiles?.notApplied).toEqual([]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(cell),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
        dotfilesClonerLayer: dotfilesClonerLayer({ tenancy: "multi", ownerIsOperator: false }),
      },
    );
  });

  it("never resolves dotfiles for a project that turned them off", async () => {
    const created: CreateOptions[] = [];
    const reads: Array<string> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, applyDotfiles: false }));
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["codex"]);

          expect(reads).toEqual([]);
          expect(created[0]?.dotfiles).toBeUndefined();
          expect(world.sessions.get(session.id)?.dotfiles).toEqual({
            repository: null,
            snapshotSha: null,
            notApplied: [],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(
          { repository: repositoryOf("git://127.0.0.1:1/dots") },
          reads,
        ),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.die("dotfiles are off here")),
      },
    );
  });
});

describe("SessionEngine dotfiles gate", () => {
  /**
   * Dotfiles reach a workspace only when the project applies them, the image is a family image
   * (a custom base promises only a POSIX sh) and the session has an owner whose dotfiles they
   * are. Every other combination reads nothing of anyone's and sends no archive.
   */
  it.each([
    { applyDotfiles: true, image: "family", owner: "user-fixture", sent: true },
    { applyDotfiles: false, image: "family", owner: "user-fixture", sent: false },
    { applyDotfiles: true, image: "custom", owner: "user-fixture", sent: false },
    { applyDotfiles: false, image: "custom", owner: "user-fixture", sent: false },
    { applyDotfiles: true, image: "family", owner: null, sent: false },
    { applyDotfiles: false, image: "family", owner: null, sent: false },
    { applyDotfiles: true, image: "custom", owner: null, sent: false },
    { applyDotfiles: false, image: "custom", owner: null, sent: false },
  ] as const)(
    "applyDotfiles $applyDotfiles · $image image · owner $owner → dotfiles sent: $sent",
    async ({ applyDotfiles, image, owner, sent }) => {
      const created: CreateOptions[] = [];
      const reads: Array<string> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            world.projects.set(project.id, new Project({ ...project, applyDotfiles }));
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: owner,
              start: { kind: "base", base: null },
            });
            const launched = yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);

            if (owner === null) {
              // Nobody to run as: the launch settles before anything of anyone's is read.
              expect(Exit.isFailure(launched)).toBe(true);
              expect(reads).toEqual([]);
              expect(created).toHaveLength(0);
              return;
            }
            expect(Exit.isSuccess(launched)).toBe(true);
            expect(created).toHaveLength(1);
            const options = created[0];
            if (image === "family") {
              expect(options?.os).toBe("arch");
              expect(options?.shell).toBe("zsh");
              expect(options?.baseImage).toBeUndefined();
            } else {
              expect(options?.baseImage).toBe("ghcr.io/acme/base:1");
              expect(options?.shell).toBeUndefined();
            }
            if (sent) {
              expect(reads).toEqual(["repository of user-fixture", "snapshot of user-fixture"]);
              expect(options?.dotfiles).toEqual({
                archives: [{ data: SNAPSHOT.data, manager: "copy", bootstrap: false }],
              });
              expect(world.sessions.get(session.id)?.dotfiles).toEqual({
                repository: null,
                snapshotSha: SNAPSHOT.sha,
                notApplied: [],
              });
            } else {
              expect(reads).toEqual([]);
              expect(options?.dotfiles).toBeUndefined();
              expect(world.sessions.get(session.id)?.dotfiles).toEqual({
                repository: null,
                snapshotSha: null,
                notApplied: [],
              });
            }
          }),
        {
          sealantLayer: sealantLaunchLayer(created),
          workspaceImage: image === "family" ? ZSH_FAMILY : CUSTOM_BASE,
          userDotfilesLayer: ownedRepositoriesLayer(new Map(), reads),
          dotfilesStoreLayer: ownedSnapshotsLayer(new Map([["user-fixture", SNAPSHOT]]), reads),
        },
      );
    },
  );

  it.effect("a relaunch into a fresh workspace resolves the owner's dotfiles again", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const snapshots = new Map([["user-fixture", SNAPSHOT]]);
      const { world, tmp, untilChanged } = yield* signalledFixture("mend-workspace-test-");
      yield* withPreparedEngineEffect(
        (_world, dir) => setup(dir, world),
        (_world, _dir, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            expect(world.sessions.get(session.id)?.dotfiles?.snapshotSha).toBe(SNAPSHOT.sha);
            yield* engine.stop(session.id);
            const agentExited = () =>
              [...world.processes.values()].every((process) => process.exitedAt !== null);
            yield* untilChanged(agentExited, "the agent's end after the stop");

            // The owner synced again while the session was stopped.
            snapshots.set("user-fixture", NEWER_SNAPSHOT);
            const resumed = yield* engine.resumeSession(session.id, "shell");
            expect(resumed.status).toBe("running");
            expect(created).toHaveLength(2);
            expect(created[1]?.shell).toBe("zsh");
            expect(created[1]?.dotfiles).toEqual({
              archives: [{ data: NEWER_SNAPSHOT.data, manager: "copy", bootstrap: false }],
            });
            expect(world.sessions.get(session.id)?.dotfiles).toEqual({
              repository: null,
              snapshotSha: NEWER_SNAPSHOT.sha,
              notApplied: [],
            });
            // The shell is the image's login shell, the one those dotfiles configure.
            const live = [...world.processes.values()].filter(
              (process) => process.exitedAt === null,
            );
            expect(live.map((process) => process.argv)).toEqual([["zsh"]]);
          }),
        {
          fixture: { world, tmp },
          sealantLayer: sealantLaunchLayer(created),
          workspaceImage: ZSH_FAMILY,
          dotfilesStoreLayer: ownedSnapshotsLayer(snapshots),
        },
      );
    }),
  );

  it("each owner's session launches with that owner's dotfiles and nobody else's", async () => {
    const created: CreateOptions[] = [];
    const reads: Array<string> = [];
    const otherSnapshot = { sha: "07e407e407e407e407e407e407e407e407e407e4", data: "b3RoZXI=" };
    // user-fixture keeps a repository this launch's policy refuses (no clone, no network); the
    // other owner has none, and a snapshot of their own.
    const refusedUrl = "https://metadata.google.internal/fixture-dots.git";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.members.set("user-other", "member");
          const engine = yield* SessionEngine;
          const launchAs = (ownerUserId: string) =>
            Effect.gen(function* () {
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId,
                start: { kind: "base", base: null },
              });
              yield* engine.launch(session.id, ["codex"]);
              return session;
            });

          const other = yield* launchAs("user-other");
          expect(reads).toEqual(["repository of user-other", "snapshot of user-other"]);
          expect(created[0]?.dotfiles).toEqual({
            archives: [{ data: otherSnapshot.data, manager: "copy", bootstrap: false }],
          });
          expect(world.sessions.get(other.id)?.dotfiles).toEqual({
            repository: null,
            snapshotSha: otherSnapshot.sha,
            notApplied: [],
          });

          reads.length = 0;
          const fixture = yield* launchAs("user-fixture");
          expect(reads).toEqual(["repository of user-fixture", "snapshot of user-fixture"]);
          expect(created[1]?.dotfiles).toEqual({
            archives: [{ data: SNAPSHOT.data, manager: "copy", bootstrap: false }],
          });
          expect(world.sessions.get(fixture.id)?.dotfiles?.repository).toEqual({
            url: refusedUrl,
            ref: null,
          });
          expect(world.sessions.get(fixture.id)?.dotfiles?.snapshotSha).toBe(SNAPSHOT.sha);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: ownedRepositoriesLayer(
          new Map([["user-fixture", repositoryOf(refusedUrl)]]),
          reads,
        ),
        dotfilesStoreLayer: ownedSnapshotsLayer(
          new Map([
            ["user-fixture", SNAPSHOT],
            ["user-other", otherSnapshot],
          ]),
          reads,
        ),
      },
    );
  });
});
