import type { Refused } from "@mend/local-git/handoff";
import { describe, expect, it } from "vitest";

import {
  completionWords,
  continuation,
  excludedFiles,
  HANDOFF_UNSUPPORTED,
  issueWords,
  localIssueWords,
  openQuestion,
  renderQuestion,
  stepQuestion,
  type Question,
  type QuestionEvent,
} from "./handoff.js";
import { project, summary, receipt } from "./test-handoff.js";

const budgetIssueWords = (budget: string) =>
  issueWords({
    kind: "refused",
    message: "Mend refused this handoff.",
    budget,
    limit: 4,
    reason: null,
    retryAfterSeconds: 12,
  });

const capturing: Question = {
  ...openQuestion(),
  kind: "capturing",
  generation: 1,
  target: { kind: "project", project },
};
const editing: Question = { ...capturing, kind: "editing", summary, fileBytes: 8192 };
const events: ReadonlyArray<QuestionEvent> = [
  { kind: "typed", value: "keep this" },
  { kind: "connection", offline: true },
  { kind: "reading-terms" },
  { kind: "capture", target: { kind: "project", project } },
  { kind: "capture-ready", generation: 1, summary, fileBytes: 8192 },
  { kind: "refused", generation: 1, message: "refused" },
  { kind: "env-files", value: "include" },
  { kind: "refresh-snapshot" },
  { kind: "show-files" },
  { kind: "back" },
  { kind: "accept" },
  { kind: "cancel" },
];
const states: ReadonlyArray<Question> = [
  openQuestion(),
  { ...openQuestion(), kind: "reading-terms" },
  capturing,
  editing,
  { ...editing, kind: "files-left-out" },
  { ...openQuestion(), kind: "refused", message: "no origin" },
  { ...openQuestion(), kind: "closed" },
];
describe("the handoff question", () => {
  it.each(states)("every event at $kind preserves the cancellation boundary", (state) => {
    for (const event of events) {
      const next = stepQuestion(state, event);
      if (next.effect.kind === "submit")
        expect([state.kind, event.kind, next.state.kind]).toEqual(["editing", "accept", "closed"]);
      if (event.kind === "cancel" && state.kind !== "closed")
        expect(next.effect.kind).toBe("discard");
      if (state.kind === "closed") expect(next.state).toBe(state);
    }
  });
  it("keeps typing through capture and rejects stale generations", () => {
    const typed = stepQuestion(capturing, { kind: "typed", value: "my prompt" }).state;
    expect(
      stepQuestion(typed, { kind: "capture-ready", generation: 0, summary, fileBytes: 8192 }).state,
    ).toBe(typed);
    const ready = stepQuestion(typed, {
      kind: "capture-ready",
      generation: 1,
      summary,
      fileBytes: 8192,
    }).state;
    expect(ready.prompt).toBe("my prompt");
    const included = stepQuestion(ready, { kind: "env-files", value: "include" });
    expect(included.effect).toEqual({ kind: "capture", envFiles: "include", generation: 2 });
    expect(included.state.prompt).toBe("my prompt");
    expect(stepQuestion(included.state, { kind: "accept" }).effect.kind).toBe("none");
  });
  it("keeps the prompt offline and through Files left out and Back", () => {
    const off = stepQuestion(
      { ...editing, prompt: "keep" },
      { kind: "connection", offline: true },
    ).state;
    expect(stepQuestion(off, { kind: "accept" }).effect.kind).toBe("none");
    const files = stepQuestion(off, { kind: "show-files" }).state;
    expect(stepQuestion(files, { kind: "back" }).state).toEqual(off);
    expect(stepQuestion({ ...off, offline: false }, { kind: "accept" }).effect).toEqual({
      kind: "submit",
      continuation: { kind: "prompt", prompt: "keep" },
    });
  });
  it("accepts an empty prompt as hold and joins a repeated Enter", () => {
    const next = stepQuestion(editing, { kind: "accept" });
    expect(next.effect).toEqual({ kind: "submit", continuation: { kind: "hold" } });
    expect(stepQuestion(next.state, { kind: "accept" }).effect.kind).toBe("none");
  });
  it.each(["x\0", "\ud800", "a".repeat(130_000)])(
    "invalid prompts stay in the question",
    (prompt) => {
      expect(continuation(prompt).kind).toBe("invalid");
      expect(stepQuestion({ ...editing, prompt }, { kind: "accept" }).state.kind).toBe("editing");
    },
  );
  it("accepts a long prompt without filtering rows", () =>
    expect(continuation("a".repeat(100_000))).toEqual({
      kind: "prompt",
      prompt: "a".repeat(100_000),
    }));
  it("Refresh explicitly replaces the snapshot", () =>
    expect(stepQuestion(editing, { kind: "refresh-snapshot" }).effect).toEqual({
      kind: "capture",
      generation: 2,
      envFiles: "exclude",
    }));
});
const words = (why: Refused["why"]) =>
  localIssueWords({ _tag: "refused", why, message: "not UI copy" });
