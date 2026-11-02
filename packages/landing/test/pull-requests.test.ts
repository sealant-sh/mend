import { execFile } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { ProofArtifactsRepo, PullRequestProofUploadsRepo } from "@mend/db";
import { BlobStore } from "@mend/store";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";

import { DESCRIPTION_END, DESCRIPTION_START } from "../src/description.ts";
import {
  type ExecOutput,
  type PublishInput,
  PullRequests,
  PullRequestsLive,
  PullRequestStepError,
  PullRequestWorkspaces,
  type OpenedInTurn,
} from "../src/pull-requests.ts";

const noProof = Layer.mergeAll(
  Layer.mock(ProofArtifactsRepo, {}),
  Layer.mock(PullRequestProofUploadsRepo, {}),
  Layer.mock(BlobStore, { identity: "unused" }),
);

const repository = { owner: "acme", name: "api", slug: "acme/api" };

const SECTION = `${DESCRIPTION_START}\n## Summary\n\nFixes the login loop.\n${DESCRIPTION_END}`;

const publishInput = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  target: { ownerUserId: "ada", sessionId: null },
  repository,
  head: "mend/fix-login",
  base: "main",
  title: "login loop",
  titleGiven: false,
  section: SECTION,
  body: null,
  previous: null,
  ...overrides,
});

interface GhPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly title: string;
  readonly body: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly isCrossRepository: boolean;
  readonly headRepositoryOwner: { readonly login: string } | null;
  readonly createdAt?: string;
}

const pr = (number: number, overrides: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number,
  url: `https://github.com/acme/api/pull/${number}`,
  state: "OPEN",
  title: "login loop",
  body: "",
  headRefName: "mend/fix-login",
  headRefOid: "a".repeat(40),
  isCrossRepository: false,
  headRepositoryOwner: { login: "acme" },
  ...overrides,
});

/** The same branch name in a fork. */
const fork = (number: number, overrides: Partial<GhPullRequest> = {}): GhPullRequest =>
  pr(number, { isCrossRepository: true, headRepositoryOwner: { login: "anna" }, ...overrides });

/** The value of `--name=value` in a gh argv. */
const flag = (argv: ReadonlyArray<string>, name: string) =>
  argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const ok = (stdout = ""): ExecOutput => ({ exitCode: 0, stdout, stderr: "" });

const promiseGate = () => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { wait, release: () => release?.() };
};

const native = (argv: ReadonlyArray<string>): Promise<ExecOutput> =>
  new Promise((resolve, reject) => {
    const executable = argv[0];
    if (executable === undefined) return reject(new Error("empty native fixture command"));
    execFile(executable, argv.slice(1), { encoding: "utf8" }, (error, stdout, stderr) =>
      resolve({
        exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
        stdout,
        stderr,
      }),
    );
  });

