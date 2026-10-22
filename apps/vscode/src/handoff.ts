import { formatFactLine } from "@mend/domain/workbench";
import type { CaptureSummary, EnvFiles, LeftOut, Refused } from "@mend/local-git/handoff";

import type { HandoffIssue, HandoffReceipt } from "./handoff-client.js";
import { promptIssue } from "./new-session.js";
import type { Project } from "./types.js";

export const HANDOFF_RELEASE = "0.36";
export const HANDOFF_UNSUPPORTED = `This Mend server doesn't take handoffs yet · added in Mend ${HANDOFF_RELEASE}`;
export const HANDOFF_OFFLINE = "Mend is offline · retrying";
export const HANDOFF_DETAIL =
  "Copies your branch and uncommitted files into a new session. Your checkout stays as it is.";
export type HandoffTarget =
  | { readonly kind: "project"; readonly project: Project }
  | { readonly kind: "adopt"; readonly origin: string; readonly name: string };
export type Continuation =
  | { readonly kind: "hold" }
  | { readonly kind: "prompt"; readonly prompt: string };
export const continuation = (
  value: string,
): Continuation | { readonly kind: "invalid"; readonly message: string } => {
  if (value.trim() === "") return { kind: "hold" };
  const message = promptIssue(value, "claude");
  return message === null ? { kind: "prompt", prompt: value.trim() } : { kind: "invalid", message };
};
/**
 * Her prompt per account, kept for the next question until Mend confirms a launch of it or she
 * clears the box. No other outcome lets it go.
 */
export class KeptPrompts {
  readonly #byAccount = new Map<string, { readonly text: string; launched: boolean }>();
  reopensWith(account: string): string {
    const kept = this.#byAccount.get(account);
    return kept === undefined || kept.launched ? "" : kept.text;
  }
  typed(account: string, text: string): void {
    if (this.reopensWith(account) !== text) this.#byAccount.set(account, { text, launched: false });
  }
  /** Gives back what to call once Mend confirms a launch of it. */
  accepted(account: string, text: string): () => void {
    const kept = { text, launched: false };
    this.#byAccount.set(account, kept);
    return () => {
      kept.launched = true;
    };
  }
}
interface QuestionData {
  readonly prompt: string;
  readonly generation: number;
  readonly offline: boolean;
  readonly envFiles: EnvFiles;
}
export type Question = QuestionData &
  (
    | { readonly kind: "resolving" | "reading-terms" }
    | { readonly kind: "capturing"; readonly target: HandoffTarget }
    | {
        readonly kind: "editing" | "files-left-out";
        readonly target: HandoffTarget;
        readonly summary: CaptureSummary;
        readonly fileBytes: number;
      }
    | { readonly kind: "refused"; readonly message: string }
    | { readonly kind: "closed" }
  );
export type QuestionEvent =
  | { readonly kind: "typed"; readonly value: string }
  | { readonly kind: "connection"; readonly offline: boolean }
  | { readonly kind: "reading-terms" }
  | { readonly kind: "capture"; readonly target: HandoffTarget }
  | {
      readonly kind: "capture-ready";
      readonly generation: number;
      readonly summary: CaptureSummary;
      readonly fileBytes: number;
    }
  | { readonly kind: "refused"; readonly generation: number; readonly message: string }
  | { readonly kind: "env-files"; readonly value: EnvFiles }
  | { readonly kind: "refresh-snapshot" | "show-files" | "back" | "accept" | "cancel" };
export type QuestionEffect =
  | { readonly kind: "none" | "discard" }
  | { readonly kind: "capture"; readonly envFiles: EnvFiles; readonly generation: number }
  | { readonly kind: "submit"; readonly continuation: Continuation };
