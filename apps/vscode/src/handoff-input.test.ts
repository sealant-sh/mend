import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import type { EventPointer } from "./client-data.js";
import type { HandoffClient } from "./handoff-client.js";
import { HandoffInput } from "./handoff-input.js";
import { Launches } from "./launches.js";
import { MendApiError } from "./mend-http.js";
import type { StoreChange } from "./session-store.js";
import { detail, fakeHandoff, project } from "./test-handoff.js";
import { fake, window as toasts, workspace } from "./test-vscode.js";

vi.mock("vscode", () => import("./test-vscode.js"));
vi.mock("./git.js", () => ({
  gitRunner: () => async () => ({ kind: "out", stdout: "/checkout" }),
}));
vi.mock("./handoff-worker.js", async () => {
  const fixtures = await import("./test-handoff.js");
  class HandoffWorker {
    async discover() {
      return { kind: "ok", value: fixtures.checkout };
    }
    async capture() {
      return { kind: "ok", value: fixtures.summary };
    }
    async pack() {
      return { kind: "ok", value: fixtures.bundle() };
    }
    async dispose() {}
  }
  return { HandoffWorker, sweepHandoffScratch: async () => undefined };
});

const READY = "Hand off fix/login to Mend · newsroom-api";
const NO_ANSWER = new MendApiError("Cannot reach Mend at http://mend.local.", null);

const world = (
  client: (base: HandoffClient, calls: Array<string>) => Partial<HandoffClient> = () => ({}),
) => {
  const f = fakeHandoff();
  const bound: HandoffClient = { ...f.client, ...client(f.client, f.calls) };
  const launches = new Launches(bound, { attempted: () => undefined, forget: () => undefined });
  const input = new HandoffInput(
    {
      extensionUri: vscode.Uri.file("/extension"),
      secrets: { onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event },
    },
    { bindHandoff: async () => bound },
    {
      onDidHearEvent: new vscode.EventEmitter<EventPointer>().event,
      onDidChange: new vscode.EventEmitter<StoreChange>().event,
      model: () => null,
      windowProject: () => null,
      recordHandoff: () => undefined,
    },
    launches,
    { kind: "local" },
  );
  const launched = () => f.calls.filter((call) => call === "launch").length;
  const question = async () => {
    let box = fake.inputBoxes().at(-1);
    await vi.waitFor(() => {
      void input.open(undefined);
      expect(fake.inputBoxes().at(-1)).not.toBe(box);
    });
    box = fake.lastInputBox();
    await vi.waitFor(() => expect(box.title).toBe(READY));
    return box;
  };
  const handOff = async (prompt: string, shown: typeof toasts.showInformationMessage) => {
    const box = await question();
    box.type(prompt);
    box.accept();
    await vi.waitFor(() => expect(shown).toHaveBeenCalled());
  };
  return { ...f, input, launches, launched, question, handOff };
};

beforeEach(() => {
  fake.reset();
  workspace.workspaceFolders = [{ uri: vscode.Uri.file("/checkout"), name: "checkout", index: 0 }];
});
afterEach(() => {
  vi.restoreAllMocks();
  workspace.workspaceFolders = undefined;
});

