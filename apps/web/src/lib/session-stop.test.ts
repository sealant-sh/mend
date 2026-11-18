import { describe, expect, it } from "vitest";

import {
  actorOf,
  resumeOf,
  type Sentence,
  type StopPreview,
  type StopSubject,
  stoppedLine,
  stoppedToast,
  stoppedWords,
  stopWords,
} from "./session-stop.ts";

const said = (sentence: Sentence | null): string | null =>
  sentence === null ? null : sentence.map((part) => part.text).join("");

const subject = (extra: Partial<StopSubject> = {}): StopSubject => ({
  agent: "Claude Code",
  status: "running",
  turnRunning: true,
  branch: "mend/refund-keys",
  fileCount: 1,
  ...extra,
});

const lastSession: StopPreview = {
  workspace: "stops",
  runningSessions: [],
  services: [{ name: "api", port: 8080 }],
};

const shared: StopPreview = {
  workspace: "keeps-running",
  runningSessions: [
    { sessionId: "s2", title: "Write tests for retry", ownerUserId: "ada", ownerName: "Ada" },
    { sessionId: "s3", title: "Lint the API", ownerUserId: "grace", ownerName: "Grace Hopper" },
  ],
  services: [{ name: "api", port: 8080 }],
};

describe("stopWords", () => {
  it("says the workspace and its Services stop with the last running session", () => {
    const words = stopWords(subject(), lastSession, "ada");
    expect(said(words.lead)).toBe(
      "Claude Code stops. No other session is running in this workspace, so Mend stops the workspace and its services too.",
    );
    expect(words.stops.map(said)).toEqual([
      "The current turn",
      "The workspace and its services: api :8080",
    ]);
    expect(words.kept.map(said)).toEqual([
      "The worktree mend/refund-keys and its 1 changed file",
      "This conversation",
    ]);
  });

  it("names the sessions that keep the workspace up, and their owner only when it isn't you", () => {
    const words = stopWords(subject(), shared, "ada");
    expect(said(words.lead)).toBe(
      "Claude Code stops. The workspace keeps running for Write tests for retry and Lint the API (Grace Hopper).",
    );
    // Nothing of the workspace stops: only the turn.
    expect(words.stops.map(said)).toEqual(["The current turn"]);
  });

  it("files the session under To review when it changed files, Done when it changed none", () => {
    expect(stopWords(subject({ fileCount: 3 }), lastSession, "ada").after).toMatch(
      /^The session moves to To review, because it changed 3 files\./,
    );
    expect(stopWords(subject({ fileCount: 0 }), lastSession, "ada").after).toMatch(
      /^The session moves to Done, because it changed no files\./,
    );
    // Until Mend has counted the files it doesn't say where the session goes.
    expect(stopWords(subject({ fileCount: null }), lastSession, "ada").after).toBe(
      "You can resume it later from the same worktree.",
    );
  });

  it("warns that a waiting agent's question goes with the stop, and only then", () => {
    expect(stopWords(subject({ status: "waiting" }), shared, "ada").waiting).toBe(
      "Claude Code is waiting for your answer. Stopping drops that question.",
    );
    expect(stopWords(subject({ status: "idle" }), shared, "ada").waiting).toBeNull();
  });

  it("says only that the agent stops until the preview is read", () => {
    const words = stopWords(subject(), null, "ada");
    expect(said(words.lead)).toBe("Claude Code stops.");
    expect(words.workspace).toBeNull();
  });
});

describe("stoppedWords", () => {
  it("names who keeps the workspace running after the stop", () => {
    expect(said(stoppedWords(shared, "Codex", "fix-retry", "grace"))).toBe(
      "Codex isn't running. The files and the change stay in fix-retry, which keeps running for Write tests for retry (Ada) and Lint the API.",
    );
  });

  it("says a resume starts a new workspace once nothing runs there", () => {
    expect(
      said(stoppedWords({ ...lastSession, workspace: "none" }, "Codex", "fix-retry", "ada")),
    ).toMatch(/Resuming starts a new workspace from the same worktree\.$/);
  });
});

const at = (hour: number, minute: number) => new Date(2026, 10, 18, hour, minute);
const names = (id: string) => (id === "grace" ? "Grace Hopper" : null);

describe("stoppedLine", () => {
  it("names the newest stop's author, and you as You", () => {
    const events = [
      { actorUserId: "ada", kind: "stop", createdAt: at(11, 17) },
      { actorUserId: "ada", kind: "interrupt", createdAt: at(11, 18) },
      { actorUserId: "grace", kind: "stop", createdAt: at(11, 20) },
    ];
    expect(stoppedLine(events, "ada", names, null)).toBe(
      "Grace Hopper stopped the session at 11:20.",
    );
    expect(stoppedLine(events.slice(0, 2), "ada", names, null)).toBe(
      "You stopped the session at 11:17.",
    );
  });

  it("says Mend stopped an idle session", () => {
    expect(
      stoppedLine([{ actorUserId: "ada", kind: "idle-stop", createdAt: at(9, 5) }], "ada", names, {
        ...lastSession,
        workspace: "none",
      }),
    ).toBe("Mend stopped the session at 09:05, after it sat idle. The workspace has stopped.");
  });

  it("says nothing when no stop is recorded", () => {
    expect(
      stoppedLine(
        [{ actorUserId: "ada", kind: "interrupt", createdAt: at(9, 5) }],
        "ada",
        names,
        null,
      ),
    ).toBeNull();
  });
});

describe("stoppedToast", () => {
  it("says where the session went and who keeps the workspace running", () => {
    expect(stoppedToast("Fix flaky checkout retry", 2, shared)).toBe(
      'Stopped "Fix flaky checkout retry" and moved it to To review. "Write tests for retry", "Lint the API" are still running.',
    );
    expect(stoppedToast("Fix", 0, lastSession)).toBe('Stopped "Fix" and moved it to Done.');
  });
});

describe("actorOf and resumeOf", () => {
  it("names an agent, a command and a shell, and resumes a command as a shell", () => {
    expect(actorOf("claude")).toBe("Claude Code");
    expect(actorOf("run")).toBe("The command");
    expect(resumeOf("codex")).toEqual({ harness: null, label: "Resume session" });
    expect(resumeOf("shell")).toEqual({ harness: null, label: "Resume session" });
    expect(resumeOf("run")).toEqual({ harness: "shell", label: "Resume as a shell" });
  });
});