export const openQuestion = (prompt = ""): Question => ({
  kind: "resolving",
  prompt,
  generation: 0,
  offline: false,
  envFiles: "exclude",
});
export const stepQuestion = (
  state: Question,
  event: QuestionEvent,
): { readonly state: Question; readonly effect: QuestionEffect; readonly issue: string | null } => {
  const stay = { state, effect: { kind: "none" } as const, issue: null };
  if (state.kind === "closed") return stay;
  if (event.kind === "cancel")
    return { ...stay, state: { ...state, kind: "closed" }, effect: { kind: "discard" } };
  if (event.kind === "typed") return { ...stay, state: { ...state, prompt: event.value } };
  if (event.kind === "connection") return { ...stay, state: { ...state, offline: event.offline } };
  if (event.kind === "reading-terms" && state.kind === "resolving")
    return { ...stay, state: { ...state, kind: "reading-terms" } };
  if (event.kind === "refused" && event.generation === state.generation)
    return { ...stay, state: { ...state, kind: "refused", message: event.message } };
  if (event.kind === "capture" && (state.kind === "resolving" || state.kind === "reading-terms")) {
    const generation = state.generation + 1;
    return {
      ...stay,
      state: { ...state, kind: "capturing", target: event.target, generation },
      effect: { kind: "capture", envFiles: state.envFiles, generation },
    };
  }
  if (
    event.kind === "capture-ready" &&
    state.kind === "capturing" &&
    event.generation === state.generation
  )
    return {
      ...stay,
      state: { ...state, kind: "editing", summary: event.summary, fileBytes: event.fileBytes },
    };
  if (
    (event.kind === "env-files" || event.kind === "refresh-snapshot") &&
    (state.kind === "editing" || state.kind === "capturing")
  ) {
    const generation = state.generation + 1;
    const envFiles = event.kind === "env-files" ? event.value : state.envFiles;
    return {
      ...stay,
      state: { ...state, kind: "capturing", generation, envFiles },
      effect: { kind: "capture", generation, envFiles },
    };
  }
  if (event.kind === "show-files" && state.kind === "editing")
    return { ...stay, state: { ...state, kind: "files-left-out" } };
  if (event.kind === "back" && state.kind === "files-left-out")
    return { ...stay, state: { ...state, kind: "editing" } };
  if (event.kind === "accept" && state.kind === "editing" && !state.offline) {
    const parsed = continuation(state.prompt);
    if (parsed.kind === "invalid") return { ...stay, issue: parsed.message };
    return {
      ...stay,
      state: { ...state, kind: "closed" },
      effect: { kind: "submit", continuation: parsed },
    };
  }
  return stay;
};
export const displayOrigin = (origin: string): string => {
  try {
    const url = new URL(origin);
    return `${url.host}${url.pathname}`.replace(/\.git$/, "");
  } catch {
    return origin
      .replace(/^[^/@]+@/, "")
      .replace(":", "/")
      .replace(/\.git$/, "");
  }
};
export const cutTime = (cutAt: string): string =>
  new Date(cutAt).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export const sizeWords = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
export const renderQuestion = (
  state: Question,
): {
  readonly title: string;
  readonly prompt: string;
  readonly placeholder: string;
  readonly busy: boolean;
  readonly value: string;
} => {
  const ready = state.kind === "editing" || state.kind === "files-left-out";
  const target = "target" in state ? state.target : null;
  const name = target?.kind === "project" ? target.project.name : target?.name;
  const summary = ready ? state.summary : null;
  const branch =
    summary?.localBranch ??
    (summary === null ? "your branch" : `detached at ${summary.head.slice(0, 7)}`);
  const facts =
    summary === null
      ? "Reading your checkout…"
      : [
          ...(summary.localBranch === null
            ? [`detached at ${summary.head.slice(0, 7)} · uncommitted files on HEAD`]
            : []),
          formatFactLine({ ...summary.facts, defaultBranch: summary.defaultBranch }),
          summary.envFiles === "include" ? ".env included" : ".env left out",
        ].join(" · ");
  return {
    title: `Hand off ${branch} to Mend${name === undefined ? "" : ` · ${name}`}`,
    placeholder: "Continue with: optional · claude",
    value: state.prompt,
    busy:
      state.kind === "resolving" || state.kind === "reading-terms" || state.kind === "capturing",
    prompt: [
      ...(target?.kind === "adopt" ? [`Adopt ${displayOrigin(target.origin)} and hand off`] : []),
      ...(state.offline ? [HANDOFF_OFFLINE] : []),
      state.kind === "refused" ? state.message : facts,
      HANDOFF_DETAIL,
      ...(summary === null
        ? []
        : [
            ...noticeLines(summary, ready ? state.fileBytes : 0),
            `Snapshot as of ${cutTime(summary.cutAt)}. Gitignored files excluded.`,
          ]),
    ]
      .map((line) => (/[.?!]$/u.test(line) ? line : `${line}.`))
      .join("\n"),
  };
};
type Named = Extract<LeftOut, { readonly reason: "over-limit" | "filter" }>;
const isNamed = (file: LeftOut): file is Named =>
  file.reason === "over-limit" || file.reason === "filter";
const overLimitWords = (bytes: number, limit: number): string =>
  sizeWords(bytes) === sizeWords(limit)
    ? `${bytes.toLocaleString("en-US")} bytes, over the ${limit.toLocaleString("en-US")}-byte file limit`
    : `${sizeWords(bytes)}, over the ${sizeWords(limit)} file limit`;
const leftOutWhy = (file: Named, limit: number): string =>
  file.reason === "over-limit"
    ? overLimitWords(file.bytes, limit)
    : `Git filter ${file.filter}, which a handoff does not run`;
