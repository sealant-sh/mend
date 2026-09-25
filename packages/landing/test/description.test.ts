import { describe, expect, it } from "vitest";

import {
  DESCRIPTION_END,
  DESCRIPTION_FILE_LIMIT,
  DESCRIPTION_START,
  type DescribedFile,
  type DescriptionInput,
  describedFileOf,
  describePullRequest,
  landingCommitMessage,
  mergeDescription,
  pullRequestTitle,
} from "../src/description.ts";

const file = (path: string, additions: number, deletions: number): DescribedFile => ({
  path,
  oldPath: null,
  status: "modified",
  additions,
  deletions,
  binary: false,
});

const input = (overrides: Partial<DescriptionInput> = {}): DescriptionInput => ({
  tour: {
    summary: "Fixes the login redirect loop when the session cookie expires.",
    approach: "Reads the expiry before redirecting, as the failing test showed.",
  },
  files: [
    file("src/login.ts", 12, 3),
    { ...file("src/old-name.ts", 0, 0), oldPath: "src/old.ts", status: "renamed" },
    { ...file("assets/logo.png", 0, 0), status: "added", binary: true },
  ],
  checks: [],
  checkpoint: { ordinal: 4, sha: "3f2a1c0d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49" },
  links: {
    session: "https://mend.test/sessions/s1",
    review: "https://mend.test/changes/c1",
    checkpoint: "https://mend.test/sessions/s1#checkpoint-4",
  },
  ...overrides,
});

/** Words the description must never use: it states what changed, not whether to merge it. */
const VERDICTS = [/ready/i, /\btested\b/i, /\bsafe\b/i, /approve/i, /\blgtm\b/i, /passed/i];

describe("describePullRequest", () => {
  it("writes the tour, the files with their counts and the links, between the markers", () => {
    const section = describePullRequest(input());
    expect(section.startsWith(DESCRIPTION_START)).toBe(true);
    expect(section.endsWith(DESCRIPTION_END)).toBe(true);
    expect(section).toContain("## Summary\n\nFixes the login redirect loop");
    expect(section).toContain("## Approach\n\nReads the expiry before redirecting");
    expect(section).toContain("3 files · +12 −3");
    expect(section).toContain("- `src/login.ts` · +12 −3");
    expect(section).toContain("- `src/old.ts` → `src/old-name.ts` · renamed · +0 −0");
    expect(section).toContain("- `assets/logo.png` · added · binary");
    expect(section).toContain("- Session: [session](https://mend.test/sessions/s1)");
    expect(section).toContain("- Review: [review](https://mend.test/changes/c1)");
    expect(section).toContain(
      "- Landed checkpoint: [checkpoint 4 · 3f2a1c0](https://mend.test/sessions/s1#checkpoint-4)",
    );
  });

  it("says it has no summary when there is no tour", () => {
    const section = describePullRequest(input({ tour: null }));
    expect(section).toContain("No summary · Mend has not composed a review tour for this change.");
    expect(section).not.toContain("## Summary");
    expect(section).toContain("## Changed files");
  });

  it("uses no verdict words, with or without a tour", () => {
    for (const section of [
      describePullRequest(input()),
      describePullRequest(input({ tour: null })),
    ]) {
      for (const verdict of VERDICTS) expect(section).not.toMatch(verdict);
    }
  });

  it("states checks only as the record shows them", () => {
    const section = describePullRequest(
      input({
        checks: [
          { command: "npm test", exitCode: 0 },
          { command: "tsc", exitCode: 2 },
        ],
      }),
    );
    expect(section).toContain("- `npm test` · exit 0 · observed");
    expect(section).toContain("- `tsc` · exit 2 · observed");
  });

  it("names the checkpoint without links when the install has no web origin", () => {
    const section = describePullRequest(
      input({ links: { session: null, review: null, checkpoint: null } }),
    );
    expect(section).toContain("- Session: session");
    expect(section).toContain("- Landed checkpoint: checkpoint 4 · 3f2a1c0");
    expect(section).not.toContain("](");
  });

  it("counts the files past the limit instead of listing them", () => {
    const many = Array.from({ length: DESCRIPTION_FILE_LIMIT + 5 }, (_, index) =>
      file(`src/file-${index}.ts`, 1, 0),
    );
    const section = describePullRequest(input({ files: many }));
    expect(section).toContain(`${DESCRIPTION_FILE_LIMIT + 5} files · +${many.length} −0`);
    expect(section).toContain("- and 5 more files");
    expect(section).not.toContain(`src/file-${DESCRIPTION_FILE_LIMIT}.ts`);
  });

  it("says so when the files could not be read, or none differ", () => {
    expect(describePullRequest(input({ files: null }))).toContain(
      "Not read · Mend could not list the files.",
    );
    expect(describePullRequest(input({ files: [] }))).toContain("No files differ from the base.");
  });

  it("keeps a backtick in a path inside its code span", () => {
    const section = describePullRequest(input({ files: [file("odd`name.ts", 1, 1)] }));
    expect(section).toContain("- ``odd`name.ts`` · +1 −1");
  });

  it("maps git's diff facts, keeping the old path only for renames and copies", () => {
    expect(
      describedFileOf({
        oldPath: "a.ts",
        newPath: "b.ts",
        status: "renamed",
        additions: 1,
        deletions: 2,
        binary: false,
      }),
    ).toEqual({
      path: "b.ts",
      oldPath: "a.ts",
      status: "renamed",
      additions: 1,
      deletions: 2,
      binary: false,
    });
    expect(
      describedFileOf({
        oldPath: "gone.ts",
        newPath: null,
        status: "deleted",
        additions: 0,
        deletions: 9,
        binary: false,
      }).path,
    ).toBe("gone.ts");
  });
});

