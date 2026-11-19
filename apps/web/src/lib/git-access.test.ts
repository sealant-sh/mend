import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";

import {
  continueNote,
  gitAccessContinues,
  gitAccessWorks,
  type KeyCheckState,
  keyCheckView,
  requestFailure,
  waitedFor,
  whenSince,
} from "./git-access.ts";

const checkedAt = new Date("2026-11-18T10:00:00.000Z");

const answered = (
  answer: Extract<KeyCheckState, { kind: "answered" }>["answer"],
): KeyCheckState => ({
  kind: "answered",
  answer,
});

const accepted = answered({
  state: "accepted",
  githubLogin: "linus-p",
  deployKeyRepository: null,
  observed:
    "Hi linus-p! You've successfully authenticated, but GitHub does not provide shell access.",
  checkedAt,
});
const refused = answered({
  state: "refused",
  observed: "git@github.com: Permission denied (publickey).",
  checkedAt,
});
const unreachable = answered({
  state: "unreachable",
  observed: "ssh: Could not resolve hostname github.com: Temporary failure in name resolution",
  checkedAt,
});
const noKey = answered({ state: "no-key", checkedAt });

const mendKey = {
  mode: "mend-key",
  bridge: { connected: false, clientName: null, since: null },
} as const;
const waiting = {
  mode: "bridge",
  bridge: { connected: false, clientName: null, since: null },
} as const;
const connected = {
  mode: "bridge",
  bridge: { connected: true, clientName: "linus-mbp", since: checkedAt },
} as const;

describe("what the key check shows", () => {
  it("names the GitHub account that accepted the key, and when", () => {
    expect(keyCheckView(accepted)).toEqual({
      kind: "works",
      line: "Mend reached GitHub as linus-p.",
      checkedAt,
    });
  });

  it("names the repository a deploy key is for, which has no account", () => {
    expect(
      keyCheckView(
        answered({
          state: "accepted",
          githubLogin: null,
          deployKeyRepository: "northwind/checkout-api",
          observed:
            "Hi northwind/checkout-api! You've successfully authenticated, but GitHub does not provide shell access.",
          checkedAt,
        }),
      ),
    ).toMatchObject({
      kind: "works",
      line: "Mend reached GitHub with the deploy key for northwind/checkout-api.",
    });
  });

  it("quotes GitHub's refusal and offers to check again", () => {
    expect(keyCheckView(refused)).toMatchObject({
      kind: "problem",
      tone: "error",
      title: "GitHub refused the key.",
      observed: { by: "GitHub", text: "git@github.com: Permission denied (publickey)." },
      action: { kind: "check", label: "Check again" },
    });
  });

  it("tells an unreachable GitHub apart from a refusal: a warning that says nothing of the key", () => {
    const view = keyCheckView(unreachable);
    expect(view).toMatchObject({
      kind: "problem",
      tone: "warning",
      title: "Mend couldn't reach GitHub.",
      observed: { by: "ssh" },
      action: { kind: "check", label: "Try again" },
    });
    expect(view.kind === "problem" && view.advice).toContain("says nothing about your key");
  });

  it("offers to make the key when there is none", () => {
    expect(keyCheckView(noKey)).toMatchObject({
      kind: "problem",
      observed: null,
      action: { kind: "create-key" },
    });
  });

  it("keeps a request that failed apart from any answer about the key", () => {
    const view = keyCheckView({ kind: "failed", message: "Mend's server didn't answer." });
    expect(view).toMatchObject({
      kind: "problem",
      title: "Mend couldn't check the key.",
      observed: null,
      action: { kind: "check", label: "Try again" },
    });
    expect(view.kind === "problem" && view.advice).toMatch(/^Mend's server didn't answer\./);
  });
});