const noticeLines = (summary: CaptureSummary, limit: number): ReadonlyArray<string> => {
  const named = summary.leftOut.filter(isNamed);
  const [only] = named;
  return [
    ...(only !== undefined && named.length === 1
      ? [`${only.path} stays here · ${leftOutWhy(only, limit)}`]
      : named.length > 1
        ? [`${named.length} files stay here · Files left out… names them`]
        : []),
    ...summary.committedEnv.map(
      (file) => `${file.path} is already in commit ${file.commit}; it travels in history.`,
    ),
    ...summary.hidden.map((file) => `${file.path} travels though Git hides it (${file.bit})`),
  ];
};
export const excludedFiles = (
  summary: CaptureSummary,
  limit: number,
): ReadonlyArray<{ readonly label: string; readonly description: string }> => [
  ...summary.leftOut.map((file) => ({
    label: file.path,
    description:
      file.reason === "env"
        ? ".env left out"
        : file.reason === "ignored-env"
          ? "gitignored; never included"
          : leftOutWhy(file, limit),
  })),
  ...summary.committedEnv.map((file) => ({
    label: file.path,
    description: `Already in commit ${file.commit}; travels in history`,
  })),
];
const paths = (count: number): string => `${count} unmerged ${count === 1 ? "path" : "paths"}`;
export const localIssueWords = ({ why }: Refused): string => {
  switch (why.reason) {
    case "not-a-checkout":
      return "This folder is not inside a Git checkout. Open a repository, then hand off.";
    case "no-commit":
      return "This branch has no commit yet. Commit once, then hand off.";
    case "nothing-fetched":
      return "This checkout has fetched nothing from origin. Run git fetch origin, then hand off.";
    case "unknown-default":
      return "This checkout does not know origin's default branch. Run git fetch origin && git remote set-head origin -a, then hand off.";
    case "no-tracking-branch":
      return `This checkout has no origin/${why.branch}. Run git fetch origin, then hand off.`;
    case "unrelated-history":
      return `HEAD shares no history with origin/${why.branch}, so Mend has no base for it.`;
    case "unmerged":
      return `This checkout has ${paths(why.paths)}. Finish or abort the merge, then hand off.`;
    case "scratch-inside-checkout":
      return `The temporary directory ${why.parent} is inside this checkout, and a handoff writes nothing there. Set TMPDIR elsewhere, restart VS Code, then hand off.`;
    case "scratch-exposed":
      return `The temporary directory Mend made under ${why.parent} was readable by others. Check its permissions, then hand off.`;
    case "partial-clone":
      return `This partial clone lacks objects a handoff reads, and Mend never fetches. Run git log -p ${why.mergeBase.slice(0, 7)}..HEAD to fetch them, then hand off.`;
    case "timed-out":
      return "Reading this checkout took too long. Try again.";
    case "git":
      return why.words;
  }
};
const budgetWords: Readonly<Record<string, string>> = {
  accountLiveSessions: "unsettled sessions for your account",
  organizationLiveSessions: "unsettled sessions for your organization",
  accountHandoffsInFlight: "handoffs in progress for your account",
  accountOriginChecksPerMinute: "origin checks per minute for your account",
  accountLaunchesInFlight: "launches starting for your account",
  handoffFileBytes: "bytes in one handed-off file",
};
const retryableBudgets = new Set([
  "accountHandoffsInFlight",
  "accountOriginChecksPerMinute",
  "accountLaunchesInFlight",
  "addressRequestsPerMinute",
  "credentialRequestsPerMinute",
]);
export const issueWords = (issue: HandoffIssue): string => {
  switch (issue.kind) {
    case "unsupported":
      return HANDOFF_UNSUPPORTED;
    case "adoption-terms-unsupported":
      return `This Mend server needs the first-adoption handoff limits route. Upgrade to Mend ${HANDOFF_RELEASE}, then try again.`;
    case "signed-out":
      return "Signed out — sign in again.";
    case "server-changed":
      return "The Mend connection changed. Nothing was handed off. Your prompt is kept; try again.";
    case "bridge-unavailable":
      return "Mend needs this machine's SSH agent to read origin. Start an SSH agent, then try again.";
    case "bundle-too-large":
      return `Handoff not sent. The bundle is ${sizeWords(issue.bytes)}; this server takes ${sizeWords(issue.limit)}.`;
    case "proxy-too-small":
      return `Something in front of Mend refused the ${sizeWords(issue.bytes)} bundle. Check the proxy's body-size limit.`;
    case "refused":
      return [
        issue.message,
        ...(issue.budget === null
          ? []
          : [
              `Limit${issue.limit === null ? "" : ` ${issue.limit}`}: ${budgetWords[issue.budget] ?? issue.budget}.`,
            ]),
        ...(issue.retryAfterSeconds === null ||
        issue.budget === null ||
        !retryableBudgets.has(issue.budget)
          ? []
          : [`Try again in ${issue.retryAfterSeconds} seconds.`]),
      ].join(" ");
    case "unavailable":
      return issue.message;
  }
};
export const completionWords = (receipt: HandoffReceipt, cutAt: string): string =>
  `Handed off as ${receipt.worktree.name}. Your checkout is unchanged. Snapshot as of ${cutTime(cutAt)}.${receipt.replayed ? " Mend confirmed the earlier handoff." : ""}${receipt.previous === null ? "" : ` Your earlier handoff is ${receipt.previous}.`}`;
