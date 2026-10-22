import { HandoffCutAt, HexSha } from "@mend/domain/workbench";
import type {
  CaptureSummary,
  LocalCheckout,
  Refused,
  Cancelled,
  PackOutcome,
} from "@mend/local-git/handoff";
import { Schema } from "effect";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Why = Schema.Union([
  Schema.Struct({ reason: Schema.Literal("not-a-checkout"), dir: Schema.String }),
  Schema.Struct({
    reason: Schema.Literals(["no-commit", "nothing-fetched", "unknown-default"]),
  }),
  Schema.Struct({
    reason: Schema.Literals(["no-tracking-branch", "unrelated-history"]),
    branch: Schema.String,
  }),
  Schema.Struct({ reason: Schema.Literal("unmerged"), paths: Count }),
  Schema.Struct({
    reason: Schema.Literals(["scratch-inside-checkout", "scratch-exposed"]),
    parent: Schema.String,
  }),
  Schema.Struct({
    reason: Schema.Literal("partial-clone"),
    mergeBase: Schema.String,
    words: Schema.String,
  }),
  Schema.Struct({ reason: Schema.Literals(["timed-out", "git"]), words: Schema.String }),
]);
const Refusal = Schema.Struct({
  _tag: Schema.Literal("refused"),
  why: Why,
  message: Schema.String,
});
const Cancelled = Schema.Struct({ _tag: Schema.Literal("cancelled") });
const Checkout = Schema.Struct({
  top: Schema.String,
  gitDir: Schema.String,
  commonDir: Schema.String,
  originUrl: Schema.NullOr(Schema.String),
});
const EnvFiles = Schema.Literals(["exclude", "include"]);
const HiddenBit = Schema.Literals([
  "assume-unchanged",
  "skip-worktree",
  "assume-unchanged and skip-worktree",
]);
const Summary = Schema.Struct({
  head: HexSha,
  index: HexSha,
  worktree: HexSha,
  mergeBase: HexSha,
  defaultTip: HexSha,
  defaultBranch: Schema.String,
  localBranch: Schema.NullOr(Schema.String),
  cutAt: HandoffCutAt,
  envFiles: EnvFiles,
  facts: Schema.Struct({ commitsAhead: Count, uncommitted: Count, untracked: Count }),
  leftOut: Schema.Array(
    Schema.Union([
      Schema.Struct({ reason: Schema.Literals(["env", "ignored-env"]), path: Schema.String }),
      Schema.Struct({ reason: Schema.Literal("over-limit"), path: Schema.String, bytes: Count }),
      Schema.Struct({
        reason: Schema.Literal("filter"),
        path: Schema.String,
        filter: Schema.String,
      }),
    ]),
  ),
  committedEnv: Schema.Array(Schema.Struct({ path: Schema.String, commit: Schema.String })),
  hidden: Schema.Array(Schema.Struct({ path: Schema.String, bit: HiddenBit })),
});
export const WorkerReply = Schema.Struct({
  id: Count,
  result: Schema.Union([
    Refusal,
    Cancelled,
    Schema.Struct({ _tag: Schema.Literal("checkout"), checkout: Checkout }),
    Schema.Struct({ _tag: Schema.Literal("captured"), summary: Summary }),
    Schema.Struct({
      _tag: Schema.Literal("packed"),
      bundlePath: Schema.String,
      bundleBytes: Count,
    }),
    Schema.Struct({ _tag: Schema.Literal("disposed") }),
  ]),
});
export type WorkerResult =
  | Refused
  | Cancelled
  | PackOutcome
  | { readonly _tag: "checkout"; readonly checkout: LocalCheckout }
  | { readonly _tag: "captured"; readonly summary: CaptureSummary }
  | { readonly _tag: "disposed" };
export const WorkerCommand = Schema.Struct({
  id: Count,
  job: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("discover") }),
    Schema.Struct({ kind: Schema.Literal("dispose") }),
    Schema.Struct({ kind: Schema.Literal("pack") }),
    Schema.Struct({
      kind: Schema.Literal("capture"),
      defaultBranch: Schema.NullOr(Schema.String),
      fileBytes: Count,
      envFiles: EnvFiles,
      cutAt: HandoffCutAt,
    }),
  ]),
});
export type WorkerJob = typeof WorkerCommand.Type.job;
export const WorkerConfiguration = Schema.Struct({
  checkout: Schema.String,
  scratch: Schema.String,
  git: Schema.String,
  timeoutMs: Count,
  deadlineMs: Count,
});
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const replyMatchesLocalGit: Same<(typeof WorkerReply.Encoded)["result"], WorkerResult> =
  true;
