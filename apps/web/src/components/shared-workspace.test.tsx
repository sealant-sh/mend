import { AgentTurnId, SessionId } from "@mend/domain";
import {
  ConversationWait,
  REPLACE_WORKSPACE_ACTION,
  SHARED_CONTROL_CONFIRM,
} from "@mend/domain/workbench";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SharedControlConfirmBody,
  WaitingLineView,
  WorkspaceRetirementView,
} from "./shared-workspace.tsx";

const LINE = "Waits for Alice's 2 background tasks to finish before Bob's turn starts.";

const wait = new ConversationWait({
  sessionId: SessionId.make("session-1"),
  turnId: AgentTurnId.make("turn-1"),
  runsAs: "alice",
  sender: "bob",
  openTurn: false,
  work: [
    { kind: "task", id: "task-1", description: "pnpm test --watch", endable: true },
    { kind: "cron", id: "cron-1", description: null, endable: false },
  ],
  line: LINE,
  since: new Date("2026-10-08T10:00:00Z"),
});

const waiting = (canEnd: boolean, pending: string | null = null, error: string | null = null) =>
  renderToStaticMarkup(
    <WaitingLineView
      wait={wait}
      canEnd={canEnd}
      pending={pending}
      error={error}
      onEnd={() => undefined}
    />,
  );

describe("WaitingLineView", () => {
  it("shows the waiting line as the server wrote it, and what the viewer can end", () => {
    const markup = waiting(true);
    expect(markup).toContain(LINE.replaceAll("'", "&#x27;"));
    expect(markup).toContain("task · pnpm test --watch");
    expect(markup).not.toContain("cron-1");
    expect(markup).toContain(">End<");
  });

  it("offers no end to someone whose work it is not", () => {
    const markup = waiting(false);
    expect(markup).toContain(LINE.replaceAll("'", "&#x27;"));
    expect(markup).not.toContain(">End<");
  });

  it("says what is being ended, and a failure", () => {
    expect(waiting(true, "task-1")).toContain("Ending…");
    expect(waiting(true, null, "SessionNotSteerable: not yours")).toContain("not yours");
  });
});

const view = {
  line: "This workspace started before Mend 0.36 and shares one home · it takes only Alice's sessions and turns until it is replaced",
  stops: ["shell · bash", "mend.toml Services start again."],
  canReplace: true,
};

const retirement = (canReplace: boolean, refusal: string | null = null, pending = false) =>
  renderToStaticMarkup(
    <WorkspaceRetirementView
      view={{ ...view, stops: canReplace ? view.stops : [], canReplace }}
      pending={pending}
      refusal={refusal}
      onReplace={() => undefined}
    />,
  );

describe("WorkspaceRetirementView", () => {
  it("shows the line, what would stop and the action to the change's owner", () => {
    const markup = retirement(true);
    expect(markup).toContain("shares one home");
    expect(markup).toContain("shell · bash");
    expect(markup).toContain("mend.toml Services start again.");
    expect(markup).toContain(REPLACE_WORKSPACE_ACTION);
  });

  it("shows only the line to everyone else", () => {
    const markup = retirement(false);
    expect(markup).toContain("shares one home");
    expect(markup).not.toContain(REPLACE_WORKSPACE_ACTION);
    expect(markup).not.toContain("What would stop");
  });

  it("shows a refusal in the server's words, and the replacement in flight", () => {
    const words = "An agent's turn is in flight; it is never stopped.";
    expect(retirement(true, words)).toContain(words.replaceAll("'", "&#x27;"));
    expect(retirement(true, null, true)).toContain("Replacing…");
  });
});

describe("SharedControlConfirmBody", () => {
  it("asks with the domain's words", () => {
    const markup = renderToStaticMarkup(
      <SharedControlConfirmBody
        pending={false}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(markup).toContain(SHARED_CONTROL_CONFIRM.confirm);
    expect(markup).toContain(SHARED_CONTROL_CONFIRM.cancel);
  });
});