/** Actual production file argv, with a deferred SDK-style reply and no real gh/workspace. */
type LateWriteFailure = "interruption" | "rejection";
const lateFileWorkspace = (mode: LateWriteFailure) => {
  const gate = promiseGate();
  const started = promiseGate();
  const owned = new Set<string>();
  const commands: Array<ReadonlyArray<string>> = [];
  let file: string | null = null;
  let directoryMode: number | null = null;
  let write: Promise<ExecOutput> = Promise.resolve(ok());
  const rejected = new PullRequestStepError({ message: "synthetic SDK read rejection" });
  const exec = (argv: ReadonlyArray<string>): Effect.Effect<ExecOutput, PullRequestStepError> =>
    Effect.suspend(() => {
      commands.push(argv);
      if (argv[0] === "env" && argv[6] === "pr" && argv[7] === "list")
        return Effect.succeed(ok("[]"));
      if (argv[0] === "sh") {
        const path = argv[4];
        if (
          path === undefined ||
          !/^\/tmp\/mend-pull-request-[a-f0-9-]+(?:\.md|\/body\.md)$/.test(path) ||
          existsSync(path)
        )
          return Effect.fail(new PullRequestStepError({ message: "unowned native fixture file" }));
        file = path;
        owned.add(path);
        directoryMode = statSync(dirname(path)).mode & 0o777;
        write = gate.wait.then(() => native(argv));
        started.release();
        return Effect.tryPromise({
          try: () => (mode === "rejection" ? Promise.reject(rejected) : write),
          catch: () => rejected,
        });
      }
      const path = argv.at(-1);
      if (path === undefined || !/^\/tmp\/mend-pull-request-[a-f0-9-]+(?:\.md)?$/.test(path))
        return Effect.fail(
          new PullRequestStepError({ message: "unowned native fixture directory" }),
        );
      if (argv[0] === "mkdir") {
        if (existsSync(path))
          return Effect.fail(new PullRequestStepError({ message: "fixture directory collision" }));
        return Effect.tryPromise({
          try: async () => {
            const result = await native(argv);
            if (result.exitCode === 0) owned.add(path);
            return result;
          },
          catch: () => new PullRequestStepError({ message: "native fixture mkdir failed" }),
        });
      }
      if (argv[0] !== "rm" || !owned.has(path))
        return Effect.fail(
          new PullRequestStepError({ message: "unexpected native fixture command" }),
        );
      return Effect.tryPromise({
        try: () => native(argv),
        catch: () => new PullRequestStepError({ message: "native fixture remove failed" }),
      });
    });
  const layer = PullRequestsLive.pipe(
    Layer.provide(noProof),
    Layer.provide(
      Layer.succeed(PullRequestWorkspaces, {
        within: (_target, use) => use({ kind: "session", supportsAttachments: true, exec }),
      }),
    ),
  );
  return {
    layer,
    rejected,
    commands,
    started: started.wait,
    release: gate.release,
    result: () => write,
    path: () => file,
    directoryMode: () => directoryMode,
    cleanup: Effect.promise(async () => {
      gate.release();
      await write;
      for (const path of owned) rmSync(path, { recursive: true, force: true });
    }),
  };
};

/**
 * A GitHub the fake workspace's `gh` talks to: the pull requests it holds, and every command the
 * step ran, in order. `gh pr create` fails with `createFails` when set.
 */
