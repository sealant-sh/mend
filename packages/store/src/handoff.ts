import * as fs from "node:fs";
import * as path from "node:path";

import { Sha } from "@mend/domain";
import {
  HANDOFF_SNAPSHOT_REF,
  HexSha,
  parseHandoffMessage,
  type HandoffTrailers,
} from "@mend/domain/workbench";
import { Duration, Effect, Result, Schema } from "effect";

import { git, GitError, gitExitUnexplained, gitOutput, gitRejectsContent } from "./git.ts";

const admitted: unique symbol = Symbol("AdmittedHandoff");

export interface AdmittedHandoff {
  readonly [admitted]: true;
  readonly trailers: HandoffTrailers;
  readonly head: Sha;
  readonly index: Sha;
  /** W: the snapshot commit, the working tree over the index over HEAD. */
  readonly snapshot: Sha;
  readonly mergeBase: Sha;
  readonly worktreeTree: Sha;
  readonly indexTree: Sha;
  readonly defaultBranch: string;
  readonly commitsAhead: number;
  readonly deltaPack: { readonly pack: Uint8Array; readonly idx: Uint8Array };
}

export const HANDOFF_ADMISSION_REFUSALS = [
  "not-a-handoff",
  "damaged",
  "base-unknown",
  "base-off-default-branch",
] as const;

export class HandoffRefusedError extends Schema.TaggedError<HandoffRefusedError>()(
  "HandoffRefusedError",
  { reason: Schema.Literals(HANDOFF_ADMISSION_REFUSALS), message: Schema.String },
) {}

export class HandoffFileOverBudgetError extends Schema.TaggedError<HandoffFileOverBudgetError>()(
  "HandoffFileOverBudgetError",
  { path: Schema.String, bytes: Schema.Int, limit: Schema.Int },
) {}

export type FreshenOutcome =
  | { readonly kind: "fetched" }
  | { readonly kind: "skipped"; readonly words: string }
  | { readonly kind: "failed"; readonly words: string };

export const fetchedFreshen: FreshenOutcome = { kind: "fetched" };
export const skippedFreshen = (words: string): FreshenOutcome => ({ kind: "skipped", words });
export const failedFreshen = (words: string): FreshenOutcome => ({ kind: "failed", words });

export interface AdmitHandoffOptions {
  readonly freshen: Effect.Effect<FreshenOutcome>;
  readonly fileBytes: number;
}

export interface AdmitHandoffInput {
  readonly storePath: string;
  readonly defaultBranch: string;
  readonly bundle: Uint8Array;
  readonly quarantineRoot: string;
  readonly fileBytes: number;
  readonly defaultTip: Effect.Effect<string | null>;
  readonly freshenDefault: Effect.Effect<FreshenOutcome>;
  readonly gitTimeout?: Duration.Duration;
}

export interface BundleHeader {
  readonly refs: ReadonlyArray<{ readonly sha: string; readonly name: string }>;
  readonly prerequisites: ReadonlyArray<string>;
  /** Where the pack starts: the byte after the header's blank line. */
  readonly packStart: number;
}

const BUNDLE_SIGNATURES = ["# v2 git bundle", "# v3 git bundle"];
const HEADER_LIMIT = 64 * 1024;
export const HANDOFF_QUARANTINE_PREFIX = "handoff-q-";
const QUARANTINE_MAX_AGE_MS = 60 * 60 * 1000;
export const HANDOFF_GIT_TIMEOUT = Duration.minutes(5);

const isHexSha = Schema.is(HexSha);

/**
 * A git bundle header runs to its blank line: the signature, then `@capability` lines (v3),
 * `-<sha> <words>` prerequisites and `<sha> <ref>` refs.
 */
