import { SHARED_CONTROL_LINE, SHARED_CONTROL_LINE_OWNER_LOGINS } from "@mend/domain/workbench";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { replaceWorkspace, refusalWords, type WorkspaceRetirementDto } from "#/lib/api";
import { refreshConversation } from "#/lib/conversation";
import { bridgeFixture } from "#/lib/fixtures";
import { queryClient } from "#/lib/queries";
import {
  retirementViewOf,
  sessionWaitingQuery,
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
    expect(view?.stops).toEqual(["shell · auth · shell 1", "mend.toml Services start again."]);
    expect(view?.canReplace).toBe(true);
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

  it("re-reads the waiting line with the conversation, and the retirement with the session", async () => {
    const waiting = sessionWaitingQuery("session-1", true).queryKey;
    const retiring = workspaceRetirementQuery("session-1").queryKey;
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
    const refused = await replaceWorkspace("session-1").then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusalWords(refused, "not replaced")).toBe(message);
  });
});

describe("the Shared control switch", () => {
  it("says a steered turn runs on its sender's login where the session view says so", () => {
    expect(sharedControlSwitchTitle(true)).toContain(SHARED_CONTROL_LINE);
    expect(sharedControlSwitchTitle(true)).not.toContain(SHARED_CONTROL_LINE_OWNER_LOGINS);
  });

  it("says it spends the owner's logins otherwise", () => {
    expect(sharedControlSwitchTitle(false)).toContain(SHARED_CONTROL_LINE_OWNER_LOGINS);
    expect(sharedControlSwitchTitle(false)).not.toContain(SHARED_CONTROL_LINE);
  });
});