describe("handoff words", () => {
  it("shows story g's facts, title, explanation, and committed-env exception before acceptance", () => {
    const view = renderQuestion(editing);
    expect(view.title).toBe("Hand off fix/login to Mend · newsroom-api");
    expect(view.placeholder).toBe("Continue with: optional · claude");
    expect(view.prompt).toContain(
      "2 commits ahead of main · 3 uncommitted files · 1 untracked · .env left out",
    );
    expect(view.prompt).toContain("Your checkout stays as it is.");
    expect(view.prompt).toContain(
      ".env.example is already in commit abcdef0; it travels in history.",
    );
    expect(excludedFiles(summary, 8192).map((row) => row.label)).toEqual([
      ".env.local",
      ".env.ignored",
      "big.bin",
      "lfs.dat",
      ".env.example",
    ]);
  });
  it("ends every line as a sentence, because the input box runs them into one paragraph", () => {
    const view = renderQuestion({
      ...editing,
      offline: true,
      target: { kind: "adopt", name: project.name, origin: project.originUrl ?? "" },
      summary: { ...summary, hidden: [{ path: "config/app.json", bit: "skip-worktree" }] },
    });
    for (const line of view.prompt.split("\n")) expect(line).toMatch(/[.?!]$/u);
  });
  it("names what stays here and what travels hidden beside the facts", () => {
    const one = renderQuestion({
      ...editing,
      summary: {
        ...summary,
        leftOut: [{ path: "big.bin", reason: "over-limit", bytes: 9000 }],
        hidden: [{ path: "config/app.json", bit: "skip-worktree" }],
      },
    });
    expect(one.prompt).toContain("big.bin stays here · 8.8 KB, over the 8.0 KB file limit");
    expect(one.prompt).toContain("config/app.json travels though Git hides it (skip-worktree)");
    expect(renderQuestion(editing).prompt).toContain(
      "2 files stay here · Files left out… names them",
    );
    const edge = renderQuestion({
      ...editing,
      fileBytes: 8 * 1024 * 1024,
      summary: {
        ...summary,
        leftOut: [{ path: "big.bin", reason: "over-limit", bytes: 8 * 1024 * 1024 + 1 }],
      },
    });
    expect(edge.prompt).toContain(
      "big.bin stays here · 8,388,609 bytes, over the 8,388,608-byte file limit",
    );
  });
  it("names adoption and detached/even facts without inventing a project", () => {
    const view = renderQuestion({
      ...editing,
      target: { kind: "adopt", name: project.name, origin: project.originUrl ?? "" },
      summary: { ...summary, localBranch: null, facts: { ...summary.facts, commitsAhead: 0 } },
    });
    expect(view.prompt).toContain("Adopt github.com/acme/newsroom-api and hand off");
    expect(view.prompt).toContain("detached at 1111111 · uncommitted files on HEAD");
    expect(view.prompt).toContain("even with main");
  });
  it("always dates the completion and names replay only when observed", () => {
    expect(completionWords(receipt(), summary.cutAt)).toContain(
      "Handed off as fix-login. Your checkout is unchanged. Snapshot as of",
    );
    expect(
      completionWords({ ...receipt(), replayed: true, previous: "fix-login-old" }, summary.cutAt),
    ).toContain("Mend confirmed the earlier handoff. Your earlier handoff is fix-login-old.");
  });
  it("words local refusals from their data, never from the CLI's sentence", () => {
    expect(words({ reason: "no-commit" })).toBe(
      "This branch has no commit yet. Commit once, then hand off.",
    );
    expect(words({ reason: "no-tracking-branch", branch: "trunk" })).toBe(
      "This checkout has no origin/trunk. Run git fetch origin, then hand off.",
    );
    expect(words({ reason: "unmerged", paths: 3 })).toBe(
      "This checkout has 3 unmerged paths. Finish or abort the merge, then hand off.",
    );
    expect(words({ reason: "partial-clone", mergeBase: "abcdef1234", words: "x" })).toContain(
      "git log -p abcdef1..HEAD",
    );
  });
  it("distinguishes a proxy, bundle limit, missing adoption route and old server", () => {
    expect(issueWords({ kind: "proxy-too-small", bytes: 1000 })).toContain(
      "Something in front of Mend refused",
    );
    expect(issueWords({ kind: "bundle-too-large", bytes: 1000, limit: 500 })).toBe(
      "Handoff not sent. The bundle is 1000 B; this server takes 500 B.",
    );
    expect(issueWords({ kind: "adoption-terms-unsupported" })).toContain(
      "first-adoption handoff limits route",
    );
    expect(issueWords({ kind: "unsupported" })).toBe(HANDOFF_UNSUPPORTED);
  });
  it("distinguishes room, concurrency, origin rate and file budgets, with retry-after only for transient limits", () => {
    expect(budgetIssueWords("accountLiveSessions")).toContain(
      "Limit 4: unsettled sessions for your account.",
    );
    expect(budgetIssueWords("accountLiveSessions")).not.toContain("Try again in");
    expect(budgetIssueWords("accountHandoffsInFlight")).toContain(
      "handoffs in progress for your account. Try again in 12 seconds.",
    );
    expect(budgetIssueWords("accountOriginChecksPerMinute")).toContain(
      "origin checks per minute for your account. Try again in 12 seconds.",
    );
    expect(budgetIssueWords("handoffFileBytes")).toContain("bytes in one handed-off file.");
    expect(budgetIssueWords("handoffFileBytes")).not.toContain("Try again in");
  });
});
