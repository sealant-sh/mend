import { describe, expect, it } from "vitest";

import { failureLogLine, failureWords, GENERIC_FAILURE, NO_ANSWER } from "./failure-words.js";

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

  it("keeps the call, the status and the tag for the log", () => {
    expect(
      failureLogLine("POST /api/me/sealant/accounts", 502, {
        _tag: "SealantUnavailable",
        message: "GitHub rejected this token.",
      }),
    ).toBe(
      "POST /api/me/sealant/accounts responded 502 · SealantUnavailable · GitHub rejected this token.",
    );
    expect(failureLogLine("GET /api/projects", 0, "fetch failed")).toBe(
      "GET /api/projects responded nothing · fetch failed",
    );
  });
});
