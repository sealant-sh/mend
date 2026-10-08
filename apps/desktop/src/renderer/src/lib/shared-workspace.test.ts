import {
  SHARED_CONTROL_LINE,
  SHARED_CONTROL_LINE_OWNER_LOGINS,
  sharedControlConfirm,
} from "@mend/domain/workbench";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { replaceWorkspace, refusalWords, type WorkspaceRetirementDto } from "#/lib/api";
import { refreshConversation } from "#/lib/conversation";
import { bridgeFixture, sessionFixture } from "#/lib/fixtures";
import { queryClient } from "#/lib/queries";
import {
  keyedLines,
  readsRetirement,
  readsWaiting,
  retirementViewOf,
  sessionWaitingQuery,
  sharedControlPress,
  sharedControlSwitchTitle,
  sharedWorkspaceLineOf,
  workspaceRetirementQuery,
} from "#/lib/shared-workspace";

const anna = { accountId: "anna", name: "Anna" } as const;
const bob = { accountId: "bob", name: "Bob" } as const;

const retirement = (patch: Partial<WorkspaceRetirementDto> = {}): WorkspaceRetirementDto => ({
  state: "marked",
  preRelease: true,
  launcher: "anna",
  stops: [{ kind: "shell", label: "auth · shell 1" }],
  reason: null,
  checkedAt: "2026-10-08T12:05:41.000Z",
  fingerprint: "fp-1",
  canReplace: true,
  ...patch,
});

describe("the shared-workspace line (docs/adr/0016, decision 13)", () => {
  it("names the other person live in the executor, for whoever reads it", () => {
    expect(sharedWorkspaceLineOf([anna, bob], "bob")).toBe(
      "Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.",
    );
  });

  it("says nothing with one person live, or from a list row and an older server", () => {
    expect(sharedWorkspaceLineOf([anna], "anna")).toBeNull();
    expect(sharedWorkspaceLineOf(undefined, "anna")).toBeNull();
  });
});

describe("the retirement line (docs/adr/0016, decision 14)", () => {
  const names = new Map([["anna", "Anna"]]);

  it("says whose sessions the workspace takes, and what would stop for the change's owner", () => {
    const view = retirementViewOf(retirement(), names);
    expect(view?.line).toBe(
      "This workspace started before Mend 0.36 and shares one home · it takes only Anna's sessions and turns until it is replaced",
    );
    expect(view?.stops).toEqual([
      "Checked at 12:05 UTC: Mend's records, the processes in the workspace and its running containers",
      "shell · auth · shell 1",
      "Mend starts the launching session's mend.toml Services again.",
    ]);
    expect(view?.canReplace).toBe(true);
    // The replacement sends the fingerprint of the read these lines came from.
    expect(view?.seen).toBe("fp-1");
  });

  it("says when only Mend's records were read, and a kind alone where the label is not the viewer's", () => {
    const view = retirementViewOf(
      retirement({
        checkedAt: null,
        stops: [
          { kind: "process", label: "" },
          { kind: "unchecked", label: "" },
        ],
      }),
      names,
    );
    expect(view?.stops).toEqual([
      "Checked: Mend's records only · processes Mend did not start and running containers not checked yet",
      "process Mend did not start",
      "could not check",
      "Mend starts the launching session's mend.toml Services again.",
    ]);
  });

  it("lists nothing to stop for someone who cannot replace it", () => {
    const view = retirementViewOf(retirement({ canReplace: false }), names);
    expect(view?.stops).toEqual([]);
    expect(view?.canReplace).toBe(false);
  });

  it("names a launcher the roster does not know, and nothing when no retirement is under way", () => {
    expect(retirementViewOf(retirement({ launcher: "carol" }), names)?.line).toContain(
      "it takes only its launcher's sessions",
    );
    expect(retirementViewOf(null, names)).toBeNull();
    expect(retirementViewOf(undefined, names)).toBeNull();
  });
});