describe("her accepted prompt, dismissed and reopened", () => {
  it("is kept when she dismisses Check again on a workspace still starting", async () => {
    const start = Date.now();
    let waited = 0;
    vi.spyOn(Date, "now").mockImplementation(() => start + waited);
    const w = world((base) => ({
      sessionDetail: async (id) => {
        waited += 31_000;
        return base.sessionDetail(id);
      },
    }));
    w.read(detail("starting"));
    await w.handOff("survive a slow start", toasts.showWarningMessage);
    expect(toasts.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("your prompt has not been sent"),
      "Check again",
    );
    expect((await w.question()).value).toBe("survive a slow start");
    expect(w.launched()).toBe(0);
  });

  it("is kept when an agent already runs in the received session", async () => {
    const w = world();
    w.read(detail("running"));
    await w.handOff("survive a running receipt", toasts.showInformationMessage);
    expect((await w.question()).value).toBe("survive a running receipt");
    expect(w.launched()).toBe(0);
  });

  it("is kept when the received workspace failed", async () => {
    const w = world();
    w.read(detail("failed"));
    await w.handOff("survive a failed workspace", toasts.showInformationMessage);
    expect((await w.question()).value).toBe("survive a failed workspace");
    expect(w.launched()).toBe(0);
  });

  it("is kept when Mend never confirmed the handoff", async () => {
    const w = world();
    w.answers.push({ kind: "unconfirmed" }, { kind: "unconfirmed" }, { kind: "unconfirmed" });
    await w.handOff("survive a lost answer", toasts.showWarningMessage);
    expect((await w.question()).value).toBe("survive a lost answer");
    expect(w.launched()).toBe(0);
  });

  it("is kept when Mend refused the handoff", async () => {
    const w = world();
    w.answers.push({
      kind: "refused",
      issue: {
        kind: "refused",
        message: "Too many handoffs in progress",
        reason: null,
        budget: null,
        limit: null,
        retryAfterSeconds: null,
      },
    });
    await w.handOff("survive a refusal", toasts.showErrorMessage);
    expect((await w.question()).value).toBe("survive a refusal");
  });

  it("is gone once Mend confirmed its launch", async () => {
    const w = world();
    await w.handOff("run this", toasts.showInformationMessage);
    expect(w.launched()).toBe(1);
    expect((await w.question()).value).toBe("");
  });

  it("is gone when she clears it from the question", async () => {
    const w = world();
    w.read(detail("failed"));
    await w.handOff("let this go", toasts.showInformationMessage);
    const kept = await w.question();
    kept.type("");
    kept.hide();
    expect((await w.question()).value).toBe("");
  });
});

describe("a launch Mend never answered", () => {
  it("keeps her prompt, and Retry sends it to the held session", async () => {
    let answered = false;
    const w = world((base) => ({
      launchSession: async (id, request) => {
        if (!answered) {
          answered = true;
          await base.launchSession(id, request);
          throw NO_ANSWER;
        }
        return base.launchSession(id, request);
      },
    }));
    await w.handOff("send me once Mend answers", toasts.showInformationMessage);
    expect(w.launched()).toBe(1);
    const kept = await w.question();
    expect(kept.value).toBe("send me once Mend answers");
    kept.hide();
    expect((await w.launches.offer("s1")).kind).toBe("retry");
    expect(await w.launches.relaunch("s1", null)).toEqual({ kind: "sent" });
    expect(w.launched()).toBe(2);
    expect((await w.question()).value).toBe("");
  });
});

const sharing = (calls: Array<string>) => async () => {
  calls.push("share");
  return {
    snapshot: () => "connected" as const,
    subscribe: () => () => undefined,
    ready: async () => "connected" as const,
    close: async () => {
      calls.push("share-closed");
    },
  };
};

const handOffAnswered = async (w: ReturnType<typeof world>) => {
  const box = await w.question();
  box.type("carry on");
  box.accept();
  await vi.waitFor(() =>
    expect(
      toasts.showInformationMessage.mock.calls.length + toasts.showErrorMessage.mock.calls.length,
    ).toBeGreaterThan(0),
  );
};

describe("this machine's SSH agent, shared for the handoff's git", () => {
  const mendKeyProject = { ...project, gitAuthMode: "mend-key" as const };
  const bridgeProject = { ...project, gitAuthMode: "bridge" as const };

  it("is not needed for a Mend-key project, whatever her account default", async () => {
    const w = world(() => ({
      listProjects: async () => [mendKeyProject],
      accountGitAuthMode: async () => "bridge",
    }));
    await handOffAnswered(w);
    expect(toasts.showErrorMessage).not.toHaveBeenCalled();
    expect(w.calls).toContain("receive");
    expect(toasts.showInformationMessage).toHaveBeenCalled();
  });

  it("is shared before the receive for a bridge project, whatever her account default", async () => {
    const w = world((_, calls) => ({
      listProjects: async () => [bridgeProject],
      accountGitAuthMode: async () => "mend-key",
      shareAgent: sharing(calls),
    }));
    await handOffAnswered(w);
    expect(w.calls).toContain("share");
    expect(w.calls.indexOf("share")).toBeLessThan(w.calls.indexOf("receive"));
    expect(w.calls).toContain("share-closed");
    expect(toasts.showInformationMessage).toHaveBeenCalled();
  });

  it("is shared before adopting when her account default is bridge", async () => {
    const w = world((_, calls) => ({
      listProjects: async () => [],
      accountGitAuthMode: async () => "bridge",
      shareAgent: sharing(calls),
    }));
    await handOffAnswered(w);
    expect(w.calls).toContain("share");
    expect(w.calls.indexOf("share")).toBeLessThan(w.calls.indexOf("adopt"));
    expect(w.calls).toContain("receive");
  });
});
