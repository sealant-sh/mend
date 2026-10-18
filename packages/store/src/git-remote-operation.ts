import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { Effect, Schema, type Scope } from "effect";

/** The caller's final Git configuration overrides and actual repository, when there is one. */
export interface GitRemoteContext {
  readonly env: Readonly<Record<string, string>>;
  readonly repositoryPath?: string;
}

/** The original operand handed to Git, never an already-rewritten URL. */
export type GitRemoteOperation =
  | (GitRemoteContext & {
      readonly remote: string;
      readonly direction: "read" | "push";
    })
  | {
      readonly remote: string;
      readonly direction: "clone";
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
      /** The actual destination is never created or changed during preparation. */
      readonly destinationPath: string;
      readonly cloneKind: "bare" | "checkout";
    };

/** Git could not establish the destination without transport; no raw config or URL is exposed. */
export class GitRemoteResolutionError extends Schema.TaggedError<GitRemoteResolutionError>()(
  "GitRemoteResolutionError",
  {
    stage: Schema.Literals([
      "configuration",
      "destination",
      "scratch",
      "ambiguous-push",
      "clone-context",
      "clone-configuration",
      "clone-template",
    ]),
    message: Schema.String,
  },
) {}

const failed = (stage: GitRemoteResolutionError["stage"]) =>
  new GitRemoteResolutionError({
    stage,
    message:
      stage === "ambiguous-push"
        ? "Git's explicit URL push has matching rewrite rules for several destination bases. Use a named remote or one matching rewrite base."
        : stage === "clone-context"
          ? "Git clone destination cannot be checked with inherited repository location overrides. Clear those overrides for this operation."
          : stage === "clone-configuration"
            ? "Git clone destination cannot be checked with conditional includes or preconfigured remote settings. Use source configuration without those settings for this clone."
            : stage === "clone-template"
              ? "Git clone destination cannot be checked with template links, special files, URL, include or remote settings. Use a regular template without those settings for this clone."
              : "Git remote destination could not be established without transport.",
  });