const fakeGitHub = (options: {
  readonly pullRequests?: ReadonlyArray<GhPullRequest>;
  readonly createFails?: string;
  readonly writeFails?: string;
  readonly mkdirFails?: string;
  readonly afterMkdir?: Effect.Effect<void, PullRequestStepError>;
  readonly afterWrite?: Effect.Effect<void, PullRequestStepError>;
  readonly readAfterEditFails?: string;
  readonly kind?: "session" | "short-lived";
}) => {
  const pulls = new Map((options.pullRequests ?? []).map((pull) => [pull.number, pull]));
  const commands: Array<ReadonlyArray<string>> = [];
  const files = new Map<string, string>();
  const directories = new Set<string>();
  let edited = false;
  const exec = (argv: ReadonlyArray<string>): ExecOutput => {
    commands.push(argv);
    if (argv[0] === "mkdir") {
      if (options.mkdirFails !== undefined)
        return { exitCode: 1, stdout: "", stderr: options.mkdirFails };
      directories.add(argv.at(-1) ?? "");
      return ok();
    }
    if (argv[0] === "sh") {
      const [, , , , file = "", ...chunks] = argv;
      if (!directories.has(dirname(file)))
        return { exitCode: 1, stdout: "", stderr: "missing parent directory" };
      files.set(file, Buffer.from(chunks.join(""), "base64").toString("utf8"));
      return options.writeFails === undefined
        ? ok()
        : { exitCode: 1, stdout: "", stderr: options.writeFails };
    }
    if (argv[0] === "rm") {
      const directory = argv.at(-1) ?? "";
      directories.delete(directory);
      for (const file of files.keys()) if (file.startsWith(`${directory}/`)) files.delete(file);
      return ok();
    }
    const [verb, ...rest] = argv.slice(7);
    switch (verb) {
      case "view": {
        if (edited && options.readAfterEditFails !== undefined)
          return { exitCode: 1, stdout: "", stderr: options.readAfterEditFails };
        const ref = rest[0] ?? "";
        const number = Number(ref.split("/").at(-1));
        const found = pulls.get(number);
        return found === undefined
          ? { exitCode: 1, stdout: "", stderr: `no pull requests found for ${ref}` }
          : ok(JSON.stringify(found));
      }
      case "list": {
        const head = flag(argv, "head");
        const search = flag(argv, "search");
        const state = flag(argv, "state");
        const listed = [...pulls.values()]
          .filter((pull) => head === null || pull.headRefName === head)
          .filter((pull) => search === null || pull.headRefOid === search)
          .filter((pull) => state !== "open" || pull.state === "OPEN")
          .toSorted((left, right) => right.number - left.number);
        return ok(JSON.stringify(listed));
      }
      case "create": {
        if (options.createFails !== undefined) {
          return { exitCode: 1, stdout: "", stderr: options.createFails };
        }
        const number = 500 + pulls.size;
        pulls.set(
          number,
          pr(number, {
            title: flag(argv, "title") ?? "",
            body: files.get(flag(argv, "body-file") ?? "") ?? "",
          }),
        );
        return ok(`Creating pull request\n\nhttps://github.com/acme/api/pull/${number}\n`);
      }
      case "edit": {
        const number = Number(rest[0]);
        const current = pulls.get(number);
        if (current === undefined) return { exitCode: 1, stdout: "", stderr: "not found" };
        const title = flag(argv, "title");
        pulls.set(number, {
          ...current,
          body: files.get(flag(argv, "body-file") ?? "") ?? current.body,
          ...(title === null ? {} : { title }),
        });
        edited = true;
        return ok(current.url);
      }
      default:
        return { exitCode: 2, stdout: "", stderr: `unknown gh call ${argv.join(" ")}` };
    }
  };
  const layer = PullRequestsLive.pipe(
    Layer.provide(noProof),
    Layer.provide(
      Layer.succeed(PullRequestWorkspaces, {
        within: (_target, use) =>
          use({
            kind: options.kind ?? "short-lived",
            supportsAttachments: true,
            exec: (argv) =>
              Effect.gen(function* () {
                const result = exec(argv);
                if (argv[0] === "mkdir" && options.afterMkdir !== undefined)
                  yield* options.afterMkdir;
                if (argv[0] === "sh" && options.afterWrite !== undefined) yield* options.afterWrite;
                return result;
              }),
          }),
      }),
    ),
  );
  const verbs = () =>
    commands.map((argv) => (argv[0] === "env" ? `gh ${argv[6]} ${argv[7]}` : (argv[0] ?? "")));
  return { layer, pulls, commands, files, directories, verbs };
};