export const parseBundleHeader = (bytes: Uint8Array): BundleHeader | null => {
  const text = Buffer.from(bytes.subarray(0, HEADER_LIMIT)).toString("latin1");
  const end = text.indexOf("\n\n");
  if (end === -1) return null;
  const [signature, ...lines] = text.slice(0, end).split("\n");
  if (signature === undefined || !BUNDLE_SIGNATURES.includes(signature)) return null;
  const refs: Array<{ sha: string; name: string }> = [];
  const prerequisites: Array<string> = [];
  for (const line of lines) {
    if (line.startsWith("@")) continue;
    const prerequisite = line.startsWith("-");
    const body = prerequisite ? line.slice(1) : line;
    const space = body.indexOf(" ");
    const sha = space === -1 ? body : body.slice(0, space);
    if (!isHexSha(sha)) return null;
    if (prerequisite) prerequisites.push(sha);
    else if (space === -1) return null;
    else refs.push({ sha, name: body.slice(space + 1) });
  }
  return { refs, prerequisites, packStart: end + 2 };
};

const refuse = (reason: HandoffRefusedError["reason"], message: string) =>
  new HandoffRefusedError({ reason, message: `${message} · nothing was created` });

const notAHandoff = (detail: string) =>
  refuse(
    "not-a-handoff",
    `the upload is not a mend handoff · ${detail} · update the mend CLI and hand off again`,
  );

const firstLine = (words: string): string => words.split("\n").find((line) => line !== "") ?? words;

const damagedOr = (error: GitError) =>
  gitRejectsContent(error)
    ? refuse(
        "damaged",
        `the upload did not verify · git said: ${firstLine(error.stderr)} · hand off again`,
      )
    : error;

const short = (sha: string) => sha.slice(0, 7);

const freshenWords = (outcome: FreshenOutcome, defaultBranch: string): string => {
  switch (outcome.kind) {
    case "fetched":
      return `origin's ${defaultBranch} was fetched and it is still unknown · push ${defaultBranch}, then hand off again`;
    case "skipped":
      return `origin was not fetched · ${outcome.words}`;
    case "failed":
      return `this server could not fetch origin · git said: ${firstLine(outcome.words)}`;
  }
};

const LACKS_PREREQUISITE = /lacks these prerequisite commits/i;