const gitRead = (
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stage: GitRemoteResolutionError["stage"],
  options: { readonly allowMissingRemote?: true; readonly allowMissingConfig?: true } = {},
): Effect.Effect<string | null, GitRemoteResolutionError> =>
  Effect.callback((resume) => {
    const child = execFile("git", [...args], { cwd, env }, (error, stdout) => {
      resume(
        error === null
          ? Effect.succeed(stdout)
          : (options.allowMissingRemote && error.code === 2) ||
              (options.allowMissingConfig && error.code === 1)
            ? Effect.succeed(null)
            : Effect.fail(failed(stage)),
      );
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    // These children only read existing config or write our private probe. Wait for termination
    // before release removes scratch; a merely signalled init/config can still create files.
    return Effect.promise(async () => {
      child.kill("SIGKILL");
      await closed;
    });
  });

const required = (answer: string | null, stage: GitRemoteResolutionError["stage"]) =>
  answer === null ? Effect.fail(failed(stage)) : Effect.succeed(answer);

const parseUrls = (
  answer: string,
): Effect.Effect<ReadonlyArray<string>, GitRemoteResolutionError> => {
  const urls = answer.endsWith("\n") ? answer.slice(0, -1).split("\n") : answer.split("\n");
  return urls.some(
    (url) => url === "" || url.trim() !== url || url.includes("\r") || url.includes("\0"),
  )
    ? Effect.fail(failed("destination"))
    : Effect.succeed(urls);
};

/**
 * Ask real Git for its effective destination under the operation's actual environment and repo.
 * Reads use Git's first fetch URL; pushes return every push destination. No network is opened and
 * no existing repository is written. Callers must retain the original operand for transport.
 *
 * An explicit URL push needs a named remote for get-url. The private scratch remote sees only
 * Git's ordered effective url.* settings, including evaluated conditional/worktree config. Git
 * itself applies the rules; unrelated local settings and location overrides never enter scratch.
 */
export const resolveGitRemote = Effect.fn("GitRemote.resolve")(function* (
  operation: GitRemoteOperation,
): Effect.fn.Return<ReadonlyArray<string>, GitRemoteResolutionError, Scope.Scope> {
  if (
    operation.remote === "" ||
    operation.remote.startsWith("-") ||
    ["\r", "\n", "\0"].some((control) => operation.remote.includes(control))
  ) {
    return yield* failed("destination");
  }
  if (operation.direction === "clone") return (yield* resolveGitClone(operation)).urls;
  const cwd = operation.repositoryPath ?? "/";
  const env = { ...process.env, ...operation.env };
  if (operation.direction === "read") {
    const answer = yield* gitRead(
      ["ls-remote", "--get-url", operation.remote],
      cwd,
      env,
      "destination",
    );
    return yield* parseUrls(yield* required(answer, "destination"));
  }
  if (operation.repositoryPath !== undefined) {
    const answer = yield* gitRead(
      ["remote", "get-url", "--push", "--all", operation.remote],
      cwd,
      env,
      "destination",
      { allowMissingRemote: true },
    );
    if (answer !== null) return yield* parseUrls(answer);
  }

  // GIT_CONFIG redirects the `git config` command only, not push's config reads.
  const configEnv = { ...env };
  delete configEnv["GIT_CONFIG"];
  const listed = yield* gitRead(
    ["config", "--null", "--list", "--includes"],
    cwd,
    configEnv,
    "configuration",
  );
  const configuration = yield* required(listed, "configuration");
  if (configuration !== "" && !configuration.endsWith("\0")) return yield* failed("configuration");
  const rules: Array<readonly [string, string]> = [];
  for (const entry of configuration.split("\0")) {
    if (!entry.startsWith("url.")) continue;
    const separator = entry.indexOf("\n");
    if (separator < 0) return yield* failed("configuration");
    rules.push([entry.slice(0, separator), entry.slice(separator + 1)]);
  }
  // Restrict explicit URL probes to one matching base rather than deriving a destination from
  // interactions between several bases. Unmatched entries retain their order in scratch.
  const bases = new Set<string>();
  for (const [key, value] of rules) {
    const rule = /^url\.(.*)\.(?:insteadof|pushinsteadof)$/.exec(key);
    if (rule?.[1] !== undefined && operation.remote.startsWith(value)) bases.add(rule[1]);
  }
  if (bases.size > 1) return yield* failed("ambiguous-push");
  // No inherited Git variable may redirect scratch writes or load another config scope. All
  // effective rewrite entries were read above, in Git order, before opening this private repo.
  const isolated = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const scratchEnv = {
    ...isolated,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "",
  };
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "mend-remote-url-")),
      catch: () => failed("scratch"),
    }),
    (dir) =>
      Effect.gen(function* () {
        const gitDir = join(dir, "probe.git");
        yield* gitRead(["init", "-q", "--bare", "--template=", gitDir], "/", scratchEnv, "scratch");
        const config = join(gitDir, "config");
        for (const [index, [key, value]] of rules.entries()) {
          // Updating one config with --add groups repeated sections and changes interleaved
          // rule order. Let Git serialize each entry separately, then retain the exact order.
          const fragment = join(dir, `rule-${index}`);
          yield* gitRead(
            ["config", "--file", fragment, "--add", key, value],
            "/",
            scratchEnv,
            "scratch",
          );
          yield* Effect.tryPromise({
            try: async () => appendFile(config, `\n${await readFile(fragment, "utf8")}`),
            catch: () => failed("scratch"),
          });
        }
        const name = `mend-probe-${randomUUID()}`;
        yield* gitRead(
          ["config", "--file", config, `remote.${name}.url`, operation.remote],
          "/",
          scratchEnv,
          "scratch",
        );
        const answer = yield* gitRead(
          [`--git-dir=${gitDir}`, "remote", "get-url", "--push", "--all", name],
          "/",
          scratchEnv,
          "destination",
        );
        return yield* parseUrls(yield* required(answer, "destination"));
      }),
    (dir) =>
      Effect.tryPromise({
        try: () => rm(dir, { recursive: true, force: true }),
        catch: () => failed("scratch"),
      }),
  );
});

const CLONE_LOCATION_OVERRIDES = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CONFIG",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
];

/** Established destinations and configuration bound to the command that will execute. */
export interface GitRemoteResolution {
  readonly urls: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/** Clone templates are scoped snapshots; callers keep this scope through transport. */
export const resolveGitRemoteOperation = (
  operation: GitRemoteOperation,
): Effect.Effect<GitRemoteResolution, GitRemoteResolutionError, Scope.Scope> =>
  operation.direction === "clone"
    ? resolveGitClone(operation)
    : resolveGitRemote(operation).pipe(Effect.map((urls) => ({ urls, env: operation.env })));

const copyTemplate = async (source: string, destination: string): Promise<void> => {
  const info = await lstat(source);
  if (!info.isDirectory()) throw failed("clone-template");
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    // Git ignores dot entries at every level. Everything it copies must stay regular and owned.
    if (entry.name.startsWith(".")) continue;
    const original = join(source, entry.name);
    const copied = join(destination, entry.name);
    const stat = await lstat(original);
    if (stat.isDirectory()) await copyTemplate(original, copied);
    else if (stat.isFile()) {
      await copyFile(original, copied);
      await chmod(copied, stat.mode & 0o777);
    } else throw failed("clone-template");
  }
};

