import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { gateDeviceCalls, type DeviceCalls } from "../src/device-gate.ts";
import { makePersonHub } from "../src/hub.ts";
import { MendDeviceRefused } from "../src/mend-client.ts";
import { unreachableMend } from "./support/stubs.ts";

/**
 * Review round 2, structural change B: one gate for every Mend call made with a device token.
 * A 401 on any of them refuses the token that made it.
 */

const refused = (operation: string) => Effect.fail(new MendDeviceRefused({ operation }));

/** A Mend whose every token-carrying call answers 401. */
const revokedMend: DeviceCalls = {
  checkDevice: () => Effect.succeed("refused"),
  listHarnessModels: () => refused("models"),
  listProjects: () => refused("projects"),
  projectDetail: () => refused("project"),
  listTurns: () => refused("turns"),
  listItems: () => refused("items"),
  listRequests: () => refused("requests"),
  sessionDetail: () => refused("session"),
  listActiveSessions: () => refused("sessions"),
  conversationWait: () => refused("waiting"),
  workspaceRetirement: () => refused("retirement"),
  changeDiff: () => refused("diff"),
  worktreeNames: () => refused("worktrees"),
  projectFiles: () => refused("files"),
  changeStats: () => refused("stats"),
  createSession: () => refused("create"),
  joinWorktree: () => refused("join"),
  labelSession: () => refused("label"),
  stopSession: () => refused("stop"),
  removeSession: () => refused("remove"),
  pasteImage: () => refused("paste"),
  submitTurn: () => refused("submit"),
  launchProtocol: () => refused("launch"),
  interruptTurn: () => refused("interrupt"),
  respondRequest: () => refused("respond"),
  events: () => Stream.fail(new MendDeviceRefused({ operation: "events" })),
};

// Compile-time: handing a hub Mend's raw client does not typecheck.
const buildWithRawClient = () =>
  makePersonHub({
    // @ts-expect-error the hub takes only a gated client
    mend: unreachableMend,
    tokens: {
      current: () => null,
      live: () => [],
      refuse: () => Effect.void,
      isRefused: () => false,
      refusal: () => Effect.never,
      noneLeft: Effect.never,
    },
  });

describe("the device gate", () => {
  it.effect("refuses the token on a 401 from every call it carries", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const gated = gateDeviceCalls({ ...unreachableMend, ...revokedMend }, (token) =>
        Effect.sync(() => {
          seen.push(token);
        }),
      );
      // Every call of Mend's client that carries a token, by name: a new one must be gated too.
      const calls: Record<keyof DeviceCalls, Effect.Effect<unknown, unknown>> = {
        checkDevice: gated.checkDevice("t-checkDevice"),
        listHarnessModels: gated.listHarnessModels("t-listHarnessModels"),
        listProjects: gated.listProjects("t-listProjects"),
        projectDetail: gated.projectDetail("t-projectDetail", "p"),
        listTurns: gated.listTurns("t-listTurns", "s"),
        listItems: gated.listItems("t-listItems", "s", 0, 500),
        listRequests: gated.listRequests("t-listRequests", "s"),
        sessionDetail: gated.sessionDetail("t-sessionDetail", "s"),
        listActiveSessions: gated.listActiveSessions("t-listActiveSessions"),
        conversationWait: gated.conversationWait("t-conversationWait", "s"),
        workspaceRetirement: gated.workspaceRetirement("t-workspaceRetirement", "s"),
        changeDiff: gated.changeDiff("t-changeDiff", "c"),
        worktreeNames: gated.worktreeNames("t-worktreeNames", "p"),
        projectFiles: gated.projectFiles("t-projectFiles", "p", null),
        changeStats: gated.changeStats("t-changeStats", "c"),
        createSession: gated.createSession("t-createSession", "p", {
          harness: "codex",
          label: null,
          name: null,
          base: null,
        }),
        joinWorktree: gated.joinWorktree("t-joinWorktree", "w", { harness: "codex", label: null }),
        labelSession: gated.labelSession("t-labelSession", "s", "name"),
        stopSession: gated.stopSession("t-stopSession", "s"),
        removeSession: gated.removeSession("t-removeSession", "s"),
        pasteImage: gated.pasteImage("t-pasteImage", "s", new Uint8Array([1])),
        submitTurn: gated.submitTurn("t-submitTurn", "s", "hi"),
        launchProtocol: gated.launchProtocol("t-launchProtocol", "s", ""),
        interruptTurn: gated.interruptTurn("t-interruptTurn", "turn"),
        respondRequest: gated.respondRequest("t-respondRequest", "r", { decision: "accept" }),
        events: Stream.runDrain(gated.events("t-events")),
      };
      for (const call of Object.values(calls)) yield* Effect.exit(call);
      assert.deepStrictEqual(
        seen.toSorted(),
        Object.keys(calls)
          .map((name) => `t-${name}`)
          .toSorted(),
      );
      assert.isTrue(gated.gated);
    }),
  );

  it("is the only Mend client a hub accepts", () => {
    assert.isFunction(buildWithRawClient);
  });
});