describe("mergeDescription", () => {
  const section = describePullRequest(input());

  it("is Mend's section alone for a new pull request", () => {
    expect(mergeDescription(null, section)).toBe(section);
    expect(mergeDescription("  \n", section)).toBe(section);
  });

  it("replaces only the marked section and keeps what a person wrote around it", () => {
    const earlier = describePullRequest(input({ tour: null }));
    const body = `Closes #12. Please look at the cookie handling.\n\n${earlier}\n\n## Notes from Ada\nDeploy after Friday.`;
    const merged = mergeDescription(body, section);
    expect(merged).toBe(
      `Closes #12. Please look at the cookie handling.\n\n${section}\n\n## Notes from Ada\nDeploy after Friday.`,
    );
    expect(merged).not.toContain("No summary");
  });

  it("appends the section to a body with no markers, keeping the body", () => {
    const merged = mergeDescription("Opened by the agent.\n", section);
    expect(merged).toBe(`Opened by the agent.\n\n${section}`);
  });

  it("treats a start marker with no end as no markers", () => {
    const body = `Intro\n${DESCRIPTION_START}\nhalf a section`;
    expect(mergeDescription(body, section)).toBe(`${body}\n\n${section}`);
  });
});

describe("pullRequestTitle", () => {
  it("prefers the owner's title, then the session label, then the session id", () => {
    expect(pullRequestTitle({ explicit: "Fix login", label: "login loop", sessionId: "s1" })).toBe(
      "Fix login",
    );
    expect(pullRequestTitle({ explicit: "  ", label: "login loop", sessionId: "s1" })).toBe(
      "login loop",
    );
    expect(pullRequestTitle({ explicit: null, label: null, sessionId: "0123456789abcdef" })).toBe(
      "Mend session 01234567",
    );
  });
});

describe("landingCommitMessage", () => {
  it("is the tour summary with the Mend-Session trailer", () => {
    expect(
      landingCommitMessage({
        tourSummary: "Fix the login redirect\n\nThe cookie expiry was read after the redirect.",
        label: "login loop",
        sessionId: "s1",
        sessionUrl: "https://mend.test/sessions/s1",
      }),
    ).toBe(
      "Fix the login redirect\n\nThe cookie expiry was read after the redirect.\n\nMend-Session: https://mend.test/sessions/s1\n",
    );
  });

  it("cuts a long first line at a word and keeps the whole summary in the body", () => {
    const summary =
      "Fixes the login redirect loop that happens when the session cookie expires during a request";
    const message = landingCommitMessage({
      tourSummary: summary,
      label: null,
      sessionId: "s1",
      sessionUrl: null,
    });
    const [subject = "", , body] = message.split("\n");
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("…")).toBe(true);
    expect(body).toBe(summary);
    expect(message.endsWith("\n\nMend-Session: s1\n")).toBe(true);
  });

  it("falls back to the session label when there is no tour", () => {
    expect(
      landingCommitMessage({
        tourSummary: null,
        label: "login loop",
        sessionId: "s1",
        sessionUrl: "https://mend.test/sessions/s1",
      }),
    ).toBe("login loop\n\nMend-Session: https://mend.test/sessions/s1\n");
  });
});