export const admitHandoff = Effect.fn("admitHandoff")(function* (input: AdmitHandoffInput) {
  const header = parseBundleHeader(input.bundle);
  if (header === null) return yield* notAHandoff("the body is not a git bundle");
  if (header.refs.length !== 1 || header.refs[0]?.name !== HANDOFF_SNAPSHOT_REF) {
    return yield* notAHandoff(
      `the bundle names ${header.refs.length === 0 ? "no ref" : header.refs.map((ref) => ref.name).join(", ")} instead of ${HANDOFF_SNAPSHOT_REF}`,
    );
  }
  if (header.prerequisites.length === 0) {
    return yield* notAHandoff("the bundle has no prerequisite: it was not cut at the merge base");
  }
  const snapshot = header.refs[0].sha;
  const timeout = input.gitTimeout ?? HANDOFF_GIT_TIMEOUT;

  yield* Effect.sync(() => fs.mkdirSync(input.quarantineRoot, { recursive: true }));
  const quarantine = yield* Effect.sync(() =>
    fs.mkdtempSync(path.join(input.quarantineRoot, HANDOFF_QUARANTINE_PREFIX)),
  );
  const repo = path.join(quarantine, "repo.git");
  const timedOut = (args: ReadonlyArray<string>) =>
    Effect.fail(
      new GitError({
        args: [...args],
        cwd: repo,
        exitCode: null,
        stderr: `git ${args[0] ?? ""} did not finish within ${Duration.format(timeout)}`,
      }),
    );
  const run = (args: ReadonlyArray<string>, stdin?: string | Uint8Array) =>
    git(args, repo, undefined, undefined, stdin).pipe(
      Effect.timeoutOrElse({ duration: timeout, orElse: () => timedOut(args) }),
    );
  /** `rev-list --parents -n 1 <commit>`: the commit, then its parents. */
  const parentsOf = (commit: string) =>
    run(["rev-list", "--parents", "--max-count=1", commit]).pipe(
      Effect.map((line) => line.split(" ").slice(1)),
    );
  const knows = (commit: string) =>
    run(["cat-file", "-e", `${commit}^{commit}`]).pipe(Effect.result, Effect.map(Result.isSuccess));
  const isAncestor = (ancestor: string, descendant: string) =>
    gitOutput(["merge-base", "--is-ancestor", ancestor, descendant], repo).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => timedOut(["merge-base", "--is-ancestor"]),
      }),
      Effect.flatMap((ran) =>
        ran.exitCode === 0
          ? Effect.succeed(true)
          : ran.exitCode === 1
            ? Effect.succeed(false)
            : Effect.fail(
                new GitError({
                  args: ["merge-base", "--is-ancestor", ancestor, descendant],
                  cwd: repo,
                  exitCode: ran.exitCode,
                  stderr: ran.stderr.trim(),
                }),
              ),
      ),
    );

  const inQuarantine = Effect.gen(function* () {
    const file = path.join(quarantine, "handoff.bundle");
    yield* Effect.sync(() => fs.writeFileSync(file, input.bundle, { mode: 0o600 }));
    yield* git(["init", "-q", "--bare", repo], quarantine);
    const objects = yield* git(
      ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
      input.storePath,
    );
    yield* Effect.sync(() =>
      fs.writeFileSync(path.join(repo, "objects", "info", "alternates"), `${objects}\n`),
    );

    let freshened: FreshenOutcome | null = null;
    const freshenOnce = Effect.gen(function* () {
      if (freshened !== null) return freshened;
      freshened = yield* input.freshenDefault;
      return freshened;
    });

    const verify = run(["bundle", "verify", file]).pipe(Effect.result);
    let verified = yield* verify;
    if (Result.isFailure(verified) && LACKS_PREREQUISITE.test(verified.failure.stderr)) {
      yield* freshenOnce;
      verified = yield* verify;
    }
    if (Result.isFailure(verified)) {
      if (LACKS_PREREQUISITE.test(verified.failure.stderr)) {
        const outcome = yield* freshenOnce;
        return yield* refuse(
          "base-unknown",
          `your branch starts at ${short(header.prerequisites[0] ?? "")}, which this server has not seen on origin's ${input.defaultBranch} · ${freshenWords(outcome, input.defaultBranch)}`,
        );
      }
      if (gitExitUnexplained(verified.failure)) {
        return yield* notAHandoff(`git said: ${firstLine(verified.failure.stderr)}`);
      }
      return yield* damagedOr(verified.failure);
    }

    // `index-pack --strict` checks every object on any git: `fetch` from a bundle ignores
    // `fetch.fsckObjects` on the server image's git 2.39.
    yield* run(
      ["index-pack", "--stdin", "--fix-thin", "--strict"],
      input.bundle.subarray(header.packStart),
    ).pipe(Effect.mapError(damagedOr));

    const [index, ...otherParentsOfW] = yield* parentsOf(snapshot);
    if (index === undefined || otherParentsOfW.length > 0) {
      return yield* notAHandoff("the snapshot commit does not have exactly one parent");
    }
    const [head, ...otherParentsOfI] = yield* parentsOf(index);
    if (head === undefined || otherParentsOfI.length > 0) {
      return yield* notAHandoff("the index commit does not have exactly one parent");
    }

    const raw = yield* run(["cat-file", "commit", snapshot]);
    const message = raw.slice(raw.indexOf("\n\n") + 2);
    const parsed = parseHandoffMessage(message);
    if (Result.isFailure(parsed)) {
      return yield* notAHandoff(
        `the snapshot's message is not a handoff's (${parsed.failure.detail})`,
      );
    }
    const trailers = parsed.success;
    const mergeBase = trailers.mergeBase;
    if (!header.prerequisites.includes(mergeBase)) {
      return yield* notAHandoff(
        `the bundle was not cut at its base ${short(mergeBase)}: its prerequisites are ${header.prerequisites.map(short).join(", ")}`,
      );
    }

    const storeTipOf = Effect.gen(function* () {
      const storeTip = yield* input.defaultTip;
      if (storeTip === null || !(yield* knows(trailers.defaultTip))) return null;
      return (yield* isAncestor(trailers.defaultTip, storeTip)) ? storeTip : "off-default";
    });
    let storeTip = yield* storeTipOf;
    if (storeTip === null || storeTip === "off-default") {
      yield* freshenOnce;
      storeTip = yield* storeTipOf;
    }
    if (storeTip === null) {
      const outcome = yield* freshenOnce;
      return yield* refuse(
        "base-unknown",
        `your origin/${input.defaultBranch} (${short(trailers.defaultTip)}) is not one this server has seen · ${freshenWords(outcome, input.defaultBranch)}`,
      );
    }
    if (storeTip === "off-default") {
      return yield* refuse(
        "base-off-default-branch",
        `your origin/${input.defaultBranch} (${short(trailers.defaultTip)}) is not on this server's origin/${input.defaultBranch} · fetch origin and rebase onto origin/${input.defaultBranch}, then hand off again`,
      );
    }
    const bases = (yield* run(["merge-base", "--all", head, trailers.defaultTip])).split("\n");
    if (!bases.includes(mergeBase)) {
      return yield* notAHandoff(
        `the bundle's base ${short(mergeBase)} is not the merge base of its branch with ${input.defaultBranch} ${short(trailers.defaultTip)}`,
      );
    }
    for (const prerequisite of header.prerequisites) {
      if (!(yield* isAncestor(prerequisite, storeTip))) {
        return yield* notAHandoff(
          `the bundle's prerequisite ${short(prerequisite)} is not on this server's origin/${input.defaultBranch}`,
        );
      }
    }

    yield* run(["rev-list", "--objects", "--missing=error", snapshot, `^${mergeBase}`]).pipe(
      Effect.mapError(damagedOr),
    );

    if (input.fileBytes > 0) {
      const fresh = yield* run(["rev-list", "--objects", snapshot, index, `^${head}`]);
      const sizes = yield* run(
        ["cat-file", "--batch-check=%(objecttype) %(objectsize) %(rest)"],
        `${fresh}\n`,
      );
      for (const line of sizes.split("\n")) {
        const match = /^blob (\d+) (.*)$/.exec(line);
        if (match === null) continue;
        const bytes = Number(match[1]);
        if (bytes > input.fileBytes) {
          return yield* new HandoffFileOverBudgetError({
            path: match[2] ?? "",
            bytes,
            limit: input.fileBytes,
          });
        }
      }
    }

    const trees = (yield* run(["rev-parse", `${snapshot}^{tree}`, `${index}^{tree}`])).split("\n");
    const [worktreeTree, indexTree] = trees;
    if (worktreeTree === undefined || indexTree === undefined) {
      return yield* notAHandoff("the snapshot's trees could not be read");
    }
    const commitsAhead = Number(yield* run(["rev-list", "--count", head, `^${mergeBase}`]));

    const name = yield* run(
      ["pack-objects", "-q", "--revs", path.join(quarantine, "delta")],
      `${snapshot}\n^${mergeBase}\n`,
    );
    const deltaPack = yield* Effect.sync(() => ({
      pack: new Uint8Array(fs.readFileSync(path.join(quarantine, `delta-${name}.pack`))),
      idx: new Uint8Array(fs.readFileSync(path.join(quarantine, `delta-${name}.idx`))),
    }));

    const result: AdmittedHandoff = {
      [admitted]: true,
      trailers,
      head: Sha.make(head),
      index: Sha.make(index),
      snapshot: Sha.make(snapshot),
      mergeBase: Sha.make(mergeBase),
      worktreeTree: Sha.make(worktreeTree),
      indexTree: Sha.make(indexTree),
      defaultBranch: input.defaultBranch,
      commitsAhead,
      deltaPack,
    };
    return result;
  });
  return yield* inQuarantine.pipe(
    Effect.ensuring(Effect.sync(() => fs.rmSync(quarantine, { recursive: true, force: true }))),
  );
});

export const sweepHandoffQuarantines = (
  quarantineRoot: string,
  now: number,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.sync(() => {
    if (!fs.existsSync(quarantineRoot)) return [];
    const removed: Array<string> = [];
    for (const entry of fs.readdirSync(quarantineRoot)) {
      if (!entry.startsWith(HANDOFF_QUARANTINE_PREFIX)) continue;
      const dir = path.join(quarantineRoot, entry);
      if (now - fs.statSync(dir).mtimeMs < QUARANTINE_MAX_AGE_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
    return removed;
  });
