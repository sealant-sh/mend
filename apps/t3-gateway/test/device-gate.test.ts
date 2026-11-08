import { SessionId, CheckpointId } from "@mend/domain";
import { ProofArtifactId } from "@mend/domain";
import { TurnBoundaryId } from "@mend/domain/workbench";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { gateDeviceCalls, type DeviceCalls } from "../src/device-gate.ts";
import { makePersonHub } from "../src/hub.ts";
import { MendDeviceRefused } from "../src/mend-client.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { unreachableMend } from "./support/stubs.ts";

/**
 * Review round 2, structural change B: one gate for every Mend call made with a device token.
 * A 401 on any of them refuses the token that made it.
 */

const refused = (operation: string) => Effect.fail(new MendDeviceRefused({ operation }));

/** A Mend whose every token-carrying call answers 401. */
const revokedMend: DeviceCalls = {
  adoptProject: () => refused("adoptProject"),
  renameProject: () => refused("renameProject"),
  lookupRepository: () => refused("lookupRepository"),
  createProject: () => refused("createProject"),
  ensureScratchProject: () => refused("ensureScratchProject"),
  checkDevice: () => Effect.succeed("refused"),
  connectedAccounts: () => refused("accounts"),
  listHarnessModels: () => refused("models"),
  listProjects: () => refused("projects"),
  projectDetail: () => refused("project"),
  nativeHistory: () => refused("history"),
  mergeBack: () => refused("mergeBack"),
  rollbackSession: () => refused("rollback"),
  forkSession: () => refused("fork"),
  listTurns: () => refused("turns"),
  listItems: () => refused("items"),
  listRequests: () => refused("requests"),
  sessionDetail: () => refused("session"),
  listActiveSessions: () => refused("sessions"),
  endBackgroundWork: () => refused("endBackgroundWork"),
  conversationWait: () => refused("waiting"),
  workspaceRetirement: () => refused("retirement"),
  changeDiff: () => refused("diff"),
  projectBranches: () => refused("branches"),
  refreshProject: () => refused("refresh"),
  listWorktrees: () => refused("worktrees"),
  removeWorktree: () => refused("remove worktree"),
  removeProject: () => refused("remove project"),
  projectContents: () => refused("projectContents"),
  openProjectRawFile: () => refused("openProjectRawFile"),
  projectFiles: () => refused("files"),
  listSkills: () => refused("skills"),
  projectSkills: () => refused("project skills"),
  changeStats: () => refused("stats"),
  changeLandings: () => refused("landings"),
  land: () => refused("land"),
  refreshLanding: () => refused("refresh"),
  worktreeCheckpoints: () => refused("checkpoints"),
  worktreeDiff: () => refused("range"),
  worktreeContents: () => refused("contents"),
  writeWorktreeFile: () => refused("write contents"),
  openRawFile: () => refused("raw"),
  openProofMedia: () => refused("proof media"),
  pageFrame: () => refused("page frame"),
  openPage: () => refused("page document"),
  createSession: () => refused("create"),
  joinWorktree: () => refused("join"),
  findLocalWorktree: () => refused("findLocal"),
  startLocalWorktree: () => refused("startLocal"),
  createWorktree: () => refused("createWorktree"),
  labelSession: () => refused("label"),
  stopSession: () => refused("stop"),
  removeSession: () => refused("remove"),
  pasteImage: () => refused("paste"),
  openShell: () => refused("shell"),
  stopShell: () => refused("stopShell"),
  ttyTicket: () => refused("ticket"),
  submitTurn: () => refused("submit"),
  launchProtocol: () => refused("launch"),
  steerTurn: () => refused("steer"),
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
        adoptProject: gated.adoptProject("t-adoptProject", "repo", "https://github.com/alice/repo"),
        renameProject: gated.renameProject("t-renameProject", "p", "name"),
        lookupRepository: gated.lookupRepository("t-lookupRepository", "alice/repo"),
        writeWorktreeFile: gated.writeWorktreeFile("t-writeWorktreeFile", "wt-1", {
          path: "plan.md",
          contents: "plan",
        }),
        createProject: gated.createProject("t-createProject", "notes"),
        ensureScratchProject: gated.ensureScratchProject("t-ensureScratchProject"),
        checkDevice: gated.checkDevice("t-checkDevice"),
        connectedAccounts: gated.connectedAccounts("t-connectedAccounts"),
        listHarnessModels: gated.listHarnessModels("t-listHarnessModels"),
        listProjects: gated.listProjects("t-listProjects"),
        projectDetail: gated.projectDetail("t-projectDetail", "p"),
        findLocalWorktree: gated.findLocalWorktree("t-findLocalWorktree", "p"),
        startLocalWorktree: gated.startLocalWorktree("t-startLocalWorktree", "p"),
        createWorktree: gated.createWorktree("t-createWorktree", "p", {
          name: null,
          base: null,
          targetBranch: { refName: "main" },
        }),
        nativeHistory: gated.nativeHistory("t-nativeHistory", "s"),
        mergeBack: gated.mergeBack("t-mergeBack", "child", {
          commandId: "c",
          targetSessionId: SessionId.make("parent"),
          at: { kind: "latestStable" },
        }),
        rollbackSession: gated.rollbackSession("t-rollbackSession", "s", {
          commandId: "c",
          at: {
            checkpointId: CheckpointId.make("cp"),
            boundaryId: TurnBoundaryId.make("boundary"),
          },
          expected: { historyRevision: 0, worktreeEpoch: 0 },
        }),
        forkSession: gated.forkSession("t-forkSession", "s", {
          commandId: "c",
          at: { kind: "latestStable" },
          title: null,
        }),
        listTurns: gated.listTurns("t-listTurns", "s"),
        listItems: gated.listItems("t-listItems", "s", 0, 500),
        listRequests: gated.listRequests("t-listRequests", "s"),
        sessionDetail: gated.sessionDetail("t-sessionDetail", "s"),
        listActiveSessions: gated.listActiveSessions("t-listActiveSessions"),
        endBackgroundWork: gated.endBackgroundWork("t-endBackgroundWork", "s", {
          kind: "task",
          id: "wf",
        }),
        conversationWait: gated.conversationWait("t-conversationWait", "s"),
        workspaceRetirement: gated.workspaceRetirement("t-workspaceRetirement", "s"),
        changeDiff: gated.changeDiff("t-changeDiff", "c"),
        projectBranches: gated.projectBranches("t-projectBranches", "p"),
        refreshProject: gated.refreshProject("t-refreshProject", "p"),
        listWorktrees: gated.listWorktrees("t-listWorktrees", "p"),
        removeWorktree: gated.removeWorktree("t-removeWorktree", "w"),
        removeProject: gated.removeProject("t-removeProject", "p"),
        projectContents: gated.projectContents("t-projectContents", "project", {
          path: "README.md",
          at: null,
        }),
        openProjectRawFile: Effect.scoped(
          gated.openProjectRawFile(Redacted.make("t-openProjectRawFile"), "project", {
            path: Redacted.make("favicon.svg"),
            within: Redacted.make(""),
            method: "HEAD",
          }),
        ),
        projectFiles: gated.projectFiles("t-projectFiles", "p", null),
        listSkills: gated.listSkills("t-listSkills"),
        projectSkills: gated.projectSkills("t-projectSkills", "p"),
        changeStats: gated.changeStats("t-changeStats", "c"),
        changeLandings: gated.changeLandings("t-changeLandings", "c"),
        land: gated.land("t-land", "s", { pullRequest: true }),
        refreshLanding: gated.refreshLanding("t-refreshLanding", "l"),
        worktreeCheckpoints: gated.worktreeCheckpoints("t-worktreeCheckpoints", "w"),
        worktreeContents: gated.worktreeContents("t-worktreeContents", "w", {
          path: "a.ts",
          at: null,
        }),
        openRawFile: Effect.scoped(
          gated.openRawFile(Redacted.make("t-openRawFile"), "w", {
            path: Redacted.make("a.png"),
            within: Redacted.make(""),
            method: "HEAD",
          }),
        ),
        openProofMedia: Effect.scoped(
          gated.openProofMedia(Redacted.make("t-openProofMedia"), ProofArtifactId.make("proof"), {
            method: "HEAD",
          }),
        ),
        pageFrame: gated.pageFrame(Redacted.make("t-pageFrame"), "page"),
        openPage: Effect.scoped(gated.openPage(Redacted.make("t-openPage"), "page")),
        worktreeDiff: gated.worktreeDiff("t-worktreeDiff", "w", {
          from: null,
          to: "c",
          ignoreWhitespace: false,
        }),
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
        openShell: gated.openShell("t-openShell", "s"),
        stopShell: gated.stopShell("t-stopShell", "p"),
        ttyTicket: gated.ttyTicket("t-ttyTicket", "p"),
        submitTurn: gated.submitTurn("t-submitTurn", "s", "hi"),
        launchProtocol: gated.launchProtocol("t-launchProtocol", "s", ""),
        steerTurn: gated.steerTurn("t-steerTurn", "turn", { input: "hi", clientSteerId: "key" }),
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