const resolveGitClone = Effect.fn("GitRemote.resolveClone")(function* (
  operation: Extract<GitRemoteOperation, { readonly direction: "clone" }>,
): Effect.fn.Return<GitRemoteResolution, GitRemoteResolutionError, Scope.Scope> {
  const env = { ...process.env, ...operation.env };
  if (CLONE_LOCATION_OVERRIDES.some((name) => env[name] !== undefined))
    return yield* failed("clone-context");
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "mend-clone-url-")),
      catch: () => failed("scratch"),
    }),
    (dir) =>
      Effect.gen(function* () {
        const repository = join(dir, "probe");
        const gitDir = operation.cloneKind === "bare" ? repository : join(repository, ".git");
        // Never initialize from an unchecked template: a config symlink makes init write outside
        // the owned probe. This empty-template init sees protected global/system/command config.
        yield* gitRead(
          [
            "init",
            "-q",
            "--template=",
            ...(operation.cloneKind === "bare" ? ["--bare"] : []),
            repository,
          ],
          operation.cwd,
          env,
          "scratch",
        );
        const all = yield* required(
          yield* gitRead(
            [`--git-dir=${gitDir}`, "config", "--null", "--list", "--includes"],
            operation.cwd,
            env,
            "configuration",
          ),
          "configuration",
        );
        if (all.split("\0").some((entry) => /^(?:includeif|remote)\./.test(entry)))
          return yield* failed("clone-configuration");
        const configured =
          env["GIT_TEMPLATE_DIR"] !== undefined
            ? env["GIT_TEMPLATE_DIR"]
            : yield* gitRead(
                [`--git-dir=${gitDir}`, "config", "--null", "--path", "--get", "init.templateDir"],
                operation.cwd,
                env,
                "configuration",
                { allowMissingConfig: true },
              ).pipe(
                Effect.map((answer) =>
                  answer === null ? null : answer.endsWith("\0") ? answer.slice(0, -1) : answer,
                ),
              );
        let template = "";
        if (configured !== null && configured !== undefined && configured !== "") {
          if (configured.includes("\0") || configured.includes("\r") || configured.includes("\n"))
            return yield* failed("clone-template");
          const snapshot = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () => mkdtemp(join(tmpdir(), "mend-clone-template-")),
              catch: () => failed("scratch"),
            }),
            (owned) => Effect.promise(() => rm(owned, { recursive: true, force: true })),
          );
          template = join(snapshot, "template");
          yield* Effect.tryPromise({
            try: () => copyTemplate(resolvePath(operation.cwd, configured), template),
            catch: () => failed("clone-template"),
            // Node's copyFile promise cannot be aborted. Finish it before scope cleanup removes
            // the snapshot, rather than let interrupted copying recreate released directories.
          }).pipe(Effect.uninterruptible);
          const templateFiles = yield* Effect.tryPromise({
            try: () => readdir(template),
            catch: () => failed("clone-template"),
          });
          for (const name of ["config", "config.worktree"]) {
            if (!templateFiles.includes(name)) continue;
            const configPath = join(template, name);
            const local = yield* required(
              yield* gitRead(
                ["config", "--file", configPath, "--null", "--list", "--no-includes"],
                operation.cwd,
                env,
                "clone-template",
              ),
              "clone-template",
            );
            if (
              local.split("\0").some((entry) => /^(?:url|include|includeif|remote)\./.test(entry))
            )
              return yield* failed("clone-template");
          }
        }
        // Git has no public query for its compiled default template path. Bind an empty template
        // when none was configured, and carry a validated custom snapshot through the real clone.
        const boundEnv = { ...operation.env, GIT_TEMPLATE_DIR: template };
        const name = `mend-probe-${randomUUID()}`;
        const writeEnv = {
          ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_"))),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "0",
          GIT_CONFIG_PARAMETERS: "",
        };
        yield* gitRead(
          ["config", "--file", join(gitDir, "config"), `remote.${name}.url`, operation.remote],
          operation.cwd,
          writeEnv,
          "scratch",
        );
        const answer = yield* required(
          yield* gitRead(
            [`--git-dir=${gitDir}`, "remote", "get-url", name],
            operation.cwd,
            { ...env, ...boundEnv },
            "destination",
          ),
          "destination",
        );
        return { urls: yield* parseUrls(answer), env: boundEnv };
      }),
    (dir) =>
      Effect.tryPromise({
        try: () => rm(dir, { recursive: true, force: true }),
        catch: () => failed("scratch"),
      }),
  );
});