describe("PullRequests.publish", () => {
  it.effect("opens a pull request with the body from a file, then reads it back", () => {
    const github = fakeGitHub({});
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput());
      expect(published.action).toBe("opened");
      expect(published.pullRequest).toMatchObject({
        number: 500,
        url: "https://github.com/acme/api/pull/500",
        state: "open",
      });
      expect(github.verbs()).toEqual([
        "gh pr list",
        "mkdir",
        "sh",
        "gh pr create",
        "gh pr view",
        "rm",
      ]);
      const created = github.pulls.get(500);
      expect(created?.title).toBe("login loop");
      expect(created?.body).toBe(SECTION);
      // The body file is gone from the workspace afterwards.
      expect(github.files.size).toBe(0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("updates the recorded pull request, replacing only Mend's section", () => {
    const earlier = `${DESCRIPTION_START}\nNo summary.\n${DESCRIPTION_END}`;
    const github = fakeGitHub({
      pullRequests: [
        pr(412, {
          title: "Fix login (edited on GitHub)",
          body: `Closes #12\n\n${earlier}\n\nDeploy after Friday.`,
        }),
      ],
    });
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput({ previous: 412 }));
      expect(published.action).toBe("updated");
      expect(published.pullRequest.number).toBe(412);
      expect(github.verbs()).toEqual([
        "gh pr view",
        "mkdir",
        "sh",
        "gh pr edit",
        "gh pr view",
        "rm",
      ]);
      const updated = github.pulls.get(412);
      expect(updated?.body).toBe(`Closes #12\n\n${SECTION}\n\nDeploy after Friday.`);
      // No title was given for this landing, so the edited one stays.
      expect(updated?.title).toBe("Fix login (edited on GitHub)");
      expect(published.pullRequest.title).toBe("Fix login (edited on GitHub)");
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("writes the owner's own description above the section in place of the rest", () => {
    const earlier = `${DESCRIPTION_START}\nNo summary.\n${DESCRIPTION_END}`;
    const github = fakeGitHub({
      pullRequests: [pr(412, { body: `Closes #12\n\n${earlier}\n\nDeploy after Friday.` })],
    });
    return Effect.gen(function* () {
      yield* (yield* PullRequests).publish(
        publishInput({ previous: 412, body: "  Fixes the login loop for SSO users.\n" }),
      );
      expect(github.pulls.get(412)?.body).toBe(`Fixes the login loop for SSO users.\n\n${SECTION}`);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("sends the title on update when the owner gave one", () => {
    const github = fakeGitHub({ pullRequests: [pr(412, { title: "Old" })] });
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(
        publishInput({ previous: 412, title: "Fix login", titleGiven: true }),
      );
      expect(github.pulls.get(412)?.title).toBe("Fix login");
      expect(published.pullRequest.title).toBe("Fix login");
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("opens a new pull request when the recorded one was merged", () => {
    const github = fakeGitHub({ pullRequests: [pr(412, { state: "MERGED" })] });
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput({ previous: 412 }));
      expect(published.action).toBe("opened");
      expect(published.pullRequest.number).not.toBe(412);
      expect(github.verbs()).toEqual([
        "gh pr view",
        "gh pr list",
        "mkdir",
        "sh",
        "gh pr create",
        "gh pr view",
        "rm",
      ]);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("adopts an open pull request from the branch when none was recorded", () => {
    const github = fakeGitHub({
      pullRequests: [pr(77, { title: "Agent's PR", body: "Opened by the agent." })],
    });
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput());
      expect(published.action).toBe("updated");
      expect(published.pullRequest.number).toBe(77);
      expect(github.pulls.get(77)?.body).toBe(`Opened by the agent.\n\n${SECTION}`);
      expect(github.pulls.get(77)?.title).toBe("Agent's PR");
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("fails in gh's words, and still removes the body file", () => {
    const github = fakeGitHub({
      createFails:
        "pull request create failed: GraphQL: No commits between main and mend/fix-login (createPullRequest)",
    });
    return Effect.gen(function* () {
      const error = yield* (yield* PullRequests).publish(publishInput()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(PullRequestStepError);
      expect(error.message).toBe(
        "gh pr create · pull request create failed: GraphQL: No commits between main and mend/fix-login (createPullRequest)",
      );
      expect(github.verbs().at(-1)).toBe("rm");
      expect(github.files.size).toBe(0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("does not write or remove a directory whose creation failed", () => {
    const github = fakeGitHub({ mkdirFails: "directory exists" });
    return Effect.gen(function* () {
      const error = yield* (yield* PullRequests).publish(publishInput()).pipe(Effect.flip);
      expect(error.message).toBe("creating the description directory · directory exists");
      expect(github.verbs()).toEqual(["gh pr list", "mkdir"]);
      expect(github.files.size).toBe(0);
      expect(github.directories.size).toBe(0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("does not adopt a directory after an ambiguous creation reply", () => {
    const failure = new PullRequestStepError({ message: "creation reply unavailable" });
    const github = fakeGitHub({ afterMkdir: Effect.fail(failure) });
    return Effect.gen(function* () {
      const error = yield* (yield* PullRequests).publish(publishInput()).pipe(Effect.flip);
      expect(error).toBe(failure);
      expect(github.verbs()).toEqual(["gh pr list", "mkdir"]);
      expect(github.files.size).toBe(0);
      // Without a successful reply ownership is unknown; no private body is written.
      expect(github.directories.size).toBe(1);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("waits for confirmed acquisition before interruption removes the directory", () =>
    Effect.gen(function* () {
      const creating = yield* Deferred.make<void>();
      const acknowledge = yield* Deferred.make<void>();
      const github = fakeGitHub({
        afterMkdir: Deferred.succeed(creating, undefined).pipe(
          Effect.andThen(Deferred.await(acknowledge)),
        ),
      });
      const fiber = yield* Effect.gen(function* () {
        return yield* (yield* PullRequests).publish(publishInput());
      }).pipe(Effect.provide(github.layer), Effect.forkChild);
      yield* Deferred.await(creating);
      const cancelling = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(github.files.size).toBe(0);
      expect(github.directories.size).toBe(1);
      yield* Deferred.succeed(acknowledge, undefined);
      yield* Fiber.join(cancelling);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(github.verbs()).toEqual(["gh pr list", "mkdir", "rm"]);
      expect(github.files.size).toBe(0);
      expect(github.directories.size).toBe(0);
    }),
  );

  it.effect("cleans a partial description after a nonzero write and preserves the failure", () => {
    const github = fakeGitHub({ writeFails: "disk full" });
    return Effect.gen(function* () {
      const error = yield* (yield* PullRequests).publish(publishInput()).pipe(Effect.flip);
      expect(error.message).toBe("writing the description · disk full");
      expect(github.verbs()).toEqual(["gh pr list", "mkdir", "sh", "rm"]);
      expect(github.files.size).toBe(0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("cleans a partial description after a workspace failure", () => {
    const failure = new PullRequestStepError({ message: "workspace write failed" });
    const github = fakeGitHub({ afterWrite: Effect.fail(failure) });
    return Effect.gen(function* () {
      const error = yield* (yield* PullRequests).publish(publishInput()).pipe(Effect.flip);
      expect(error).toBe(failure);
      expect(github.verbs()).toEqual(["gh pr list", "mkdir", "sh", "rm"]);
      expect(github.files.size).toBe(0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("cleans a partial description when its pending write is interrupted", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const github = fakeGitHub({
        afterWrite: Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = yield* Effect.gen(function* () {
        return yield* (yield* PullRequests).publish(publishInput());
      }).pipe(Effect.provide(github.layer), Effect.forkChild);
      yield* Deferred.await(writing);
      expect(github.files.size).toBe(1);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(github.verbs()).toEqual(["gh pr list", "mkdir", "sh", "rm"]);
      expect(github.files.size).toBe(0);
    }),
  );

  it.effect("reports a failed post-edit observation and still cleans the description", () => {
    const github = fakeGitHub({
      pullRequests: [pr(412, { title: "Old" })],
      readAfterEditFails: "observation unavailable",
    });
    return Effect.gen(function* () {
      const error = yield* (yield* PullRequests)
        .publish(publishInput({ previous: 412, title: "New", titleGiven: true }))
        .pipe(Effect.flip);
      expect(error.message).toBe("gh pr view · observation unavailable");
      expect(github.pulls.get(412)?.title).toBe("New");
      expect(github.files.size).toBe(0);
    }).pipe(Effect.provide(github.layer));
  });

  const lateWriteFailures: ReadonlyArray<LateWriteFailure> = ["interruption", "rejection"];
  for (const mode of lateWriteFailures) {
    it.effect(
      `a real filesystem write completing after ${mode} cannot recreate the description`,
      () => {
        const workspace = lateFileWorkspace(mode);
        return Effect.gen(function* () {
          const fiber = yield* (yield* PullRequests).publish(publishInput()).pipe(Effect.forkChild);
          yield* Effect.promise(() => workspace.started);
          if (mode === "interruption") yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          if (mode === "interruption") expect(Exit.hasInterrupts(exit)).toBe(true);
          else {
            const error = yield* Fiber.join(fiber).pipe(Effect.flip);
            expect(error).toBe(workspace.rejected);
          }
          const file = workspace.path();
          if (file === null) throw new Error("late write fixture did not start");
          expect(existsSync(file)).toBe(false);
          workspace.release();
          const late = yield* Effect.promise(() => workspace.result());
          expect(existsSync(file)).toBe(false);
          expect(late.exitCode).not.toBe(0);
          expect(workspace.directoryMode()).toBe(0o700);
          expect(existsSync(dirname(file))).toBe(false);
        }).pipe(Effect.provide(workspace.layer), Effect.ensuring(workspace.cleanup));
      },
    );
  }

  it.effect("says where it ran", () => {
    const github = fakeGitHub({ kind: "session" });
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput());
      expect(published.workspace).toBe("session");
    }).pipe(Effect.provide(github.layer));
  });
});

describe("PullRequests: pull requests from forks", () => {
  it.effect("never updates a fork's pull request from a branch of the same name", () => {
    const github = fakeGitHub({ pullRequests: [fork(367)] });
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput({ previous: 367 }));
      expect(published.action).toBe("opened");
      expect(published.pullRequest.number).not.toBe(367);
      expect(github.pulls.get(367)?.body).toBe("");
    }).pipe(Effect.provide(github.layer));
  });
});

describe("PullRequests.find", () => {
  const findWith = (
    pullRequests: ReadonlyArray<GhPullRequest>,
    input: {
      readonly branches: ReadonlyArray<string>;
      readonly commit: string | null;
      readonly opened?: OpenedInTurn;
    },
  ) => {
    const github = fakeGitHub({ pullRequests, kind: "session" });
    return Effect.gen(function* () {
      return yield* (yield* PullRequests).find({
        target: { ownerUserId: "ada", sessionId: null, liveOnly: true },
        repository,
        opened: null,
        ...input,
      });
    }).pipe(Effect.provide(github.layer));
  };

  it.effect("finds the pull request on origin for a branch the agent pushed, open first", () =>
    Effect.gen(function* () {
      const found = yield* findWith(
        [
          pr(300, { headRefName: "chore/bump-deps", state: "MERGED" }),
          pr(310, { headRefName: "chore/bump-deps" }),
          fork(320, { headRefName: "chore/bump-deps" }),
        ],
        { branches: ["mend/update-deps", "chore/bump-deps"], commit: null },
      );
      expect(found?.number).toBe(310);
      expect(found?.crossRepository).toBe(false);
    }),
  );

  it.effect("ignores a fork's same-named branch, and finds a fork's pull request by commit", () =>
    Effect.gen(function* () {
      const commit = "c".repeat(40);
      const byBranch = yield* findWith([fork(367, { headRefName: "fix-login" })], {
        branches: ["fix-login"],
        commit: null,
      });
      expect(byBranch).toBeNull();
      const byCommit = yield* findWith(
        [fork(367, { headRefName: "fix-login", headRefOid: commit, state: "MERGED" })],
        { branches: ["mend/wt/1"], commit },
      );
      expect(byCommit).toMatchObject({
        number: 367,
        state: "merged",
        crossRepository: true,
        headOwner: "anna",
        headRefName: "fix-login",
      });
    }),
  );

  it.effect("takes the pull request a turn named when gh says it was opened during the turn", () =>
    Effect.gen(function* () {
      const since = new Date("2026-10-03T09:00:00Z");
      // The agent pushed over HTTPS to a branch Mend never saw, and named the pull request.
      const found = yield* findWith(
        [
          pr(400, { headRefName: "older", createdAt: "2026-09-01T00:00:00Z" }),
          pr(413, { headRefName: "fix/login", createdAt: "2026-10-03T09:04:00Z" }),
        ],
        { branches: ["mend/wt/1"], commit: null, opened: { numbers: [413, 400], since } },
      );
      expect(found).toMatchObject({ number: 413, headRefName: "fix/login" });
      // One the turn only mentioned was opened before it started: not the change's.
      const mentioned = yield* findWith(
        [pr(400, { headRefName: "older", createdAt: "2026-09-01T00:00:00Z" })],
        { branches: ["mend/wt/1"], commit: null, opened: { numbers: [400], since } },
      );
      expect(mentioned).toBeNull();
    }),
  );
});

describe("PullRequests.observe", () => {
  it.effect("reads the state gh reports now", () => {
    const github = fakeGitHub({ pullRequests: [pr(412, { state: "MERGED" })] });
    return Effect.gen(function* () {
      const observed = yield* (yield* PullRequests).observe({
        target: { ownerUserId: "ada", sessionId: null },
        repository,
        number: 412,
      });
      expect(observed).toMatchObject({ number: 412, state: "merged" });
      expect(observed.observedAt).toBeInstanceOf(Date);
    }).pipe(Effect.provide(github.layer));
  });
});
