import { AgentTurnId, SessionId } from "@mend/domain";
import {
  ConversationWait,
  REPLACE_WORKSPACE_ACTION,
  sharedControlConfirm,
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

const evidence = [
  "Checked at 12:05 UTC: Mend's records, the processes in the workspace and its running containers",
  "shell · bash",
  "process Mend did not start",
  "Mend starts the launching session's mend.toml Services again.",
];

const view = {
  line: "This workspace started before Mend 0.36 and shares one home · it takes only Alice's sessions and turns until it is replaced",
  stops: evidence,
  canReplace: true,
};

const retirement = (canReplace: boolean, refusal: string | null = null, pending = false) =>
  renderToStaticMarkup(
    <WorkspaceRetirementView
      view={{ ...view, canReplace }}
      pending={pending}
      refusal={refusal}
      onReplace={() => undefined}
    />,
  );

const escaped = (text: string) => text.replaceAll("'", "&#x27;");

describe("WorkspaceRetirementView", () => {
  it("shows the line, the evidence and the action to the change's owner", () => {
    const markup = retirement(true);
    expect(markup).toContain("shares one home");
    for (const line of evidence) expect(markup).toContain(escaped(line));
    expect(markup).toContain(REPLACE_WORKSPACE_ACTION);
  });

  it("shows everyone else the line and the evidence, without the action", () => {
    const markup = retirement(false);
    expect(markup).toContain("shares one home");
    expect(markup).toContain("What would stop");
    expect(markup).toContain("process Mend did not start");
    expect(markup).not.toContain(REPLACE_WORKSPACE_ACTION);
  });

  it("shows nothing but the line while it is being replaced", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceRetirementView
        view={{ line: "Replacing this workspace", stops: [], canReplace: false }}
        pending={false}
        refusal={null}
        onReplace={() => undefined}
      />,
    );
    expect(markup).not.toContain("What would stop");
  });

  it("shows a refusal in the server's words, and the replacement in flight", () => {
    const words =
      "What would stop has changed since you looked. Nothing was stopped; look at the list again and replace it from there.";
    expect(retirement(true, words)).toContain(escaped(words));
    expect(retirement(true, null, true)).toContain("Replacing…");
  });
});

describe("SharedControlConfirmBody", () => {
  it.each([true, false])("asks with the domain's words (turns on sender's login: %s)", (layout) => {
    const markup = renderToStaticMarkup(
      <SharedControlConfirmBody
        turnsOnSendersLogin={layout}
        pending={false}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(markup).toContain(sharedControlConfirm(layout).confirm);
    expect(markup).toContain(sharedControlConfirm(layout).cancel);
  });
});