describe("the reads behind the lines", () => {
  afterEach(() => {
    queryClient.clear();
  });

  it("reads the waiting line only while someone is live in the executor and control is shared", () => {
    const shared = "2026-10-08T12:00:00.000Z";
    expect(
      readsWaiting(sessionFixture({ livePeople: [anna], sharedControlEnabledAt: shared })),
    ).toBe(true);
    expect(readsWaiting(sessionFixture({ livePeople: [], sharedControlEnabledAt: shared }))).toBe(
      false,
    );
    expect(readsWaiting(sessionFixture({ livePeople: [anna], sharedControlEnabledAt: null }))).toBe(
      false,
    );
    expect(readsWaiting(undefined)).toBe(false);
  });

  it("reads the retirement only while the session's view says its executor waits to be replaced", () => {
    expect(readsRetirement(sessionFixture({ workspaceRetirement: "marked" }))).toBe(true);
    expect(readsRetirement(sessionFixture({ workspaceRetirement: "retiring" }))).toBe(true);
    expect(readsRetirement(sessionFixture())).toBe(false);
    expect(readsRetirement(undefined)).toBe(false);
  });

  it("keeps no timer: the stream's pointers re-read both, and only while they are read", () => {
    const waiting = sessionWaitingQuery("session-1", false);
    const retiring = workspaceRetirementQuery("session-1", false);
    expect(waiting.enabled).toBe(false);
    expect(retiring.enabled).toBe(false);
    expect(sessionWaitingQuery("session-1", true).refetchInterval).toBeUndefined();
    expect(workspaceRetirementQuery("session-1", true).refetchInterval).toBeUndefined();
  });

  it("re-reads the waiting line with the conversation, and the retirement with the session", async () => {
    const waiting = sessionWaitingQuery("session-1", true).queryKey;
    const retiring = workspaceRetirementQuery("session-1", true).queryKey;
    queryClient.setQueryData(waiting, null);
    queryClient.setQueryData(retiring, null);

    refreshConversation("session-1");
    await Promise.resolve();

    expect(queryClient.getQueryState(waiting)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(retiring)?.isInvalidated).toBe(false);
    expect(retiring.slice(0, 2)).toEqual(["session", "session-1"]);
  });
});

describe("Replace this workspace now", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "mend");
  });

  it("shows the server's refusal as it is", async () => {
    const message = "An agent's turn is in flight; Mend never stops it.";
    Object.defineProperty(window, "mend", {
      configurable: true,
      value: bridgeFixture(async () => ({
        status: 409,
        ok: false,
        body: { _tag: "WorkspaceReplaceRefused", sessionId: "session-1", message },
      })),
    });
    const refused = await replaceWorkspace("session-1", "fp-1").then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusalWords(refused, "not replaced")).toBe(message);
  });
});

describe("Replace this workspace now sends what the owner was shown", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "mend");
  });

  it("posts the fingerprint of the retirement it listed", async () => {
    const sent: Array<unknown> = [];
    Object.defineProperty(window, "mend", {
      configurable: true,
      value: bridgeFixture(async (request) => {
        sent.push(request);
        return { status: 204, ok: true, body: null };
      }),
    });
    const view = retirementViewOf(retirement({ fingerprint: "fp-shown" }), new Map());
    await replaceWorkspace("session-1", view?.seen ?? "");
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/api/sessions/session-1/workspace-retirement/replace",
        body: { seen: "fp-shown" },
      },
    ]);
  });
});

describe("the Shared control switch", () => {
  it("asks before turning on, in both layouts, and never before turning off", () => {
    expect(sharedControlPress(false, true)).toBe("ask");
    expect(sharedControlPress(true, false)).toBe("set");
    expect(sharedControlPress(true, true)).toBe("nothing");
    expect(sharedControlPress(false, false)).toBe("nothing");
    // The dialog's words, true to each layout.
    expect(sharedControlConfirm(true).body).toBe(SHARED_CONTROL_LINE);
    expect(sharedControlConfirm(false).body).toContain(SHARED_CONTROL_LINE_OWNER_LOGINS);
  });

  it("says a steered turn runs on its sender's login where the session view says so", () => {
    expect(sharedControlSwitchTitle(true)).toContain(SHARED_CONTROL_LINE);
    expect(sharedControlSwitchTitle(true)).not.toContain(SHARED_CONTROL_LINE_OWNER_LOGINS);
  });

  it("says it spends the owner's logins otherwise", () => {
    expect(sharedControlSwitchTitle(false)).toContain(SHARED_CONTROL_LINE_OWNER_LOGINS);
    expect(sharedControlSwitchTitle(false)).not.toContain(SHARED_CONTROL_LINE);
  });
});

describe("the stop lines' keys", () => {
  it("stay unique when two lines read alike", () => {
    expect(
      keyedLines(["could not check", "could not check", "shell"]).map((row) => row.key),
    ).toEqual(["could not check#1", "could not check#2", "shell#1"]);
  });
});
