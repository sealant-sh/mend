import { describe, expect, it } from "vitest";

import { failureWords, GENERIC_FAILURE, NO_ANSWER, noteRefusal } from "./failure-words.ts";

describe("failureWords", () => {
  it("shows the server's own sentence, and keeps the tag for code that branches", () => {
    const failure = failureWords(502, {
      _tag: "SealantUnavailable",
      code: "rejected",
      message: "GitHub rejected this token. Paste a fine-grained token with repo access.",
    });
    expect(failure).toEqual({
      words: "GitHub rejected this token. Paste a fine-grained token with repo access.",
      tag: "SealantUnavailable",
      serverWords: "GitHub rejected this token. Paste a fine-grained token with repo access.",
    });
  });

  it("words a tag-only body, never naming the tag", () => {
    const failure = failureWords(409, { _tag: "ProtocolSessionNotLive", processId: "p-1" });
    expect(failure.words).toBe("The agent is not running — resume the session, then retry.");
    expect(failure.words).not.toContain("ProtocolSessionNotLive");
    expect(failure.serverWords).toBeNull();
    expect(failure.tag).toBe("ProtocolSessionNotLive");
  });

  it("words an unknown tag generically, never naming it", () => {
    const failure = failureWords(500, { _tag: "SomethingInternal" });
    expect(failure.words).toBe(GENERIC_FAILURE);
    expect(failure.words).not.toContain("SomethingInternal");
  });

  it("words a bare status, never naming the status or the route", () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 504]) {
      const { words } = failureWords(status, null);
      expect(words).not.toContain(String(status));
      expect(words).not.toMatch(/\/api|POST|GET|responded/);
    }
    expect(failureWords(404, "<html>Not Found</html>").words).toBe(
      "Not found — it may have been removed.",
    );
    expect(failureWords(502, "Bad Gateway").words).toBe(GENERIC_FAILURE);
    expect(failureWords(0, "fetch failed").words).toBe(NO_ANSWER);
  });
});

describe("a refusal's diagnostics (MEND_DEBUG)", () => {
  const failure = failureWords(502, {
    _tag: "SealantUnavailable",
    message: "GitHub rejected this token. Paste a new one.",
  });

  it("are written beside the words only when MEND_DEBUG asks, with the call, status and tag", () => {
    const lines: Array<string> = [];
    noteRefusal("POST /api/me/sealant/accounts", 502, failure, { MEND_DEBUG: "1" }, (line) =>
      lines.push(line),
    );
    expect(lines).toEqual([
      "mend: debug · POST /api/me/sealant/accounts → 502 · SealantUnavailable",
    ]);
    expect(failure.words).toBe("GitHub rejected this token. Paste a new one.");
  });

  it("stay off stderr otherwise", () => {
    const lines: Array<string> = [];
    noteRefusal("GET /api/projects", 502, failure, {}, (line) => lines.push(line));
    expect(lines).toEqual([]);
  });
});