describe("when Continue opens", () => {
  it("waits for GitHub to accept the Mend key, and nothing less", () => {
    for (const state of [
      { kind: "idle" } as const,
      { kind: "checking", since: checkedAt } as const,
      refused,
      unreachable,
      noKey,
      { kind: "failed", message: "No answer." } as const,
    ]) {
      expect(gitAccessWorks(mendKey, state)).toBe(false);
      expect(continueNote(mendKey, state)).toBe("Continue once GitHub accepts the key.");
    }
    expect(gitAccessWorks(mendKey, accepted)).toBe(true);
    expect(continueNote(mendKey, accepted)).toBe("Mend saves your choice as soon as you pick it.");
  });

  it("with your computer's key, waits for the computer and ignores any key check", () => {
    expect(gitAccessWorks(waiting, accepted)).toBe(false);
    expect(continueNote(waiting, accepted)).toBe("Continue once your computer connects.");
    expect(gitAccessWorks(connected, { kind: "idle" })).toBe(true);
    expect(continueNote(connected, { kind: "idle" })).toBe(
      "Mend can't clone or push while linus-mbp is offline.",
    );
  });
});

describe("when Continue opens on a visit back to Git access", () => {
  const madeKey = {
    ...mendKey,
    key: { exists: true, publicKey: "ssh-ed25519 AAAA mend:linus", fingerprint: "SHA256:abc" },
  } as const;

  it("lets someone who went past the step go on with the Mend key they have", () => {
    expect(gitAccessContinues(madeKey, { kind: "idle" }, true)).toBe(true);
    // The first time through, the same page waits for GitHub's answer.
    expect(gitAccessContinues(madeKey, { kind: "idle" }, false)).toBe(false);
  });

  it("waits again once they check the key on this visit and GitHub doesn't take it", () => {
    expect(gitAccessContinues(madeKey, refused, true)).toBe(false);
    expect(gitAccessContinues(madeKey, { kind: "checking", since: checkedAt }, true)).toBe(false);
    expect(gitAccessContinues(madeKey, accepted, true)).toBe(true);
  });

  it("waits for a computer that isn't connected, after a switch to the computer's key", () => {
    expect(gitAccessContinues({ ...waiting, key: madeKey.key }, { kind: "idle" }, true)).toBe(
      false,
    );
  });
});

describe("times beside a line", () => {
  it("counts the wait in seconds, then minutes", () => {
    const since = new Date("2026-11-18T10:00:00.000Z");
    expect(waitedFor(since, new Date("2026-11-18T10:00:03.900Z"))).toBe("3s");
    expect(waitedFor(since, new Date("2026-11-18T10:01:05.000Z"))).toBe("1m 05s");
    // A clock a moment behind the server's never shows a negative wait.
    expect(waitedFor(since, new Date("2026-11-18T09:59:58.000Z"))).toBe("0s");
  });

  it("says how long ago", () => {
    const at = new Date("2026-11-18T10:00:00.000Z");
    expect(whenSince(at, new Date("2026-11-18T10:00:02.000Z"))).toBe("just now");
    expect(whenSince(at, new Date("2026-11-18T10:00:12.000Z"))).toBe("12s ago");
    expect(whenSince(at, new Date("2026-11-18T10:04:00.000Z"))).toBe("4m ago");
    expect(whenSince(at, new Date("2026-11-18T12:00:00.000Z"))).toBe("2h ago");
  });
});

describe("a request that failed", () => {
  it("shows the server's sentence when it answered, and says so when it didn't", () => {
    const fromServer = new TRPCClientError("Could not create the Mend key: disk full", {
      result: {
        error: {
          code: -32603,
          message: "Could not create the Mend key: disk full",
          data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
        },
      },
    });
    expect(requestFailure(fromServer)).toBe("Could not create the Mend key: disk full");
    expect(requestFailure(new TRPCClientError("Failed to fetch"))).toBe(
      "Mend's server didn't answer.",
    );
    expect(requestFailure(new TypeError("Failed to fetch"))).toBe("Mend's server didn't answer.");
  });
});
