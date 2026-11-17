// @vitest-environment jsdom
import { SessionId } from "@mend/domain";
import type { ExecutorCall } from "@mend/domain/workbench";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { byText, click, renderWithTrpc } from "../settings/sessions-test-trpc.tsx";
import { ExecutorCalls } from "./executor.tsx";

const viewer = vi.hoisted(() => ({ userId: "bob" }));
vi.mock("#/lib/viewer", () => ({ useViewer: () => viewer }));
const held: ExecutorCall = {
  id: "call-approval",
  sessionId: SessionId.make("session-approval"),
  service: "Linear",
  tool: "create_issue",
  asUserId: "bob",
  asMember: false,
  approverId: "bob",
  outcome: "held",
  message: "Executor is waiting for a person to answer in Mend.",
  observations: [],
  createdAt: new Date(),
  observedAt: new Date(),
  expiresAt: new Date(Date.now() + 900_000),
};
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});
describe("Executor approval in the session", () => {
  it("shows the arguments and sends the person's approval through Mend", async () => {
    viewer.userId = "bob";
    let current = held;
    const answers: Array<unknown> = [];
    root = await renderWithTrpc(
      <ExecutorCalls sessionId={held.sessionId} nameOf={(id) => id} />,
      (path, input) => {
        if (path === "executor.calls") return { data: { calls: [current], olderCursor: null } };
        if (path === "executor.approval")
          return {
            data: {
              call: current,
              message: "Create this issue?",
              inputSchema: { type: "object", properties: {} },
              arguments: { title: "Observed issue" },
            },
          };
        if (path === "executor.approve") {
          answers.push(input);
          current = { ...held, outcome: "completed", message: "Executor answered · observed" };
          return { data: current };
        }
        return { refuse: `Unexpected ${path}` };
      },
    );
    expect(document.body.textContent).toContain("Observed issue");
    await click(byText("button", "Approve"));
    expect(answers).toEqual([
      { sessionId: held.sessionId, callId: held.id, action: "accept", content: {} },
    ]);
    expect(document.body.textContent).toContain("Executor answered · observed");
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Approve"),
    ).toBe(false);
  });
  it("lets the session owner read a call that belongs to someone else without approval controls", async () => {
    viewer.userId = "alice";
    root = await renderWithTrpc(
      <ExecutorCalls sessionId={held.sessionId} nameOf={(id) => id} />,
      (path) =>
        path === "executor.calls"
          ? { data: { calls: [held], olderCursor: null } }
          : { refuse: `Unexpected ${path}` },
    );
    expect(document.body.textContent).toContain("Waiting for bob to answer in Mend.");
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Approve"),
    ).toBe(false);
  });
});
